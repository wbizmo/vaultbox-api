const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { redis, disconnectRedis } = require("../src/lib/redis");
const { checkThrottle, getThrottleState, pruneExpiredRateLimitWindows } = require("../src/lib/throttle");

/*
 * Issue #46. Policy under test (see src/lib/throttle.js):
 *   healthy            -> one atomic Redis round trip, global across replicas
 *   Redis down, shared -> PostgreSQL fixed-window counter (still global); fail closed if that fails too
 *   Redis down, local  -> bounded per-process window (documented degraded mode)
 *   Redis back         -> abuse-sensitive routes stay on the shared counter for the rest of the window
 */

const JWT_SECRET = "throttle-degraded-secret-long-enough-for-tests";
const unique = () => crypto.randomUUID().slice(0, 12);
const { freshAddress } = require("../scripts/fresh-address");

function startWorker(t, env) {
  const worker = fork(path.join(__dirname, "..", "scripts", "app-worker.js"), [], {
    env: { ...process.env, JWT_SECRET, WORKER_TRUST_PROXY: "loopback", ...env },
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start")), 20_000);
    worker.once("message", (message) => { clearTimeout(timer); resolve(message.port); });
  });
}

// `client` is the end-user address the (trusted, loopback) proxy reports; one fixed address per test keeps
// the two instances counting the same identity while separate runs never share a counter.
const login = (port, email, client) => fetch(`http://127.0.0.1:${port}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": client },
  body: JSON.stringify({ email, password: "irrelevant-Password-1" })
});

/** A controllable Redis: `state.ready` toggles readiness, `state.evalFails` makes commands fail. */
function controlRedis(t, state = { ready: true, evalFails: false }) {
  const originalEval = redis.eval.bind(redis);
  state.evalCalls = 0;
  Object.defineProperty(redis, "isReady", { configurable: true, get: () => state.ready });
  redis.eval = async (script, options) => {
    state.evalCalls += 1;
    if (state.evalFails) throw new Error("simulated Redis failure");
    const key = options.keys[0];
    state.counters ||= new Map();
    const count = (state.counters.get(key) || 0) + 1;
    state.counters.set(key, count);
    return [count, Number(options.arguments[0])];
  };
  t.after(() => {
    redis.eval = originalEval;
    delete redis.isReady; // back to the client's own getter
  });
  return state;
}

test("healthy Redis: two separate instances share one limit instead of multiplying it", async (t) => {
  const ports = await Promise.all([
    startWorker(t, { WORKER_CONNECT_REDIS: "1" }),
    startWorker(t, { WORKER_CONNECT_REDIS: "1" })
  ]);
  const email = `healthy-${unique()}@example.com`;
  const client = freshAddress();

  const statuses = [];
  for (let i = 0; i < 14; i += 1) {
    const response = await login(ports[i % 2], email, client);
    statuses.push(response.status);
    if (response.status === 429) assert.ok(Number(response.headers.get("retry-after")) > 0);
  }
  // Limit 10 per (ip, email) per window: exactly 10 reach the credential check (401), 4 are throttled.
  assert.equal(statuses.filter((status) => status === 401).length, 10, statuses.join(","));
  assert.equal(statuses.filter((status) => status === 429).length, 4, statuses.join(","));
});

test("Redis unavailable on both instances: the sensitive limit is still global (PostgreSQL), and no identity is stored", async (t) => {
  const ports = await Promise.all([
    startWorker(t, { REDIS_URL: "" }),
    startWorker(t, { REDIS_URL: "" })
  ]);
  const email = `noredis-${unique()}@example.com`;
  const client = freshAddress();

  const statuses = [];
  for (let i = 0; i < 14; i += 1) statuses.push((await login(ports[i % 2], email, client)).status);
  assert.equal(statuses.filter((status) => status === 401).length, 10, statuses.join(","));
  assert.equal(statuses.filter((status) => status === 429).length, 4, statuses.join(","));

  const rows = await prisma.$queryRaw`SELECT "key", "count" FROM "RateLimitWindow" WHERE "key" LIKE 'login:%' OR "key" LIKE 'login-account:%'`;
  assert.ok(rows.length >= 1);
  for (const row of rows) assert.ok(!String(row.key).includes(email) && !String(row.key).includes(client), "keys are hashed");
  await prisma.$executeRaw`DELETE FROM "RateLimitWindow" WHERE "key" LIKE 'login%'`;
});

test("fail closed: when Redis AND the shared store are unavailable, sensitive routes refuse (503) rather than trusting a per-process counter", async (t) => {
  controlRedis(t, { ready: false, evalFails: false });
  const original = prisma.$queryRaw;
  prisma.$queryRaw = async () => { throw new Error("database unavailable"); };
  t.after(() => { prisma.$queryRaw = original; });

  const shared = await checkThrottle(`closed-${unique()}`, "x", { limit: 5, windowSeconds: 30, policy: "shared" });
  assert.equal(shared.allowed, false);
  assert.equal(shared.unavailable, true);

  // Non-sensitive routes keep the documented bounded local fallback.
  const local = await checkThrottle(`local-${unique()}`, "x", { limit: 5, windowSeconds: 30, policy: "local" });
  assert.equal(local.allowed, true);
  assert.ok(getThrottleState().failedClosed >= 1);

  // End to end through a route: refusal is 503 + Retry-After, not a login attempt and not a 500.
  const app = buildApp({ logger: false, config: { nodeEnv: "test", isProduction: false, corsOrigins: [], jwtSecret: JWT_SECRET, jwtExpiresIn: "1h" } });
  await app.ready();
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `x-${unique()}@example.com`, password: "irrelevant-Password-1" } });
  assert.equal(response.statusCode, 503, response.body);
  assert.ok(Number(response.headers["retry-after"]) > 0);
  assert.doesNotMatch(response.body, /database/i);
});

test("reconnect does not reset protections: attempts counted during the outage still count after Redis returns", async (t) => {
  const redisState = controlRedis(t, { ready: false, evalFails: false });
  const namespace = `hold-${unique()}`;
  const options = { limit: 3, windowSeconds: 2, policy: "shared" };

  for (let i = 0; i < 3; i += 1) assert.equal((await checkThrottle(namespace, "attacker", options)).allowed, true);
  assert.equal((await checkThrottle(namespace, "attacker", options)).allowed, false, "limit reached during the outage");

  // Redis comes back with empty counters. A naive switch would hand the attacker a fresh budget.
  redisState.ready = true;
  const after = await checkThrottle(namespace, "attacker", options);
  assert.equal(after.allowed, false, "still limited after reconnect");
  assert.equal(redisState.evalCalls, 0, "decision came from the shared store, not the empty Redis counter");
  assert.ok(getThrottleState().holdDownNamespaces.includes(namespace));

  // Once the window in which Redis failed has passed, the hold-down ends and Redis is used again.
  await new Promise((resolve) => setTimeout(resolve, 2300));
  const recovered = await checkThrottle(namespace, "attacker", options);
  assert.equal(recovered.allowed, true);
  assert.equal(redisState.evalCalls, 1);
  assert.ok(!getThrottleState().holdDownNamespaces.includes(namespace));
});

test("a Redis command failure degrades the same way (sensitive: shared store; local-policy: bounded local window)", async (t) => {
  const redisState = controlRedis(t, { ready: true, evalFails: true });
  const sensitive = `fail-shared-${unique()}`;
  const options = { limit: 2, windowSeconds: 30, policy: "shared" };
  assert.equal((await checkThrottle(sensitive, "a", options)).allowed, true);
  assert.equal((await checkThrottle(sensitive, "a", options)).allowed, true);
  const denied = await checkThrottle(sensitive, "a", options);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 1 && denied.retryAfterSeconds <= 30);

  const local = `fail-local-${unique()}`;
  assert.equal((await checkThrottle(local, "a", { limit: 1, windowSeconds: 30 })).allowed, true);
  assert.equal((await checkThrottle(local, "a", { limit: 1, windowSeconds: 30 })).allowed, false);
  assert.ok(redisState.evalCalls >= 2);
  assert.equal(getThrottleState().mode, "degraded");
});

test("healthy path is unchanged: one Redis round trip per decision and no database access", async (t) => {
  const redisState = controlRedis(t, { ready: true, evalFails: false });
  const original = prisma.$queryRaw;
  let databaseCalls = 0;
  prisma.$queryRaw = async (...args) => { databaseCalls += 1; return original.apply(prisma, args); };
  t.after(() => { prisma.$queryRaw = original; });

  const namespace = `healthy-unit-${unique()}`;
  for (let i = 0; i < 4; i += 1) await checkThrottle(namespace, "c", { limit: 3, windowSeconds: 30, policy: "shared" });
  assert.equal(redisState.evalCalls, 4);
  assert.equal(databaseCalls, 0);
});

test("shared counter: concurrent callers admit exactly `limit`, windows roll over, expired rows are pruned in bounded batches", async (t) => {
  controlRedis(t, { ready: false, evalFails: false });
  const namespace = `shared-${unique()}`;
  const options = { limit: 10, windowSeconds: 1, policy: "shared" };

  const results = await Promise.all(Array.from({ length: 40 }, () => checkThrottle(namespace, "burst", options)));
  assert.equal(results.filter((result) => result.allowed).length, 10);
  for (const result of results) assert.ok(result.retryAfterSeconds >= 1 && result.retryAfterSeconds <= 1);

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await checkThrottle(namespace, "burst", options)).allowed, true, "a new window starts at 1");

  await new Promise((resolve) => setTimeout(resolve, 1200));
  await prisma.$executeRaw`UPDATE "RateLimitWindow" SET "expiresAt" = NOW() - INTERVAL '10 minutes' WHERE "key" LIKE ${`${namespace}:%`}`;
  await pruneExpiredRateLimitWindows(prisma, 500);
  const [{ n }] = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "RateLimitWindow" WHERE "key" LIKE ${`${namespace}:%`}`;
  assert.equal(n, 0);
});

