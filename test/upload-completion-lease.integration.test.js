const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const {
  cleanupUploadSessions,
  releaseSession,
  recoverStaleCompletion
} = require("../src/lib/upload-session");

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "completion-lease-test-secret-long-enough",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  uploadCompletionLeaseSeconds: 2,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

/** Storage whose first assembly can be paused, so interleavings are deterministic. */
class GatedStorage extends LocalStorageAdapter {
  arm() {
    let release;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    this.pending = { gate, entered };
    return { entered: enteredPromise, release };
  }

  async assembleUploadParts(...args) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      pending.entered();
      await pending.gate;
    }
    return super.assembleUploadParts(...args);
  }
}

function multipart(bytes) {
  const boundary = `----vaultbox${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="part.bin"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-lease-"));
  const storage = new GatedStorage(root);
  const plan = await prisma.plan.create({
    data: { name: `lease-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 10000n }
  });
  const user = await prisma.user.create({
    data: { name: "Lease", email: `lease-${crypto.randomUUID()}@example.com`, password: "x", planId: plan.id }
  });
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ id: user.id })}` };

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.uploadPart.deleteMany({ where: { session: { userId: user.id } } });
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Create a session and upload every part (12 bytes = 3 parts of 4). */
  async function session(bytes = Buffer.from("abcdefghijkl")) {
    const created = await app.inject({
      method: "POST",
      url: "/upload-sessions",
      headers,
      payload: { originalName: "lease.bin", mimeType: "application/octet-stream", expectedSize: bytes.length }
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().session.id;
    for (let part = 0; part * 4 < bytes.length; part += 1) {
      const slice = bytes.subarray(part * 4, Math.min(bytes.length, part * 4 + 4));
      const body = multipart(slice);
      const res = await app.inject({
        method: "PUT",
        url: `/upload-sessions/${id}/parts/${part}`,
        headers: {
          ...headers,
          "content-type": body.contentType,
          "content-range": `bytes ${part * 4}-${part * 4 + slice.length - 1}/${bytes.length}`
        },
        payload: body.payload
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    return { id, size: BigInt(bytes.length), bytes };
  }
  const complete = (id) => app.inject({ method: "POST", url: `/upload-sessions/${id}/complete`, headers });
  const account = () => prisma.user.findUnique({ where: { id: user.id } });
  const row = (id) => prisma.uploadSession.findUnique({ where: { id } });

  return { app, storage, root, user, headers, session, complete, account, row };
}

test("a slow but healthy completion keeps its lease and is never reclaimed by cleanup", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const gate = f.storage.arm();

  const completing = f.complete(s.id);
  await gate.entered;

  // Wait longer than one full lease so only heartbeat renewal can keep it alive,
  // and make the session look both expired and stale by every other measure.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await prisma.uploadSession.update({
    where: { id: s.id },
    data: { expiresAt: new Date(Date.now() - 60_000) }
  });
  const swept = await cleanupUploadSessions(f.storage);
  assert.ok(swept >= 0);

  const mid = await f.row(s.id);
  assert.equal(mid.status, "COMPLETING", "a healthy lease must not be reclaimed");
  assert.ok(mid.completionLeaseUntil > new Date(), "heartbeat must have renewed the lease");
  assert.equal((await f.account()).reservedUploadBytes, s.size);

  gate.release();
  const res = await completing;
  assert.equal(res.statusCode, 200, res.body);

  const account = await f.account();
  assert.equal(account.storageUsed, s.size);
  assert.equal(account.reservedUploadBytes, 0n);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 1);
  const done = await f.row(s.id);
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.completionToken, null);
});

test("a killed completer is recovered: back to UPLOADING when valid, EXPIRED (released once) when not", async (t) => {
  const f = await fixture(t);

  // Crash simulation: COMPLETING with a lapsed lease and nobody heartbeating.
  const alive = await f.session();
  await prisma.uploadSession.update({
    where: { id: alive.id },
    data: { status: "COMPLETING", completionToken: "dead-worker", completionLeaseUntil: new Date(Date.now() - 1000) }
  });
  await cleanupUploadSessions(f.storage);
  const recovered = await f.row(alive.id);
  assert.equal(recovered.status, "UPLOADING");
  assert.equal(recovered.completionToken, null);
  assert.equal((await f.account()).reservedUploadBytes, alive.size, "reservation is kept for the retry");

  const retry = await f.complete(alive.id);
  assert.equal(retry.statusCode, 200, retry.body);

  // A second crashed session whose expiry has also passed is expired and released exactly once.
  const dead = await f.session();
  await prisma.uploadSession.update({
    where: { id: dead.id },
    data: {
      status: "COMPLETING",
      completionToken: "dead-worker",
      completionLeaseUntil: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() - 1000)
    }
  });
  const before = await f.account();
  await cleanupUploadSessions(f.storage);
  await cleanupUploadSessions(f.storage);
  assert.equal((await f.row(dead.id)).status, "EXPIRED");
  const after = await f.account();
  assert.equal(after.reservedUploadBytes, before.reservedUploadBytes - dead.size, "released exactly once");
  assert.ok(after.reservedUploadBytes >= 0n);
});

test("a client retry recovers a crashed completion inline without waiting for cleanup", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  await prisma.uploadSession.update({
    where: { id: s.id },
    data: { status: "COMPLETING", completionToken: "dead-worker", completionLeaseUntil: new Date(Date.now() - 1000) }
  });
  const res = await f.complete(s.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 1);
  assert.equal((await f.account()).storageUsed, s.size);
});

test("a recovered zombie completer is fenced: it cannot publish a second file or double-charge quota", async (t) => {
  const f = await fixture(t);
  const s = await f.session();
  const gate = f.storage.arm();

  const zombie = f.complete(s.id);
  await gate.entered;

  // The zombie stalls; its lease lapses and the session is recovered and re-completed by another request.
  await prisma.uploadSession.update({
    where: { id: s.id },
    data: { completionLeaseUntil: new Date(Date.now() - 1000) }
  });
  await cleanupUploadSessions(f.storage);
  assert.equal((await f.row(s.id)).status, "UPLOADING");
  const winner = await f.complete(s.id);
  assert.equal(winner.statusCode, 200, winner.body);

  gate.release();
  const late = await zombie;
  assert.equal(late.statusCode, 409, late.body);

  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 1);
  const account = await f.account();
  assert.equal(account.storageUsed, s.size, "quota converted exactly once");
  assert.equal(account.reservedUploadBytes, 0n);
  // The zombie's assembled bytes were removed; only the winner's file remains in storage.
  const stored = (await fs.readdir(f.root, { withFileTypes: true })).filter((entry) => entry.isFile());
  assert.equal(stored.length, 1, `expected only the winner's object, found ${stored.map((e) => e.name)}`);
});

