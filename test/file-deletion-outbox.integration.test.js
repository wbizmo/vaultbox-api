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
const { softDeleteFileWithQuota } = require("../src/lib/file-delete");
const {
  backoffMs,
  claimFileDeletions,
  processFileDeletions,
  fileDeletionStats,
  requeueDeadFileDeletions,
  pruneFinishedFileDeletions,
  DEFAULTS
} = require("../src/lib/file-deletion");

/*
 * Issue #54: physical byte removal is a durable, retried job created in the same transaction as the
 * logical deletion and the quota refund. These tests use real PostgreSQL and real files, inject storage
 * failures, kill a worker mid-deletion, and race workers.
 */

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "file-deletion-outbox-secret-long-enough-for-tests",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};
const unique = () => crypto.randomUUID().slice(0, 10);
const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

/** Storage whose deleteFile can be made to fail, and which counts calls per object. */
class FlakyStorage extends LocalStorageAdapter {
  constructor(root) {
    super(root);
    this.failWith = null;
    this.calls = new Map();
  }

  async deleteFile(file) {
    this.calls.set(file.storedName, (this.calls.get(file.storedName) || 0) + 1);
    if (this.failWith) throw this.failWith;
    return super.deleteFile(file);
  }
}

async function fixture(t, { storageUsed = 0n } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-delout-"));
  const storage = new FlakyStorage(root);
  await storage.ready();
  const plan = await prisma.plan.create({ data: { name: `del-${unique()}`, priceMonthly: 0, storageLimit: 1_000_000n } });
  const user = await prisma.user.create({
    data: { name: "Del", email: `del-${unique()}@example.com`, password: "x", planId: plan.id, storageUsed }
  });
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ id: user.id })}` };

  const createFile = async (bytes = Buffer.from("some stored bytes"), owner = user) => {
    const storedName = crypto.randomUUID();
    await fs.writeFile(path.join(root, storedName), bytes);
    const file = await prisma.file.create({
      data: {
        originalName: "x.bin", storedName, mimeType: "application/octet-stream", size: BigInt(bytes.length),
        path: storedName, checksum: crypto.createHash("sha256").update(bytes).digest("hex"), userId: owner.id
      }
    });
    await prisma.user.update({ where: { id: owner.id }, data: { storageUsed: { increment: BigInt(bytes.length) } } });
    return file;
  };
  const exists = (file) => fs.access(path.join(root, file.storedName)).then(() => true, () => false);
  const outbox = (file) => prisma.fileDeletion.findUnique({ where: { fileId: file.id } });
  const account = () => prisma.user.findUnique({ where: { id: user.id } });
  const del = (file) => app.inject({ method: "DELETE", url: `/files/${file.id}`, headers });
  const makeDue = (file) => prisma.fileDeletion.update({
    where: { fileId: file.id }, data: { nextAttemptAt: new Date(Date.now() - 1000), lockedUntil: null }
  });

  t.after(async () => {
    await app.close();
    await prisma.fileDeletion.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.downloadToken.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { app, root, storage, user, headers, createFile, exists, outbox, account, del, makeDue };
}

test("the logical delete, the quota refund and the outbox row are one atomic, once-only statement", async (t) => {
  const f = await fixture(t);
  const file = await f.createFile(Buffer.alloc(40, 1));

  const results = await Promise.all([
    softDeleteFileWithQuota(f.user.id, file.id),
    softDeleteFileWithQuota(f.user.id, file.id),
    softDeleteFileWithQuota(f.user.id, file.id)
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const rows = await prisma.fileDeletion.findMany({ where: { fileId: file.id } });
  assert.equal(rows.length, 1, "exactly one job per deleted file");
  assert.equal(rows[0].status, "PENDING");
  assert.equal(rows[0].storedName, file.storedName);
  assert.equal(rows[0].size, 40n);
  assert.equal((await f.account()).storageUsed, 0n, "refunded once");

  // A transaction that fails after the delete rolls the file, the refund and the job back together.
  const second = await f.createFile(Buffer.alloc(10, 2));
  await assert.rejects(prisma.$transaction(async (tx) => {
    await softDeleteFileWithQuota(f.user.id, second.id, tx);
    throw new Error("audit insert failed");
  }), /audit insert failed/);
  assert.equal((await prisma.file.findUnique({ where: { id: second.id } })).status, "ACTIVE");
  assert.equal(await f.outbox(second), null, "no job without a committed deletion");
  assert.equal((await f.account()).storageUsed, 10n);
});

test("injected storage failure: the API answers correctly, the job persists, a later retry removes the bytes without a second refund", async (t) => {
  const f = await fixture(t);
  const file = await f.createFile(Buffer.alloc(25, 3));
  f.storage.failWith = Object.assign(new Error("disk unavailable"), { code: "EIO" });

  const res = await f.del(file);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await prisma.file.findUnique({ where: { id: file.id } })).status, "DELETED");
  assert.equal((await f.account()).storageUsed, 0n);
  assert.equal(await f.exists(file), true, "bytes still on storage");
  const pending = await f.outbox(file);
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.attempts, 1);
  assert.match(pending.lastError, /EIO: disk unavailable/);
  assert.ok(pending.nextAttemptAt > new Date(), "backed off");
  assert.equal(pending.lockedUntil, null);

  // Repeating DELETE is a plain 404 and changes nothing (no second refund, no extra job).
  assert.equal((await f.del(file)).statusCode, 404);
  assert.equal((await f.account()).storageUsed, 0n);
  assert.equal(await prisma.fileDeletion.count({ where: { fileId: file.id } }), 1);

  // Not due yet: a sweep leaves it alone. Once storage recovers and it is due, the sweep finishes it.
  assert.equal((await processFileDeletions(f.storage)).claimed, 0);
  f.storage.failWith = null;
  await f.makeDue(file);
  const outcome = await processFileDeletions(f.storage);
  assert.deepEqual({ claimed: outcome.claimed, done: outcome.done }, { claimed: 1, done: 1 });
  assert.equal(await f.exists(file), false);
  const done = await f.outbox(file);
  assert.equal(done.status, "DONE");
  assert.ok(done.completedAt);
  assert.equal(done.lastError, null);
  assert.equal((await f.account()).storageUsed, 0n, "retrying never refunds again");
  assert.equal((await prisma.file.findUnique({ where: { id: file.id } })).status, "DELETED", "never resurrected");
});

test("a healthy delete removes the bytes immediately and leaves a finished record", async (t) => {
  const f = await fixture(t);
  const file = await f.createFile();
  assert.equal((await f.del(file)).statusCode, 200);
  assert.equal(await f.exists(file), false);
  assert.equal((await f.outbox(file)).status, "DONE");
});

test("an object that is already gone counts as a finished cleanup", async (t) => {
  const f = await fixture(t);
  const file = await f.createFile();
  await fs.rm(path.join(f.root, file.storedName));
  assert.equal((await f.del(file)).statusCode, 200);
  assert.equal((await f.outbox(file)).status, "DONE");
});

test("backoff grows, is capped, and a job that keeps failing is dead-lettered then requeued by an operator", async (t) => {
  const f = await fixture(t);
  const file = await f.createFile();
  f.storage.failWith = Object.assign(new Error("still down"), { code: "EIO" });
  assert.equal((await f.del(file)).statusCode, 200);

  const delays = [];
  for (let attempt = 2; attempt <= DEFAULTS.maxAttempts; attempt += 1) {
    await f.makeDue(file);
    const before = Date.now();
    const outcome = await processFileDeletions(f.storage);
    const row = await f.outbox(file);
    assert.equal(row.attempts, attempt);
    delays.push(row.nextAttemptAt.getTime() - before);
    assert.equal(outcome.dead, attempt === DEFAULTS.maxAttempts ? 1 : 0);
  }
  const dead = await f.outbox(file);
  assert.equal(dead.status, "DEAD");
  assert.match(dead.lastError, /still down/);
  assert.ok(delays.every((delay) => delay <= DEFAULTS.maxBackoffMs * 1.25), "capped");
  assert.ok(delays[delays.length - 2] > delays[0], "grew with the attempts");

  // Dead rows are not retried automatically, they show up in the stats, and an operator can requeue them.
  await prisma.fileDeletion.update({ where: { fileId: file.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  assert.equal((await processFileDeletions(f.storage)).claimed, 0);
  const stats = await fileDeletionStats();
  assert.ok(stats.dead >= 1);
  assert.ok(BigInt(stats.unreclaimedBytes) >= BigInt(file.size));

  f.storage.failWith = null;
  assert.ok(await requeueDeadFileDeletions() >= 1);
  assert.equal((await processFileDeletions(f.storage)).done >= 1, true);
  assert.equal((await f.outbox(file)).status, "DONE");
  assert.equal(await f.exists(file), false);

  assert.ok(backoffMs(1, DEFAULTS, () => 0.5) === DEFAULTS.baseBackoffMs);
  assert.ok(backoffMs(40, DEFAULTS, () => 0.5) === DEFAULTS.maxBackoffMs);
});

test("concurrent workers and duplicate sweeps remove each object exactly once", async (t) => {
  const f = await fixture(t);
  const files = [];
  for (let i = 0; i < 24; i += 1) files.push(await f.createFile(Buffer.from(`object ${i}`)));
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  for (const file of files) assert.equal((await f.del(file)).statusCode, 200);
  f.storage.failWith = null;
  f.storage.calls.clear();
  for (const file of files) await f.makeDue(file);

  const outcomes = await Promise.all(Array.from({ length: 6 }, () => processFileDeletions(f.storage, { batchSize: 10 })));
  assert.equal(outcomes.reduce((sum, o) => sum + o.claimed, 0), 24, "every row claimed by exactly one worker");
  for (const file of files) {
    assert.equal(f.storage.calls.get(file.storedName), 1, "one storage call per object");
    assert.equal(await f.exists(file), false);
    assert.equal((await f.outbox(file)).status, "DONE");
  }
  assert.equal((await f.account()).storageUsed, 0n);
});

test("a worker killed mid-deletion: the job is held for its lease, then another worker finishes it, with no double refund", async (t) => {
  const f = await fixture(t);
  const file = await f.createFile(Buffer.alloc(33, 4));
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  assert.equal((await f.del(file)).statusCode, 200);
  f.storage.failWith = null;
  await f.makeDue(file);

  const worker = fork(path.join(__dirname, "..", "scripts", "file-deletion-crash-worker.js"), [], {
    env: { ...process.env, LEASE_MS: "1500" },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    worker.on("message", (message) => message.inStorageCall && resolve());
    worker.on("exit", () => reject(new Error("worker exited early")));
    setTimeout(() => reject(new Error("worker never reached storage")), 15_000).unref?.();
  });
  worker.kill("SIGKILL"); // abrupt crash: no cleanup runs

  const claimed = await f.outbox(file);
  assert.equal(claimed.status, "PENDING");
  assert.ok(claimed.lockedUntil > new Date(), "the dead worker's lease still holds the job");
  assert.equal((await processFileDeletions(f.storage)).claimed, 0, "nobody steals a live lease");
  assert.equal(await f.exists(file), true);

  assert.ok(await waitFor(async () => (await processFileDeletions(f.storage)).done === 1, 8000), "reclaimed after the lease lapsed");
  assert.equal(await f.exists(file), false);
  const finished = await f.outbox(file);
  assert.equal(finished.status, "DONE");
  assert.equal(finished.attempts, 3, "the lost attempt counted (1 failed delete, 1 killed claim, 1 success)");
  assert.equal((await f.account()).storageUsed, 0n, "no double refund");
});

test("an open download stream survives deletion; new downloads of a deleted file are refused", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(300_000, 7);
  const file = await f.createFile(bytes);
  const stream = await f.storage.openReadStreamForFile(file);

  assert.equal((await f.del(file)).statusCode, 200);
  assert.equal(await f.exists(file), false, "the name is gone");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.compare(Buffer.concat(chunks), bytes), 0, "the already-open transfer completes");

  const issued = await f.app.inject({ method: "POST", url: `/files/${file.id}/download-token`, headers: f.headers });
  assert.equal(issued.statusCode, 404, "no new download session for a deleted file");
});

test("stuck deletions are visible to operators through /metrics", async (t) => {
  const f = await fixture(t);
  const admin = await prisma.user.create({
    data: { name: "Admin", email: `admin-${unique()}@example.com`, password: "x", role: "ADMIN" }
  });
  t.after(() => prisma.user.delete({ where: { id: admin.id } }));
  const adminHeaders = { authorization: `Bearer ${f.app.jwt.sign({ id: admin.id })}` };

  const file = await f.createFile();
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  await f.del(file);
  await prisma.fileDeletion.update({ where: { fileId: file.id }, data: { createdAt: new Date(Date.now() - 3600_000) } });

  const res = await f.app.inject({ method: "GET", url: "/metrics", headers: adminHeaders });
  assert.equal(res.statusCode, 200, res.body);
  const { fileDeletions } = res.json().metrics;
  assert.ok(fileDeletions.pending >= 1);
  assert.ok(fileDeletions.retrying >= 1);
  assert.ok(fileDeletions.oldestPendingAgeSeconds >= 3500, `oldest pending age ${fileDeletions.oldestPendingAgeSeconds}s`);
  assert.ok(BigInt(fileDeletions.unreclaimedBytes) >= BigInt(file.size));
  assert.ok(!JSON.stringify(res.json()).includes(file.storedName), "no object names in metrics");
});

test("finished jobs are pruned after the retention period, pending ones never", async (t) => {
  const f = await fixture(t);
  const done = await f.createFile();
  await f.del(done);
  const pendingFile = await f.createFile();
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  await f.del(pendingFile);

  await prisma.fileDeletion.updateMany({ where: { userId: f.user.id }, data: { createdAt: new Date(Date.now() - 30 * 86400_000) } });
  await prisma.fileDeletion.update({ where: { fileId: done.id }, data: { completedAt: new Date(Date.now() - 30 * 86400_000) } });
  await pruneFinishedFileDeletions({ olderThanDays: 7 });
  assert.equal(await f.outbox(done), null);
  assert.equal((await f.outbox(pendingFile)).status, "PENDING");
});

test("claims are scoped: claiming one file's job leaves the others queued", async (t) => {
  const f = await fixture(t);
  const a = await f.createFile();
  const b = await f.createFile();
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  await f.del(a);
  await f.del(b);
  await f.makeDue(a);
  await f.makeDue(b);
  const claimed = await claimFileDeletions({ fileId: a.id, limit: 5 });
  assert.deepEqual(claimed.map((row) => row.fileId), [a.id]);
  assert.equal((await f.outbox(b)).lockedUntil, null);
});

test("a worker whose lease lapsed cannot settle a newer claim (settlement is fenced on the claimed attempt)", async (t) => {
  const f = await fixture(t);
  const file = await f.createFile();
  f.storage.failWith = Object.assign(new Error("first failure"), { code: "EIO" });
  assert.equal((await f.del(file)).statusCode, 200);
  f.storage.failWith = null;
  await f.makeDue(file);

  // Worker A claims the job and then stalls inside the storage call.
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const inCall = new Promise((resolve) => { entered = resolve; });
  const stalledStorage = {
    async deleteFile() {
      entered();
      await gate;
      throw Object.assign(new Error("late failure"), { code: "EIO" });
    }
  };
  const workerA = processFileDeletions(stalledStorage, { leaseMs: 60_000 });
  await inCall;

  // A's lease lapses; worker B claims the job (a newer attempt) and is still working on it.
  await prisma.fileDeletion.update({ where: { fileId: file.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
  const [claimB] = await claimFileDeletions({ fileId: file.id, leaseMs: 60_000 });
  assert.ok(claimB, "B claimed after A's lease lapsed");

  // A finally fails. Its outcome belongs to an older claim and must be ignored.
  release();
  await workerA;
  const row = await f.outbox(file);
  assert.equal(row.attempts, claimB.attempts, "still B's attempt");
  assert.ok(row.lockedUntil > new Date(), "B's lease was not cleared by the late worker");
  assert.doesNotMatch(row.lastError || "", /late failure/, "the stale failure was not recorded");

  // B completes normally.
  await prisma.fileDeletion.update({ where: { fileId: file.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
  assert.equal((await processFileDeletions(f.storage)).done, 1);
  assert.equal((await f.outbox(file)).status, "DONE");
});

test("a job whose worker keeps dying on the final attempt is dead-lettered, not retried forever; live leases are left alone", async (t) => {
  const f = await fixture(t);
  const lost = await f.createFile();
  const live = await f.createFile();
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  await f.del(lost);
  await f.del(live);
  f.storage.failWith = null;
  f.storage.calls.clear();

  // Both used all their attempts; one worker's lease lapsed (it died), the other is genuinely still running.
  await prisma.fileDeletion.update({
    where: { fileId: lost.id },
    data: { attempts: DEFAULTS.maxAttempts, lockedUntil: new Date(Date.now() - 1000), nextAttemptAt: new Date(Date.now() - 1000) }
  });
  await prisma.fileDeletion.update({
    where: { fileId: live.id },
    data: { attempts: DEFAULTS.maxAttempts, lockedUntil: new Date(Date.now() + 60_000), nextAttemptAt: new Date(Date.now() - 1000) }
  });

  const outcome = await processFileDeletions(f.storage);
  assert.equal(outcome.claimed, 0, "nothing was attempted again");
  const deadRow = await f.outbox(lost);
  assert.equal(deadRow.status, "DEAD");
  assert.ok(deadRow.lastError, "the reason is recorded");
  assert.equal(deadRow.lockedUntil, null);
  assert.equal((await f.outbox(live)).status, "PENDING", "a live lease is never reaped");
  assert.equal(f.storage.calls.size, 0, "storage was not called for either");
  assert.equal(await f.exists(lost), true, "the object is left for the operator");
});

test("a failing job-state update is logged with the file id and does not stop the rest of the batch", async (t) => {
  const f = await fixture(t);
  const a = await f.createFile();
  const b = await f.createFile();
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  await f.del(a);
  await f.del(b);
  f.storage.failWith = null;
  await f.makeDue(a);
  await f.makeDue(b);
  f.storage.calls.clear();

  const warnings = [];
  const flakyClient = {
    $queryRaw: prisma.$queryRaw.bind(prisma),
    $executeRaw(strings, ...values) {
      // Only the "mark DONE" settlement fails; the reaper and the claim keep working.
      if (strings.join("?").includes("\"completedAt\" = NOW()")) return Promise.reject(new Error("database hiccup"));
      return prisma.$executeRaw(strings, ...values);
    }
  };
  const outcome = await processFileDeletions(f.storage, { log: { warn: (details, message) => warnings.push({ details, message }) } }, flakyClient);
  assert.equal(outcome.claimed, 2);
  assert.equal(outcome.retry, 2, "both reported as needing a retry");
  assert.equal(f.storage.calls.size, 2, "the second job was still attempted");
  assert.deepEqual(warnings.map((w) => w.details.fileId).sort(), [a.id, b.id].sort());
  assert.match(warnings[0].details.err.message, /database hiccup/);
});

test("a download session issued before the deletion stops serving the file even while its bytes are still queued for removal", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("still on storage for now");
  const file = await f.createFile(bytes);
  const earlier = await f.app.inject({ method: "POST", url: `/files/${file.id}/download-token`, headers: f.headers });
  assert.equal(earlier.statusCode, 200, earlier.body);
  assert.equal((await f.app.inject({ method: "GET", url: earlier.json().downloadUrl })).statusCode, 200, "serves while the file is active");

  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  assert.equal((await f.del(file)).statusCode, 200);
  assert.equal(await f.exists(file), true, "the bytes are still on storage (cleanup is pending)");

  const stale = await f.app.inject({ method: "GET", url: earlier.json().downloadUrl });
  assert.equal(stale.statusCode, 404, stale.body);
  assert.deepEqual(stale.json(), { message: "File no longer exists" });
  const headStale = await f.app.inject({ method: "HEAD", url: earlier.json().downloadUrl });
  assert.equal(headStale.statusCode, 404);
});

test("one slow storage call does not hold back the other claimed jobs in the batch", async (t) => {
  const f = await fixture(t);
  const slow = await f.createFile();
  const quick = await f.createFile();
  f.storage.failWith = Object.assign(new Error("down"), { code: "EIO" });
  await f.del(slow);
  await f.del(quick);
  f.storage.failWith = null;
  await f.makeDue(slow);
  await f.makeDue(quick);
  f.storage.calls.clear();

  // The first object's removal hangs until released; the second must still be attempted while it hangs.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = f.storage.deleteFile.bind(f.storage);
  f.storage.deleteFile = async (file) => {
    if (file.storedName === slow.storedName) await gate;
    return original(file);
  };
  const running = processFileDeletions(f.storage, {});
  const quickDone = await waitFor(async () => !(await f.exists(quick)));
  assert.equal(quickDone, true, "the second job ran while the first was still in flight");
  release();
  const outcome = await running;
  assert.equal(outcome.done, 2);
  assert.equal(await f.exists(slow), false);
});
