const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const {
  runIdempotent,
  validateIdempotencyKey,
  pruneExpiredIdempotencyKeys,
  fingerprint,
  createGate,
  MAX_CONCURRENT,
  gate: sharedGate
} = require("../src/lib/idempotency");

const JWT_SECRET = "idempotency-test-secret-long-enough-for-tests";
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

async function fixture(t, userCount = 2, configOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-idem-"));
  const plan = await prisma.plan.create({
    data: { name: `idem-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 1000n }
  });
  const users = [];
  for (let i = 0; i < userCount; i += 1) {
    users.push(await prisma.user.create({
      data: { name: `Idem ${i}`, email: `idem-${crypto.randomUUID()}@example.com`, password: "x", planId: plan.id }
    }));
  }
  const app = buildApp({ config: { ...config, ...configOverrides }, storage: new LocalStorageAdapter(root), logger: false });
  await app.ready();
  const ids = users.map((user) => user.id);
  const auth = (user) => ({ authorization: `Bearer ${app.jwt.sign({ id: user.id })}` });

  t.after(async () => {
    await app.close();
    await prisma.idempotencyKey.deleteMany({ where: { userId: { in: ids } } });
    await prisma.folder.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });

  const create = (user, name, key, target = app) => target.inject({
    method: "POST",
    url: "/folders",
    headers: { ...auth(user), ...(key === undefined ? {} : { "idempotency-key": key }) },
    payload: { name }
  });
  const folders = (user) => prisma.folder.findMany({ where: { userId: user.id } });

  return { app, users, ids, auth, create, folders, plan };
}

test("identical keys from two users never interfere and each user replays only their own result", async (t) => {
  const f = await fixture(t);
  const [alice, bob] = f.users;
  const key = "shared-common-key";

  const a1 = await f.create(alice, "alice-docs", key);
  const b1 = await f.create(bob, "bob-docs", key);
  assert.equal(a1.statusCode, 201, a1.body);
  assert.equal(b1.statusCode, 201, b1.body);
  assert.notEqual(a1.json().folder.id, b1.json().folder.id);

  const a2 = await f.create(alice, "alice-docs", key);
  const b2 = await f.create(bob, "bob-docs", key);
  assert.equal(a2.json().folder.id, a1.json().folder.id);
  assert.equal(b2.json().folder.id, b1.json().folder.id);
  assert.equal(a2.headers["idempotent-replay"], "true");
  assert.equal(b2.headers["idempotent-replay"], "true");

  // Bob cannot learn about or collide with Alice's different payload under the same key.
  const bobOther = await f.create(bob, "alice-docs", key);
  assert.equal(bobOther.statusCode, 422, "payload mismatch is judged against Bob's own record only");
  assert.equal((await f.folders(alice)).length, 1);
  assert.equal((await f.folders(bob)).length, 1);
});

test("same user, same key and payload replays the original result without creating anything", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const first = await f.create(user, "once", "key-1");
  const second = await f.create(user, "once", "key-1");
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.deepEqual(second.json(), first.json(), "the replay is byte-for-byte the original response body");
  assert.equal(first.headers["idempotent-replay"], undefined);
  assert.equal(second.headers["idempotent-replay"], "true");
  assert.equal((await f.folders(user)).length, 1);

  // Same key, different operation payload -> 422 and nothing new.
  const mismatch = await f.create(user, "different", "key-1");
  assert.equal(mismatch.statusCode, 422, mismatch.body);
  assert.equal((await f.folders(user)).length, 1);

  // Different key creates a distinct folder; no key is never deduplicated.
  assert.equal((await f.create(user, "once", "key-2")).statusCode, 201);
  assert.equal((await f.create(user, "once")).statusCode, 201);
  assert.equal((await f.create(user, "once")).statusCode, 201);
  assert.equal((await f.folders(user)).length, 4);
});

test("100 parallel identical retries across two separate processes produce exactly one folder", async (t) => {
  // The production-default duplicate wait: the fixture's 400 ms default exists to exercise the 409 path
  // and would legitimately answer "retry shortly" for queued duplicates when the machine is saturated.
  const f = await fixture(t, 1, { idempotencyLockTimeoutMs: 5000 });
  const [user] = f.users;

  const worker = fork(path.join(__dirname, "..", "scripts", "app-worker.js"), [], {
    env: { ...process.env, JWT_SECRET },
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  const { port } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start")), 20_000);
    worker.once("message", (message) => { clearTimeout(timer); resolve(message); });
  });

  const key = `retry-storm-${crypto.randomUUID()}`;
  const viaHttp = () => fetch(`http://127.0.0.1:${port}/folders`, {
    method: "POST",
    headers: { ...f.auth(user), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ name: "storm" })
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
  const viaInject = () => f.create(user, "storm", key).then((res) => ({ status: res.statusCode, json: res.json() }));

  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? viaHttp() : viaInject()))
  );

  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.filter((r) => r.status !== 201).slice(0, 3)));
  assert.equal(new Set(results.map((r) => r.json.folder.id)).size, 1, "every retry observes the same folder id");
  assert.equal((await f.folders(user)).length, 1, "exactly one folder exists");
  assert.equal(await prisma.idempotencyKey.count({ where: { userId: user.id } }), 1);
});

