const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { Writable } = require("node:stream");
const bcrypt = require("bcryptjs");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { createPasswordHasher, DUMMY_HASH, BCRYPT_ROUNDS } = require("../src/lib/password-hasher");
const { freshAddress } = require("../scripts/fresh-address");

/*
 * Issue #49: login and registration under abuse.
 *   - one uniform failure for unknown / wrong-password / non-disclosable account states, and exactly one
 *     password comparison per attempt (a dummy hash for unknown accounts);
 *   - the per-address guard stops credential stuffing BEFORE any hashing work is done;
 *   - hashing runs in a bounded worker pool: the event loop stays responsive under a burst, excess work is shed
 *     with 503 + Retry-After, and a lost worker is replaced;
 *   - no password, e-mail address, token or address reaches logs or rate-limit keys.
 */

const JWT_SECRET = "password-hardening-secret-long-enough-for-tests";
const PASSWORD = "Correct-Horse-1234";
const config = { nodeEnv: "test", isProduction: false, corsOrigins: [], jwtSecret: JWT_SECRET, jwtExpiresIn: "1h" };
const unique = () => crypto.randomUUID().slice(0, 10);
const SLOW_WORKER = path.join(__dirname, "..", "scripts", "password-worker-stub.js");

/** Wraps a hasher and records every comparison (which hash was compared, never the password). */
function counting(inner) {
  const calls = [];
  return {
    calls,
    rounds: inner.rounds,
    compare: async (password, hash) => { calls.push({ op: "compare", hash }); return inner.compare(password, hash); },
    hash: async (password) => { calls.push({ op: "hash" }); return inner.hash(password); },
    stats: () => inner.stats(),
    close: () => inner.close()
  };
}

async function fixture(t, { hasher = null, logger = false } = {}) {
  const realHasher = createPasswordHasher({ concurrency: 2, maxQueue: 64, maxWaitMs: 15000 });
  const passwordHasher = hasher || counting(realHasher);
  const plan = await prisma.plan.create({ data: { name: `ph-${unique()}`, priceMonthly: 0, storageLimit: 1000n } });
  const hash = await bcrypt.hash(PASSWORD, 4);
  const mk = (name, status = "ACTIVE", role = "USER") => prisma.user.create({
    data: { name, email: `ph-${name.toLowerCase()}-${unique()}@example.com`, password: hash, status, role, planId: plan.id }
  });
  const alice = await mk("Alice");
  const suspended = await mk("Sam", "SUSPENDED");
  const deleted = await mk("Dee", "DELETED");
  const admin = await mk("Adm", "ACTIVE", "ADMIN");
  const ids = [alice.id, suspended.id, deleted.id, admin.id];
  const app = buildApp({ logger, passwordHasher, config });
  await app.ready();
  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.plan.delete({ where: { id: plan.id } });
  });
  const login = (email, password, remoteAddress = freshAddress()) => app.inject({
    method: "POST", url: "/auth/login", remoteAddress, payload: { email, password }
  });
  return { app, plan, alice, suspended, deleted, admin, passwordHasher, login };
}

const shape = (response) => ({
  statusCode: response.statusCode,
  body: response.body,
  contentType: response.headers["content-type"],
  retryAfter: response.headers["retry-after"] ?? null
});

test("unknown, wrong-password and non-disclosable account states are indistinguishable, and each attempt costs one comparison", async (t) => {
  const f = await fixture(t);
  const WRONG = "wrong-Password-9";

  const attempts = {
    unknown: await f.login(`nobody-${unique()}@example.com`, WRONG),
    wrongPassword: await f.login(f.alice.email, WRONG),
    suspendedWrong: await f.login(f.suspended.email, WRONG),
    deletedWrong: await f.login(f.deleted.email, WRONG)
  };
  const reference = shape(attempts.unknown);
  assert.equal(reference.statusCode, 401);
  assert.deepEqual(JSON.parse(reference.body), { message: "Invalid email or password" });
  for (const [name, response] of Object.entries(attempts)) {
    assert.deepEqual(shape(response), reference, `${name} must look exactly like an unknown account`);
  }

  // One comparison per attempt, at the production cost: unknown accounts are compared against the dummy hash.
  assert.equal(f.passwordHasher.calls.length, 4);
  assert.ok(f.passwordHasher.calls.every((call) => call.op === "compare"));
  assert.equal(f.passwordHasher.calls[0].hash, DUMMY_HASH, "an unknown account is compared against the dummy hash");
  assert.equal(Number(DUMMY_HASH.split("$")[2]), BCRYPT_ROUNDS, "the dummy has the production cost");
  assert.notEqual(f.passwordHasher.calls[1].hash, DUMMY_HASH);

  // Only a caller who proved the password learns what state the account is in (they need it to act on it).
  const suspendedOk = await f.login(f.suspended.email, PASSWORD);
  assert.equal(suspendedOk.statusCode, 403);
  assert.equal(suspendedOk.json().message, "Account is suspended");
  const deletedOk = await f.login(f.deleted.email, PASSWORD);
  assert.equal(deletedOk.statusCode, 403);
  assert.equal(deletedOk.json().message, "Account is deleted");
  const ok = await f.login(f.alice.email, PASSWORD);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);
});