test("login has independent global caps: one account from many addresses, and one address across many accounts", async (t) => {
  // This test is about the limits, not about hashing: a stand-in hasher keeps 160 failed logins fast
  // (real cost-12 comparisons would take ~30 s of CPU here).
  const passwordHasher = { compare: async () => false, hash: async () => "x", stats: () => ({}) };
  const app = buildApp({ logger: false, passwordHasher, config: { nodeEnv: "test", isProduction: false, corsOrigins: [], jwtSecret: JWT_SECRET, jwtExpiresIn: "1h" } });
  await app.ready();
  t.after(() => app.close());
  const attempt = (email, remoteAddress) => app.inject({
    method: "POST", url: "/auth/login", remoteAddress, payload: { email, password: "irrelevant-Password-1" }
  });

  // 35 attempts on ONE account, each from a different address: every (ip, email) pair is used once,
  // yet the account-wide cap (30 per window) stops the guessing.
  const victim = `victim-${unique()}@example.com`;
  const byAccount = [];
  for (let i = 0; i < 35; i += 1) byAccount.push((await attempt(victim, `10.20.${Math.floor(i / 250)}.${(i % 250) + 1}`)).statusCode);
  assert.equal(byAccount.filter((code) => code === 401).length, 30, byAccount.join(","));
  assert.equal(byAccount.filter((code) => code === 429).length, 5, byAccount.join(","));

  // 125 different accounts from ONE address: each (ip, email) pair is used once, yet the address cap
  // (120 per window) stops the spraying.
  const sprayer = `10.30.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200) + 1}`;
  const bySpray = [];
  for (let i = 0; i < 125; i += 1) bySpray.push((await attempt(`spray-${unique()}-${i}@example.com`, sprayer)).statusCode);
  assert.equal(bySpray.filter((code) => code === 401).length, 120, bySpray.join(","));
  assert.equal(bySpray.filter((code) => code === 429).length, 5, bySpray.join(","));
  await prisma.$executeRaw`DELETE FROM "RateLimitWindow" WHERE "key" LIKE 'login%'`;
});