test("a result committed before the response was lost is replayed on retry (original folder id)", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const key = "lost-response";

  // The mutation commits atomically with its record; whatever happens to the response afterwards
  // (Redis, network, process death) cannot undo or duplicate it. Simulate by discarding the result.
  const committed = await runIdempotent({
    userId: user.id,
    operation: "folder.create",
    key,
    payload: { name: "kept" },
    execute: async (tx) => ({
      status: 201,
      body: { message: "Folder created successfully", folder: await tx.folder.create({ data: { name: "kept", userId: user.id } }) }
    })
  });
  const originalId = committed.body.folder.id;

  const retry = await f.create(user, "kept", key);
  assert.equal(retry.statusCode, 201, retry.body);
  assert.equal(retry.json().folder.id, originalId);
  assert.equal((await f.folders(user)).length, 1);
});

test("a failed operation rolls back its claim so the same key can be retried", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  await assert.rejects(runIdempotent({
    userId: user.id,
    operation: "folder.create",
    key: "flaky",
    payload: { name: "x" },
    execute: async (tx) => {
      await tx.folder.create({ data: { name: "x", userId: user.id } });
      throw new Error("boom after the insert");
    }
  }), /boom/);
  assert.equal((await f.folders(user)).length, 0, "the half-done folder rolled back");
  assert.equal(await prisma.idempotencyKey.count({ where: { userId: user.id } }), 0, "and so did the claim");

  const retried = await f.create(user, "x", "flaky");
  assert.equal(retried.statusCode, 201);
  assert.equal((await f.folders(user)).length, 1);
});

test("an expired record is reclaimed exactly once; a stale earlier result can never overwrite the new claim", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const key = "expiring";
  const first = await f.create(user, "gen-1", key);
  assert.equal(first.statusCode, 201);

  await prisma.idempotencyKey.updateMany({ where: { userId: user.id, key }, data: { expiresAt: new Date(Date.now() - 1000) } });

  // Ten parallel requests with a different payload race to reclaim the expired key: one wins.
  const race = await Promise.all(Array.from({ length: 10 }, () => f.create(user, "gen-2", key)));
  assert.ok(race.every((r) => r.statusCode === 201), race.map((r) => r.statusCode).join());
  assert.equal(new Set(race.map((r) => r.json().folder.id)).size, 1);
  assert.equal((await f.folders(user)).filter((folder) => folder.name === "gen-2").length, 1);

  const row = await prisma.idempotencyKey.findFirst({ where: { userId: user.id, key } });
  assert.equal(row.fingerprint, fingerprint({ name: "gen-2" }), "the record belongs to the newer claim");
  assert.equal(row.response.folder.name, "gen-2");

  // The original (expired) request body is a mismatch now, not a resurrected replay.
  const old = await f.create(user, "gen-1", key);
  assert.equal(old.statusCode, 422);
});

test("an in-flight identical request is waited for and replayed; if it takes too long the caller gets 409 + Retry-After", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const key = "in-flight";

  // A competing request holds the claim (uncommitted) for a while.
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let claimed;
  const claimedSignal = new Promise((resolve) => { claimed = resolve; });
  const owner = runIdempotent({
    userId: user.id,
    operation: "folder.create",
    key,
    payload: { name: "slow" },
    execute: async (tx) => {
      const folder = await tx.folder.create({ data: { name: "slow", userId: user.id } });
      claimed();
      await hold;
      return { status: 201, body: { message: "Folder created successfully", folder } };
    }
  });
  await claimedSignal;

  // Shorter than the owner's hold: documented 409 with Retry-After (lock timeout is 400 ms here).
  const timedOut = await f.create(user, "slow", key);
  assert.equal(timedOut.statusCode, 409, timedOut.body);
  assert.equal(timedOut.headers["retry-after"], "1");

  // Once the owner commits, a retry replays the original result.
  release();
  const done = await owner;
  const retry = await f.create(user, "slow", key);
  assert.equal(retry.statusCode, 201);
  assert.equal(retry.json().folder.id, done.body.folder.id);
  assert.equal(retry.headers["idempotent-replay"], "true");
  assert.equal((await f.folders(user)).length, 1);
});

