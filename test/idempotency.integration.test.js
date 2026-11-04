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
  fingerprint
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

async function fixture(t, userCount = 2) {
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
  const app = buildApp({ config, storage: new LocalStorageAdapter(root), logger: false });
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
  const f = await fixture(t, 1);
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