test("limiter diagnostics: the admin-only /metrics endpoint reports the mode, with no identities", async (t) => {
  const state = controlRedis(t, { ready: false, evalFails: false });
  await checkThrottle(`metrics-${unique()}`, "someone@example.com", { limit: 5, windowSeconds: 30, policy: "shared" });

  const plan = await prisma.plan.create({ data: { name: `diag-${unique()}`, priceMonthly: 0, storageLimit: 1000n } });
  const admin = await prisma.user.create({
    data: { name: "Diag", email: `diag-${unique()}@example.com`, password: "x", role: "ADMIN", planId: plan.id }
  });
  const user = await prisma.user.create({
    data: { name: "Diag2", email: `diag2-${unique()}@example.com`, password: "x", planId: plan.id }
  });
  const app = buildApp({ logger: false, config: { nodeEnv: "test", isProduction: false, corsOrigins: [], jwtSecret: JWT_SECRET, jwtExpiresIn: "1h" } });
  await app.ready();
  t.after(async () => {
    await app.close();
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, user.id] } } });
    await prisma.plan.delete({ where: { id: plan.id } });
  });

  const asAdmin = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${app.jwt.sign({ id: admin.id, av: 0 })}` } });
  assert.equal(asAdmin.statusCode, 200, asAdmin.body);
  const limiter = asAdmin.json().metrics.rateLimiter;
  assert.equal(limiter.mode, "degraded");
  assert.equal(limiter.redisReady, false);
  assert.ok(limiter.sharedFallbackDecisions >= 1);
  assert.ok(!asAdmin.body.includes("someone@example.com"), "no identities in diagnostics");

  const asUser = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${app.jwt.sign({ id: user.id, av: 0 })}` } });
  assert.equal(asUser.statusCode, 403);
  assert.ok(!asUser.body.includes("rateLimiter"));
  state.ready = true;
});

test.after(async () => { await disconnectRedis().catch(() => {}); });