test("an in-flight identical request that finishes within the wait is replayed, not rejected", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const key = "short-wait";
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let claimed;
  const claimedSignal = new Promise((resolve) => { claimed = resolve; });
  const owner = runIdempotent({
    userId: user.id, operation: "folder.create", key, payload: { name: "brief" },
    execute: async (tx) => {
      const folder = await tx.folder.create({ data: { name: "brief", userId: user.id } });
      claimed();
      await hold;
      return { status: 201, body: { message: "Folder created successfully", folder } };
    }
  });
  await claimedSignal;
  const waiting = f.create(user, "brief", key);
  setTimeout(release, 100);
  const [first, second] = await Promise.all([owner, waiting]);
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().folder.id, first.body.folder.id);
  assert.equal((await f.folders(user)).length, 1);
});

test("idempotency keys are validated and bounded", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  for (const bad of ["x".repeat(129), "has space", "semi;colon", "new\nline", "emoji-🙂"]) {
    assert.throws(() => validateIdempotencyKey(bad), (error) => error.code === "IDEMPOTENCY_KEY_INVALID", bad);
  }
  assert.equal(validateIdempotencyKey(undefined), null);
  assert.equal(validateIdempotencyKey(""), null);
  assert.equal(validateIdempotencyKey("  ok-key_1.2:3~ "), "ok-key_1.2:3~");

  const tooLong = await f.create(user, "n", "k".repeat(200));
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  const badChars = await f.create(user, "n", "bad key!");
  assert.equal(badChars.statusCode, 400);
  assert.equal((await f.folders(user)).length, 0);
  assert.equal(await prisma.idempotencyKey.count({ where: { userId: user.id } }), 0);
});

test("fingerprints ignore key order but not content", () => {
  assert.equal(fingerprint({ a: 1, b: { c: 2, d: 3 } }), fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(fingerprint({ name: "a" }), fingerprint({ name: "b" }));
});

test("expired records are pruned in bounded batches; live ones are kept", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  for (const key of ["old-1", "old-2", "live-1"]) {
    assert.equal((await f.create(user, `n-${key}`, key)).statusCode, 201);
  }
  await prisma.idempotencyKey.updateMany({
    where: { userId: user.id, key: { startsWith: "old" } },
    data: { expiresAt: new Date(Date.now() - 2 * 3600 * 1000) }
  });
  const removed = await pruneExpiredIdempotencyKeys(prisma, { limit: 1 });
  assert.equal(removed, 1, "bounded by the batch limit");
  await pruneExpiredIdempotencyKeys(prisma);
  const remaining = (await prisma.idempotencyKey.findMany({ where: { userId: user.id } })).map((row) => row.key);
  assert.deepEqual(remaining, ["live-1"]);
});

test("correctness does not depend on Redis: the PostgreSQL path works with Redis unavailable", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const { redis } = require("../src/lib/redis");
  assert.ok(!redis?.isReady, "this test process has no live Redis connection");
  const key = "no-redis";
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => f.create(user, "plain", key)));
  assert.deepEqual([a, b, c].map((r) => r.statusCode), [201, 201, 201]);
  assert.equal(new Set([a, b, c].map((r) => r.json().folder.id)).size, 1);
});

test("an unrelated lock on the User row is waited out, never reported as an in-progress duplicate (no false 409)", async (t) => {
  const f = await fixture(t, 1); // lock timeout is 400 ms
  const [user] = f.users;

  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let locked;
  const lockedSignal = new Promise((resolve) => { locked = resolve; });
  // e.g. an upload or plan transaction holding the user row, which blocks foreign-key checks.
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    locked();
    await hold;
  });
  await lockedSignal;

  let settled = false;
  const pending = f.create(user, "behind-user-lock", "user-lock-key").then((res) => { settled = true; return res; });
  await new Promise((resolve) => setTimeout(resolve, 900)); // well past the 400 ms duplicate-wait timeout
  assert.equal(settled, false, "the request must keep waiting on the user lock, not give up with a 409");

  release();
  await holder;
  const res = await pending;
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((await f.folders(user)).length, 1);
});

