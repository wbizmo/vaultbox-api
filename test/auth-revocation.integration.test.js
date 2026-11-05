const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const bcrypt = require("bcryptjs");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const cache = require("../src/lib/cache");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { setAccountRole, revokeSessions, tokenVersion } = require("../src/lib/account");

const JWT_SECRET = "auth-revocation-test-secret-long-enough-for-tests";
const PASSWORD = "Correct-Horse-9";
const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: JWT_SECRET,
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 1024,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  uploadCompletionLeaseSeconds: 30,
  uploadReservationLeaseSeconds: 30,
  idempotencyLockTimeoutMs: 400,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

async function fixture(t, { withWorker = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-authrev-"));
  const plan = await prisma.plan.create({
    data: { name: `authrev-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 1000n }
  });
  const hash = await bcrypt.hash(PASSWORD, 4);
  const mk = (name, role = "USER") => prisma.user.create({
    data: { name, email: `authrev-${crypto.randomUUID()}@example.com`, password: hash, role, planId: plan.id }
  });
  const [alice, admin] = [await mk("Alice"), await mk("Admin", "ADMIN")];
  const ids = [alice.id, admin.id];

  const app = buildApp({ config, storage: new LocalStorageAdapter(root), logger: false });
  await app.ready();

  let port = null;
  let worker = null;
  if (withWorker) {
    worker = fork(path.join(__dirname, "..", "scripts", "app-worker.js"), [], {
      env: { ...process.env, JWT_SECRET },
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    ({ port } = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker did not start")), 20_000);
      worker.once("message", (message) => { clearTimeout(timer); resolve(message); });
    }));
  }

  t.after(async () => {
    if (worker && worker.exitCode === null) worker.kill("SIGKILL");
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });

  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const login = async (user, target = "A") => {
    if (target === "A") {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: user.email, password: PASSWORD } });
      assert.equal(res.statusCode, 200, res.body);
      return res.json().token;
    }
    const res = await viaB("/auth/login", null, { method: "POST", body: { email: user.email, password: PASSWORD } });
    assert.equal(res.status, 200, res.body);
    return res.json.token;
  };
  // Instance B: a separate OS process running the real application.
  const viaB = async (url, token, { method = "GET", body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { ...(token ? bearer(token) : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, statusCode: res.status, json, body: text };
  };
  const viaA = (url, token, options = {}) => app.inject({ url, headers: token ? bearer(token) : {}, ...options });
  // Minted directly (no bcrypt) so tests that gate bcrypt.compare can still act as the admin.
  const adminToken = async () => app.jwt.sign({ id: admin.id, av: (await prisma.user.findUnique({ where: { id: admin.id } })).authVersion });
  const suspend = async (user) => {
    const res = await viaA(`/admin/users/${user.id}/suspend`, await adminToken(), { method: "PATCH" });
    assert.equal(res.statusCode, 200, res.body);
  };
  const reactivate = async (user) => {
    const res = await viaA(`/admin/users/${user.id}/reactivate`, await adminToken(), { method: "PATCH" });
    assert.equal(res.statusCode, 200, res.body);
  };
  const version = async (user) => (await prisma.user.findUnique({ where: { id: user.id } })).authVersion;

  return { app, alice, admin, login, viaA, viaB, suspend, reactivate, version, bearer };
}

test("a suspension is enforced on the very next request on another process (no cache window)", async (t) => {
  const f = await fixture(t, { withWorker: true });
  const token = await f.login(f.alice);

  assert.equal((await f.viaB("/me", token)).status, 200, "the token works on instance B before suspension");
  assert.equal((await f.viaA("/me", token)).statusCode, 200);

  await f.suspend(f.alice);
  // Immediately, with no waiting: the old design served a cached ACTIVE entry for up to 10 seconds.
  const onB = await f.viaB("/me", token);
  assert.equal(onB.status, 403, onB.body);
  assert.equal(onB.json.message, "Account is suspended");
  assert.equal((await f.viaA("/me", token)).statusCode, 403);
});

test("reactivation does not revive tokens issued before the suspension; a fresh login works everywhere", async (t) => {
  const f = await fixture(t, { withWorker: true });
  const oldToken = await f.login(f.alice);
  await f.suspend(f.alice);
  await f.reactivate(f.alice);

  for (const probe of [() => f.viaA("/me", oldToken), () => f.viaB("/me", oldToken)]) {
    const res = await probe();
    assert.equal(res.statusCode, 401, res.body);
    assert.match(res.body, /no longer valid/);
    assert.ok(!/authVersion|email|password/i.test(res.body.replace(/no longer valid; please sign in again/, "")), "no internals leak");
  }

  const fresh = await f.login(f.alice, "B");
  assert.equal((await f.viaB("/me", fresh)).status, 200);
  assert.equal((await f.viaA("/me", fresh)).statusCode, 200);
});

test("admin demotion is enforced on the next request on another process", async (t) => {
  const f = await fixture(t, { withWorker: true });
  const token = await f.login(f.admin);

  assert.equal((await f.viaB("/admin/storage-report", token)).status, 200);
  assert.equal((await f.viaA("/admin/storage-report", token)).statusCode, 200);

  await setAccountRole(f.admin.id, "USER");
  const onB = await f.viaB("/admin/storage-report", token);
  assert.equal(onB.status, 401, "the demoted account's session is revoked");
  assert.equal((await f.viaA("/admin/storage-report", token)).statusCode, 401);

  const relogin = await f.login(f.admin, "B");
  const asUser = await f.viaB("/admin/storage-report", relogin);
  assert.equal(asUser.status, 403, "a fresh session carries the lower privilege");
  assert.equal((await f.viaB("/me", relogin)).json.user.role, "USER");
});

test("a login racing a suspension can never leave a reusable credential", async (t) => {
  const f = await fixture(t);

  // Pause the login after it has read the (still ACTIVE) account, during password verification.
  const original = bcrypt.compare;
  let enteredCompare;
  const reached = new Promise((resolve) => { enteredCompare = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  bcrypt.compare = async (...args) => {
    enteredCompare();
    await gate;
    return original(...args);
  };
  t.after(() => { bcrypt.compare = original; });

  const racing = f.app.inject({ method: "POST", url: "/auth/login", payload: { email: f.alice.email, password: PASSWORD } });
  await reached;

  await f.suspend(f.alice);
  await f.reactivate(f.alice); // even if the account is ACTIVE again by the time the login finishes
  release();

  const response = await racing;
  assert.equal(response.statusCode, 200, "the login itself saw an ACTIVE account when it started");
  const staleToken = response.json().token;
  assert.equal(tokenVersion(f.app.jwt.decode(staleToken)), 0);
  assert.equal(await f.version(f.alice), 2);

  const use = await f.viaA("/me", staleToken);
  assert.equal(use.statusCode, 401, "the credential minted by the racing login is already revoked");
  assert.equal((await f.viaA("/files", staleToken)).statusCode, 401);

  // Variant: suspended (not reactivated) when the login completes.
  bcrypt.compare = original;
  let enteredAgain;
  const reachedAgain = new Promise((resolve) => { enteredAgain = resolve; });
  let releaseAgain;
  const gateAgain = new Promise((resolve) => { releaseAgain = resolve; });
  bcrypt.compare = async (...args) => { enteredAgain(); await gateAgain; return original(...args); };
  const racing2 = f.app.inject({ method: "POST", url: "/auth/login", payload: { email: f.alice.email, password: PASSWORD } });
  await reachedAgain;
  await f.suspend(f.alice);
  releaseAgain();
  const second = await racing2;
  assert.equal((await f.viaA("/me", second.json().token)).statusCode, 403);
});

test("Redis (or its cache helpers) failing cannot preserve or block access: authentication never touches the cache", async (t) => {
  const f = await fixture(t);
  const saved = { getJson: cache.getJson, setJson: cache.setJson, del: cache.del };
  const boom = async () => { throw new Error("cache must not be used for authentication"); };
  cache.getJson = boom;
  cache.setJson = boom;
  cache.del = boom;
  t.after(() => Object.assign(cache, saved));

  const token = await f.login(f.alice);
  assert.equal((await f.viaA("/me", token)).statusCode, 200);
  await f.suspend(f.alice);
  assert.equal((await f.viaA("/me", token)).statusCode, 403);
});

test("existing token and status contracts are unchanged", async (t) => {
  const f = await fixture(t);

  // Tokens issued before versioning carry no claim and keep working for an account never revoked.
  const legacy = f.app.jwt.sign({ id: f.alice.id });
  assert.equal(tokenVersion(f.app.jwt.decode(legacy)), 0);
  assert.equal((await f.viaA("/me", legacy)).statusCode, 200);

  // But not once the account has been revoked, and a claim ahead of the account's version is no good either.
  const ahead = f.app.jwt.sign({ id: f.alice.id, av: 7 });
  assert.equal((await f.viaA("/me", ahead)).statusCode, 401);
  await revokeSessions(f.alice.id);
  assert.equal((await f.viaA("/me", legacy)).statusCode, 401);

  // Expiry, garbage and unknown accounts.
  const expired = f.app.jwt.sign({ id: f.admin.id }, { expiresIn: "1ms" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await f.viaA("/me", expired)).statusCode, 401);
  assert.equal((await f.viaA("/me", "not-a-jwt")).statusCode, 401);
  assert.equal((await f.viaA("/me", f.app.jwt.sign({ id: "no-such-user" }))).statusCode, 401);

  // Statuses.
  const adminTok = await f.login(f.admin);
  const deleted = await viaDelete(f, adminTok, f.alice);
  assert.equal(deleted.statusCode, 200, deleted.body);
  const afterDelete = await f.viaA("/me", f.app.jwt.sign({ id: f.alice.id, av: await f.version(f.alice) }));
  assert.equal(afterDelete.statusCode, 403);
  assert.equal(afterDelete.json().message, "Account is deleted");
  assert.equal((await f.viaA("/admin/users", adminTok)).statusCode, 200);
});

function viaDelete(f, adminTok, user) {
  return f.viaA(`/admin/users/${user.id}`, adminTok, { method: "DELETE" });
}

test("the simulated failed-payment suspension also revokes old sessions", async (t) => {
  const f = await fixture(t);
  const token = await f.login(f.alice);
  const failed = await f.viaA("/billing/simulate-failed-payment", token, { method: "POST" });
  assert.equal(failed.statusCode, 200, failed.body);
  assert.equal((await f.viaA("/me", token)).statusCode, 403);
  await f.reactivate(f.alice);
  assert.equal((await f.viaA("/me", token)).statusCode, 401, "the pre-suspension token is dead after reactivation");
});

test("status/role changes bump the session version atomically and registration issues a versioned token", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.version(f.alice), 0);
  await f.suspend(f.alice);
  assert.equal(await f.version(f.alice), 1);
  await f.reactivate(f.alice);
  assert.equal(await f.version(f.alice), 2);
  await setAccountRole(f.alice.id, "ADMIN");
  assert.equal(await f.version(f.alice), 3);
  assert.equal((await prisma.user.findUnique({ where: { id: f.alice.id } })).role, "ADMIN");

  const email = `authrev-reg-${crypto.randomUUID()}@example.com`;
  const registered = await f.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "New", email, password: PASSWORD }
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const created = await prisma.user.findUnique({ where: { email } });
  t.after(async () => {
    await prisma.auditLog.deleteMany({ where: { userId: created.id } });
    await prisma.user.delete({ where: { id: created.id } });
  });
  assert.equal(tokenVersion(f.app.jwt.decode(registered.json().token)), created.authVersion);
  assert.equal((await f.viaA("/me", registered.json().token)).statusCode, 200);
});

test("a database failure during authentication is a 503, never a 401, and bad tokens never reach the database", async (t) => {
  const f = await fixture(t);
  const token = await f.login(f.alice);

  const original = prisma.user.findUnique;
  let lookups = 0;
  prisma.user.findUnique = async () => {
    lookups += 1;
    throw new Error("connection terminated unexpectedly");
  };
  t.after(() => { prisma.user.findUnique = original; });

  const outage = await f.viaA("/me", token);
  assert.equal(outage.statusCode, 503, outage.body);
  assert.equal(outage.json().error.code, "AUTH_UNAVAILABLE");
  assert.ok(!/connection terminated/.test(outage.body), "internal error text is not exposed");
  assert.equal(lookups, 1);

  // Token problems are still 401 and do not touch the database.
  lookups = 0;
  assert.equal((await f.viaA("/me", "not-a-jwt")).statusCode, 401);
  assert.equal((await f.viaA("/me")).statusCode, 401);
  assert.equal(lookups, 0);

  prisma.user.findUnique = original;
  assert.equal((await f.viaA("/me", token)).statusCode, 200, "service resumes when the database does");
});