test("two simultaneous completions yield one file; abort racing completion never corrupts quota", async (t) => {
  const f = await fixture(t);

  const dup = await f.session();
  const [a, b] = await Promise.all([f.complete(dup.id), f.complete(dup.id)]);
  assert.ok([a.statusCode, b.statusCode].includes(200));
  assert.ok([a.statusCode, b.statusCode].every((code) => code === 200 || code === 409), `${a.statusCode},${b.statusCode}`);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 1);

  let completed = 1;
  for (let round = 0; round < 8; round += 1) {
    const s = await f.session();
    const [done, aborted] = await Promise.all([
      f.complete(s.id),
      f.app.inject({ method: "DELETE", url: `/upload-sessions/${s.id}`, headers: f.headers })
    ]);
    assert.ok(done.statusCode < 500 && aborted.statusCode < 500, `round ${round}: ${done.statusCode}/${aborted.statusCode}`);
    const final = await f.row(s.id);
    assert.ok(["COMPLETED", "ABORTED"].includes(final.status), final.status);
    if (final.status === "COMPLETED") completed += 1;
  }
  const account = await f.account();
  assert.equal(account.reservedUploadBytes, 0n, "no leaked or negative reservation");
  assert.equal(account.storageUsed, BigInt(completed) * 12n, "every completed upload charged exactly once");
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), completed);
});

test("lock order is User before UploadSession in abort/expiry and stale recovery", async (t) => {
  const f = await fixture(t);

  async function assertSessionUnlockedWhileUserLocked(run) {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    let locked;
    const lockedSignal = new Promise((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.user.id} FOR UPDATE`;
      locked();
      await hold;
    });
    await lockedSignal;

    let settled = false;
    const operation = run().then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled, false, "operation must wait for the User lock first");

    // If the operation had taken the session lock first (the old, deadlock-prone order),
    // NOWAIT would fail here because the operation would be holding it while blocked on User.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "UploadSession" WHERE "id" = ${currentSessionId} FOR UPDATE NOWAIT`;
    });
    release();
    await holder;
    return operation;
  }

  let currentSessionId;
  const toAbort = await f.session();
  currentSessionId = toAbort.id;
  const session = await f.row(toAbort.id);
  assert.equal(await assertSessionUnlockedWhileUserLocked(() => releaseSession(session, "ABORTED")), true);

  const stale = await f.session();
  currentSessionId = stale.id;
  await prisma.uploadSession.update({
    where: { id: stale.id },
    data: { status: "COMPLETING", completionToken: "dead", completionLeaseUntil: new Date(Date.now() - 1000) }
  });
  const staleRow = await f.row(stale.id);
  assert.equal(await assertSessionUnlockedWhileUserLocked(() => recoverStaleCompletion(staleRow)), "UPLOADING");
});

test("a zombie cannot commit while a newer completer holds the lease", async (t) => {
  const f = await fixture(t);
  const s = await f.session();

  // Zombie A claims the session and stalls inside assembly.
  const gateA = f.storage.arm();
  const zombie = f.complete(s.id);
  await gateA.entered;
  const tokenA = (await f.row(s.id)).completionToken;
  assert.ok(tokenA);

  // A's lease lapses; the session is recovered and a new completer B claims it and stalls too.
  await prisma.uploadSession.update({ where: { id: s.id }, data: { completionLeaseUntil: new Date(Date.now() - 1000) } });
  await cleanupUploadSessions(f.storage);
  const gateB = f.storage.arm();
  const successor = f.complete(s.id);
  await gateB.entered;
  const owner = await f.row(s.id);
  assert.equal(owner.status, "COMPLETING");
  assert.notEqual(owner.completionToken, tokenA);
  assert.equal(owner.completionGeneration, 2);

  // A resumes first and tries to commit while B owns the session: it must be fenced out.
  gateA.release();
  const late = await zombie;
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0, "the zombie must not publish");
  assert.equal((await f.row(s.id)).completionToken, owner.completionToken, "B's lease is untouched");

  gateB.release();
  const win = await successor;
  assert.equal(win.statusCode, 200, win.body);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 1);
  const account = await f.account();
  assert.equal(account.storageUsed, s.size);
  assert.equal(account.reservedUploadBytes, 0n);
});