test("a burst of same-key duplicates queues in memory, holding no connection, while an original is slow", async (t) => {
  const f = await fixture(t, 1, { idempotencyLockTimeoutMs: 5000 });
  const [user] = f.users;
  const key = "burst";

  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let claimed;
  const claimedSignal = new Promise((resolve) => { claimed = resolve; });
  const owner = runIdempotent({
    userId: user.id, operation: "folder.create", key, payload: { name: "burst" }, lockTimeoutMs: 5000,
    execute: async (tx) => {
      const folder = await tx.folder.create({ data: { name: "burst", userId: user.id } });
      claimed();
      await hold;
      return { status: 201, body: { message: "Folder created successfully", folder } };
    }
  });
  await claimedSignal;

  const duplicates = Array.from({ length: 12 }, () => f.create(user, "burst", key));
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Same-user duplicates queue in the process behind the user's slot; they hold no connection.
  assert.ok(sharedGate.queuedFor(user.id) >= 10, `duplicates should be queued in memory, saw ${sharedGate.queuedFor(user.id)}`);
  assert.equal(sharedGate.activeFor(user.id), 1, "a user never holds more than one slot");
  const [{ waiting }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS waiting FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `;
  assert.ok(waiting <= MAX_CONCURRENT - 1, `at most ${MAX_CONCURRENT - 1} duplicates may hold a connection, saw ${waiting}`);

  release();
  const original = await owner;
  const replies = await Promise.all(duplicates);
  assert.ok(replies.every((r) => r.statusCode === 201), replies.map((r) => r.statusCode).join());
  assert.equal(new Set(replies.map((r) => r.json().folder.id)).size, 1);
  assert.equal(replies[0].json().folder.id, original.body.folder.id);
  assert.equal((await f.folders(user)).length, 1);
});

test("a committed record is replayed without opening a transaction", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const args = {
    userId: user.id, operation: "folder.create", key: "fast-path", payload: { name: "fast" },
    execute: async (tx) => ({ status: 201, body: { folder: await tx.folder.create({ data: { name: "fast", userId: user.id } }) } })
  };
  const first = await runIdempotent(args);
  const noTransactions = {
    idempotencyKey: prisma.idempotencyKey,
    $transaction: () => { throw new Error("replay must not open a transaction"); }
  };
  const replay = await runIdempotent({ ...args, client: noTransactions });
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.folder.id, first.body.folder.id);
  const mismatch = await runIdempotent({ ...args, payload: { name: "other" }, client: noTransactions });
  assert.equal(mismatch.mismatch, true);
});

test("the concurrency gate caps active holders, queues the rest in order without holding anything, and bounds waiting", async () => {
  const gate = createGate({ concurrency: 2, perOwner: 2, maxQueue: 2 });
  const order = [];
  const r1 = await gate.acquire(1000);
  const r2 = await gate.acquire(1000);
  assert.equal(gate.active, 2);

  const w1 = gate.acquire(1000).then((release) => { order.push("w1"); return release; });
  const w2 = gate.acquire(1000).then((release) => { order.push("w2"); return release; });
  assert.equal(gate.queued, 2);
  await assert.rejects(gate.acquire(1000), (error) => error.code === "IDEMPOTENCY_IN_PROGRESS", "queue is bounded");

  r1();
  const rw1 = await w1;
  assert.deepEqual(order, ["w1"], "FIFO");
  assert.equal(gate.active, 2);
  r2();
  const rw2 = await w2;
  assert.deepEqual(order, ["w1", "w2"]);
  rw1();
  rw2();
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);

  // A waiter that is not served in time gives up with the documented in-progress error.
  const slow = createGate({ concurrency: 1, perOwner: 1, maxQueue: 5 });
  const held = await slow.acquire(1000);
  await assert.rejects(slow.acquire(60), (error) => error.code === "IDEMPOTENCY_IN_PROGRESS");
  assert.equal(slow.queued, 0, "the timed-out waiter left the queue");
  held();
  const again = await slow.acquire(1000);
  again();
});

test("one user's stalled request and its duplicates cannot cause false 409s for other users", async (t) => {
  const f = await fixture(t, 2, { idempotencyLockTimeoutMs: 400 });
  const [stalled, other] = f.users;

  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let claimed;
  const claimedSignal = new Promise((resolve) => { claimed = resolve; });
  const owner = runIdempotent({
    userId: stalled.id, operation: "folder.create", key: "stall", payload: { name: "slow" }, lockTimeoutMs: 5000,
    execute: async (tx) => {
      const folder = await tx.folder.create({ data: { name: "slow", userId: stalled.id } });
      claimed();
      await hold;
      return { status: 201, body: { folder } };
    }
  });
  await claimedSignal;

  // The stalled user floods same-key duplicates: with a process-wide gate they would fill every slot.
  const duplicates = Array.from({ length: 10 }, () => f.create(stalled, "slow", "stall"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sharedGate.activeFor(stalled.id), 1);

  // Another user's keyed creates must be served immediately, well inside the 400 ms duplicate-wait timeout.
  const started = Date.now();
  const served = await Promise.all([1, 2, 3, 4, 5].map((n) => f.create(other, `other-${n}`, `other-key-${n}`)));
  assert.ok(served.every((r) => r.statusCode === 201), served.map((r) => r.statusCode).join());
  assert.ok(Date.now() - started < 380, `other users were delayed ${Date.now() - started} ms by someone else's stall`);

  release();
  await owner;
  await Promise.all(duplicates);
  assert.equal((await f.folders(other)).length, 5);
});

test("the gate is per-owner fair: no head-of-line blocking, per-owner caps and queue bounds", async () => {
  const gate = createGate({ concurrency: 3, perOwner: 1, maxQueue: 10, maxQueuePerOwner: 2 });

  const a1 = await gate.acquire(1000, "A");
  assert.equal(gate.activeFor("A"), 1);

  // A's second and third requests queue (cap 1 per owner) although process capacity remains.
  const order = [];
  const a2 = gate.acquire(1000, "A").then((release) => { order.push("A2"); return release; });
  const a3 = gate.acquire(1000, "A").then((release) => { order.push("A3"); return release; });
  assert.equal(gate.queuedFor("A"), 2);
  await assert.rejects(gate.acquire(1000, "A"), (error) => error.code === "IDEMPOTENCY_IN_PROGRESS", "per-owner queue is bounded");

  // Others are admitted at once even though A's waiters are ahead of them in the queue.
  const b = await gate.acquire(1000, "B");
  const c = await gate.acquire(1000, "C");
  assert.equal(gate.active, 3);
  b();
  c();

  a1();
  const ra2 = await a2;
  assert.deepEqual(order, ["A2"]);
  assert.equal(gate.activeFor("A"), 1, "still at most one slot for A");
  ra2();
  (await a3)();
  assert.deepEqual(order, ["A2", "A3"]);
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);

  // When process capacity (not the per-owner cap) is the limit, a freed slot goes to the next eligible owner.
  const small = createGate({ concurrency: 1, perOwner: 1 });
  const first = await small.acquire(1000, "X");
  const waitsForY = small.acquire(1000, "Y");
  const waitsForX = small.acquire(1000, "X");
  first();
  const gotY = await waitsForY;
  assert.equal(small.activeFor("Y"), 1);
  gotY();
  (await waitsForX)();
  assert.equal(small.active, 0);

  // releasing twice is harmless
  const once = await small.acquire(1000, "Z");
  once();
  once();
  assert.equal(small.active, 0);
});