test("credential stuffing across many accounts is stopped by the address guard before any hashing happens", async (t) => {
  const f = await fixture(t, { hasher: null });
  const address = freshAddress();
  const codes = [];
  for (let i = 0; i < 126; i += 1) {
    // A fast stand-in would hide the point; the counting wrapper around the real pool proves the property, and
    // the unknown accounts below cost one real comparison each, so keep the burst just over the cap.
    codes.push((await f.login(`stuff-${unique()}-${i}@example.com`, "wrong-Password-9", address)).statusCode);
  }
  assert.equal(codes.filter((code) => code === 401).length, 120, "the first 120 reach the credential check");
  assert.equal(codes.filter((code) => code === 429).length, 6, "the rest are refused");
  assert.equal(f.passwordHasher.calls.length, 120, "refused attempts performed no hashing at all");
});

test("a burst of failed logins cannot monopolise the event loop (documented budget: < 500 ms of loop delay)", async (t) => {
  const f = await fixture(t);
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const responses = await Promise.all(Array.from({ length: 16 }, () => f.login(`burst-${unique()}@example.com`, "wrong-Password-9")));
  histogram.disable();

  assert.ok(responses.every((response) => response.statusCode === 401), responses.map((r) => r.statusCode).join(","));
  const maxMs = histogram.max / 1e6;
  assert.ok(maxMs < 500, `event loop was blocked for ${maxMs.toFixed(0)} ms (in-process bcrypt blocks it for seconds)`);
  const stats = f.passwordHasher.stats();
  assert.equal(stats.completed, 16);
  assert.equal(stats.active, 0);
  assert.equal(stats.queued, 0);
});

test("the hasher sheds load beyond its queue with PASSWORD_VERIFICATION_BUSY and recovers afterwards", async (t) => {
  process.env.TEST_WORKER_DELAY_MS = "300";
  const hasher = createPasswordHasher({ concurrency: 1, maxQueue: 2, maxWaitMs: 5000, workerPath: SLOW_WORKER });
  t.after(() => hasher.close());

  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => hasher.compare("x", "y")));
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 3, "one running + two queued are served");
  assert.equal(rejected.length, 2, "everything beyond the queue is refused");
  for (const r of rejected) {
    assert.equal(r.reason.code, "PASSWORD_VERIFICATION_BUSY");
    assert.equal(r.reason.reason, "queue-full");
    assert.ok(r.reason.retryAfterSeconds >= 1);
  }
  assert.ok(Date.now() - started < 3000);
  assert.equal(hasher.stats().rejectedQueueFull, 2);

  // After the burst the pool serves normally again.
  assert.equal(await hasher.compare("x", "y"), true);

  // A request that waits longer than the budget is refused instead of waiting forever.
  const slowQueue = createPasswordHasher({ concurrency: 1, maxQueue: 5, maxWaitMs: 100, workerPath: SLOW_WORKER });
  t.after(() => slowQueue.close());
  const [first, second] = await Promise.allSettled([slowQueue.compare("x", "y"), slowQueue.compare("x", "y")]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.reason, "wait-timeout");
});

test("a login refused by the hashing budget is a 503 with Retry-After, never a credential failure", async (t) => {
  process.env.TEST_WORKER_DELAY_MS = "300";
  const hasher = createPasswordHasher({ concurrency: 1, maxQueue: 0, maxWaitMs: 5000, workerPath: SLOW_WORKER });
  const f = await fixture(t, { hasher });

  const [running, refused] = await Promise.all([
    f.login(f.alice.email, PASSWORD),
    (async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return f.login(f.alice.email, PASSWORD); })()
  ]);
  assert.equal(running.statusCode, 200, running.body);
  assert.equal(refused.statusCode, 503, refused.body);
  assert.ok(Number(refused.headers["retry-after"]) >= 1);
  assert.deepEqual(refused.json(), { message: "Authentication is busy; retry shortly" });
  assert.equal(await prisma.auditLog.count({ where: { userId: f.alice.id, action: "LOGIN" } }), 1, "the refused attempt is not a login");

  // Registration shares the same budget.
  const busyRegister = await Promise.all([
    f.login(f.alice.email, PASSWORD),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return f.app.inject({
        method: "POST", url: "/auth/register", remoteAddress: freshAddress(),
        payload: { name: "Busy", email: `busy-${unique()}@example.com`, password: PASSWORD }
      });
    })()
  ]);
  assert.equal(busyRegister[1].statusCode, 503, busyRegister[1].body);
  assert.ok(Number(busyRegister[1].headers["retry-after"]) >= 1);
});

test("a lost worker fails only its own task and is replaced", async (t) => {
  process.env.TEST_WORKER_DELAY_MS = "20";
  const hasher = createPasswordHasher({ concurrency: 1, maxQueue: 4, maxWaitMs: 5000, workerPath: SLOW_WORKER });
  t.after(() => hasher.close());

  assert.equal(await hasher.compare("x", "y"), true);
  await assert.rejects(hasher.compare("crash", "y"), (error) => error.code === "PASSWORD_VERIFICATION_BUSY" && error.reason === "worker-lost");
  assert.equal(await hasher.compare("x", "y"), true, "a replacement worker serves the next request");
  assert.equal(hasher.stats().workerFailures, 1);
});

test("the real hasher is bcrypt-compatible: hashes verify, wrong passwords do not, and policy regressions hold", async (t) => {
  const hasher = createPasswordHasher({ concurrency: 2, rounds: 4 });
  t.after(() => hasher.close());
  const hash = await hasher.hash(PASSWORD);
  assert.match(hash, /^\$2[aby]\$04\$/);
  assert.equal(bcrypt.compareSync(PASSWORD, hash), true, "readable by plain bcrypt: no migration is needed");
  assert.equal(await hasher.compare(PASSWORD, hash), true);
  assert.equal(await hasher.compare("another-Password-1", hash), false);
  assert.equal(await hasher.compare(PASSWORD, await bcrypt.hash(PASSWORD, 10)), true, "hashes created by older builds still verify");
  assert.equal(await hasher.compare(PASSWORD, "not-a-hash"), false, "a damaged stored hash is a non-match, not an error");

  const f = await fixture(t);
  const email = `pol-${unique()}@example.com`;
  const register = (password) => f.app.inject({
    method: "POST", url: "/auth/register", remoteAddress: freshAddress(), payload: { name: "Pol", email, password }
  });
  assert.equal((await register("short1A")).statusCode, 400, "too short");
  assert.equal((await register("alllowercase1234")).statusCode, 400, "no uppercase");
  const created = await register(PASSWORD);
  assert.equal(created.statusCode, 201, created.body);
  t.after(async () => {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.auditLog.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
  const stored = await prisma.user.findUnique({ where: { email } });
  assert.match(stored.password, /^\$2[aby]\$12\$/, "registration hashes at the production cost");
  assert.equal((await f.login(email, PASSWORD)).statusCode, 200);
  assert.equal((await f.login(email, "wrong-Password-9")).statusCode, 401);
});

test("no password, e-mail address, token or client address reaches the logs or a rate-limit key", async (t) => {
  const lines = [];
  const stream = new Writable({ write(chunk, encoding, callback) { lines.push(chunk.toString()); callback(); } });
  const f = await fixture(t, { logger: { level: "trace", stream } });

  const secretPassword = `Sup3r-Secret-${unique()}`;
  const probeEmail = `leak-probe-${unique()}@example.com`;
  const address = freshAddress();

  await f.login(probeEmail, secretPassword, address); // unknown account
  await f.login(f.alice.email, secretPassword, address); // wrong password
  const good = await f.login(f.alice.email, PASSWORD, address);
  assert.equal(good.statusCode, 200, good.body);

  const everything = lines.join("\n");
  assert.ok(lines.length > 0, "the logger actually captured something");
  assert.ok(!everything.includes(secretPassword), "no submitted password in logs");
  assert.ok(!everything.includes(PASSWORD), "no valid password in logs");
  assert.ok(!everything.includes(probeEmail) && !everything.includes(f.alice.email), "no e-mail address in logs");
  assert.ok(!everything.includes(good.json().token), "no token in logs");

  const keys = await prisma.$queryRaw`SELECT "key" FROM "RateLimitWindow" WHERE "key" LIKE 'login%'`;
  assert.ok(keys.length >= 3, "the login limiters recorded the attempts");
  for (const { key } of keys) {
    assert.ok(!key.includes(probeEmail) && !key.includes(f.alice.email) && !key.includes(address), `key ${key} must be a digest`);
  }
});

test("the admin-only /metrics endpoint reports hashing counters and gauges, nothing identifying", async (t) => {
  const f = await fixture(t);
  await f.login(`m-${unique()}@example.com`, "wrong-Password-9");
  const admin = await f.app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${f.app.jwt.sign({ id: f.admin.id, av: 0 })}` } });
  assert.equal(admin.statusCode, 200, admin.body);
  const hashing = admin.json().metrics.passwordHashing;
  assert.equal(hashing.concurrency, 2);
  assert.equal(hashing.maxQueue, 64);
  assert.ok(hashing.completed >= 1);
  for (const field of ["active", "queued", "rejectedQueueFull", "rejectedWaitTimeout", "workerFailures"]) {
    assert.equal(typeof hashing[field], "number", field);
  }
  assert.ok(!admin.body.includes("@example.com"));
});