test("an identical request from ANOTHER PROCESS waits on the advisory lock, then gets the documented 409 + Retry-After", async (t) => {
  const f = await fixture(t, 1);
  const [user] = f.users;
  const worker = fork(path.join(__dirname, "..", "scripts", "app-worker.js"), [], {
    env: { ...process.env, JWT_SECRET, WORKER_IDEMPOTENCY_LOCK_TIMEOUT_MS: "500" },
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  const { port } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not start")), 20_000);
    worker.once("message", (message) => { clearTimeout(timer); resolve(message); });
  });

  const key = "cross-process-inflight";
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let claimed;
  const claimedSignal = new Promise((resolve) => { claimed = resolve; });
  const owner = runIdempotent({
    userId: user.id, operation: "folder.create", key, payload: { name: "held" }, lockTimeoutMs: 5000,
    execute: async (tx) => {
      const folder = await tx.folder.create({ data: { name: "held", userId: user.id } });
      claimed();
      await hold;
      return { status: 201, body: { message: "Folder created successfully", folder } };
    }
  });
  await claimedSignal;

  const request = () => fetch(`http://127.0.0.1:${port}/folders`, {
    method: "POST",
    headers: { ...f.auth(user), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ name: "held" })
  });
  const waiting = request();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const [{ pending }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS pending FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  `;
  assert.ok(pending >= 1, "the other process's duplicate is genuinely waiting on the advisory lock");

  const timedOut = await waiting;
  assert.equal(timedOut.status, 409);
  assert.equal(timedOut.headers.get("retry-after"), "1");

  release();
  const done = await owner;
  const replay = await request();
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).folder.id, done.body.folder.id);
  assert.equal((await f.folders(user)).length, 1);
});
