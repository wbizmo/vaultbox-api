const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { cleanupUploadSessions } = require("../src/lib/upload-session");

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "part-fencing-test-secret-long-enough-for-tests",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  uploadCompletionLeaseSeconds: 30,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

/**
 * Storage whose part write streams can be held open at their very end. Bytes are fully
 * streamed and hashed, but the PUT cannot reach its database insert until the barrier opens,
 * which is exactly the "stream finished, insert not yet committed" window that matters.
 */
class BarrierStorage extends LocalStorageAdapter {
  constructor(root) {
    super(root);
    this.barriers = [];
  }

  /** Hold the next `count` part writes; returns {entered[], release()}. */
  hold(count = 1) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = [];
    for (let i = 0; i < count; i += 1) {
      let resolveEntered;
      entered.push(new Promise((resolve) => { resolveEntered = resolve; }));
      this.barriers.push({ gate, entered: resolveEntered });
    }
    return { entered, release };
  }

  /** Lets a test close the session at the exact moment the part's object is about to be opened. */
  async deleteUploadPart(sessionId, storedName) {
    if (this.pendingClose) await this.pendingClose;
    return super.deleteUploadPart(sessionId, storedName);
  }

  createUploadPartWriteStream(sessionId, storedName) {
    if (this.onCreate) this.onCreate(sessionId);
    const real = super.createUploadPartWriteStream(sessionId, storedName);
    const barrier = this.barriers.shift();
    if (!barrier) return real;
    return new Writable({
      write(chunk, encoding, callback) {
        real.write(chunk, encoding, callback);
      },
      final(callback) {
        barrier.entered();
        barrier.gate.then(() => real.end(callback), callback);
      },
      destroy(error, callback) {
        real.destroy(error || undefined);
        callback(error);
      }
    });
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-fence-"));
  const storage = new BarrierStorage(root);
  const plan = await prisma.plan.create({
    data: { name: `fence-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 10000n }
  });
  const user = await prisma.user.create({
    data: { name: "Fence", email: `fence-${crypto.randomUUID()}@example.com`, password: "x", planId: plan.id }
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

  const bytes = Buffer.from("abcdefghijkl"); // 3 parts of 4 bytes

  async function createSession() {
    const created = await app.inject({
      method: "POST",
      url: "/upload-sessions",
      headers,
      payload: { originalName: "fence.bin", mimeType: "application/octet-stream", expectedSize: bytes.length }
    });
    assert.equal(created.statusCode, 201, created.body);
    return created.json().session.id;
  }

  /** Start (without awaiting) a PUT of one part. */
  function putPart(id, part, data = bytes.subarray(part * 4, part * 4 + 4)) {
    const body = multipart(data);
    return app.inject({
      method: "PUT",
      url: `/upload-sessions/${id}/parts/${part}`,
      headers: {
        ...headers,
        "content-type": body.contentType,
        "content-range": `bytes ${part * 4}-${part * 4 + data.length - 1}/${bytes.length}`
      },
      payload: body.payload
    });
  }

  const complete = (id) => app.inject({ method: "POST", url: `/upload-sessions/${id}/complete`, headers });
  const abort = (id) => app.inject({ method: "DELETE", url: `/upload-sessions/${id}`, headers });
  const account = () => prisma.user.findUnique({ where: { id: user.id } });
  const partRows = (id) => prisma.uploadPart.findMany({ where: { sessionId: id }, orderBy: { partNumber: "asc" } });
  const partFiles = async (id) => (await fs.readdir(storage.resolveUploadSession(id)).catch(() => []));

  return { app, storage, root, user, headers, bytes, createSession, putPart, complete, abort, account, partRows, partFiles };
}

test("last part in flight while complete is requested: complete is refused, then both succeed in order", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  assert.equal((await f.putPart(id, 0)).statusCode, 201);
  assert.equal((await f.putPart(id, 1)).statusCode, 201);

  const gate = f.storage.hold();
  const last = f.putPart(id, 2);
  await gate.entered[0];

  // The last part's bytes are streamed but not committed: it must not be visible or completable.
  const early = await f.complete(id);
  assert.equal(early.statusCode, 409, early.body);
  assert.deepEqual(early.json().missingParts, [2]);
  assert.equal((await f.partRows(id)).length, 2);

  gate.release();
  const stored = await last;
  assert.equal(stored.statusCode, 201, stored.body);

  const done = await f.complete(id);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().file.size, "12");
  const account = await f.account();
  assert.equal(account.storageUsed, 12n);
  assert.equal(account.reservedUploadBytes, 0n);
});

test("a part still streaming when the session is aborted is rejected, leaves no row or bytes, and quota is released once", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  assert.equal((await f.putPart(id, 0)).statusCode, 201);

  const gate = f.storage.hold();
  const inFlight = f.putPart(id, 1);
  await gate.entered[0];

  const aborted = await f.abort(id);
  assert.equal(aborted.statusCode, 200, aborted.body);

  gate.release();
  const late = await inFlight;
  assert.equal(late.statusCode, 409, late.body);
  assert.match(late.json().message, /no longer accepts parts/);

  assert.deepEqual((await f.partRows(id)).map((p) => p.partNumber), [0], "the late part must not become visible");
  assert.deepEqual(await f.partFiles(id), [], "no orphaned part bytes remain");
  const account = await f.account();
  assert.equal(account.reservedUploadBytes, 0n, "reservation released exactly once, never negative");
});

test("a part still streaming when the session expires gets 410 and nothing is stored", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();

  const gate = f.storage.hold();
  const inFlight = f.putPart(id, 0);
  await gate.entered[0];

  await prisma.uploadSession.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await cleanupUploadSessions(f.storage);
  assert.equal((await prisma.uploadSession.findUnique({ where: { id } })).status, "EXPIRED");

  gate.release();
  const late = await inFlight;
  assert.equal(late.statusCode, 410, late.body);
  assert.equal((await f.partRows(id)).length, 0);
  assert.deepEqual(await f.partFiles(id), []);
  assert.equal((await f.account()).reservedUploadBytes, 0n);
});

test("a part cannot commit once completion has claimed the session, and the frozen set is what is assembled", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  assert.equal((await f.putPart(id, 0)).statusCode, 201);
  assert.equal((await f.putPart(id, 1)).statusCode, 201);

  const gate = f.storage.hold();
  const inFlight = f.putPart(id, 2);
  await gate.entered[0];

  // Another actor has claimed completion (as the claim UPDATE would) while the part streams.
  await prisma.uploadSession.update({
    where: { id },
    data: { status: "COMPLETING", completionToken: "someone-else", completionLeaseUntil: new Date(Date.now() + 60_000) }
  });
  gate.release();
  const late = await inFlight;
  assert.equal(late.statusCode, 409, late.body);
  assert.equal((await f.partRows(id)).length, 2, "the frozen part set did not grow");
  assert.deepEqual(await f.partFiles(id), (await f.partRows(id)).map((p) => p.storedName).sort());
});

test("insert waits for an in-progress claim and then sees the closed session (row-lock fence)", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  assert.equal((await f.putPart(id, 0)).statusCode, 201);
  assert.equal((await f.putPart(id, 1)).statusCode, 201);

  const gate = f.storage.hold();
  const inFlight = f.putPart(id, 2);
  await gate.entered[0];

  // A claim transaction holds the session row (UPDATE) but has not committed. The insert's
  // FOR SHARE must wait for it, then observe COMPLETING -- never slip a part in beside it.
  let releaseClaim;
  const claimHeld = new Promise((resolve) => { releaseClaim = resolve; });
  let claimLocked;
  const claimLockedSignal = new Promise((resolve) => { claimLocked = resolve; });
  const claim = prisma.$transaction(async (tx) => {
    await tx.uploadSession.updateMany({
      where: { id, status: "UPLOADING" },
      data: { status: "COMPLETING", completionToken: "claimer", completionLeaseUntil: new Date(Date.now() + 60_000) }
    });
    claimLocked();
    await claimHeld;
  });
  await claimLockedSignal;

  let settled = false;
  gate.release();
  const outcome = inFlight.then((res) => { settled = true; return res; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(settled, false, "the part insert must block behind the in-flight claim");

  releaseClaim();
  await claim;
  const late = await outcome;
  assert.equal(late.statusCode, 409, late.body);
  assert.equal((await f.partRows(id)).length, 2);
});

test("duplicate concurrent PUTs of the same part converge to one record and one object", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();

  const gate = f.storage.hold(2);
  const a = f.putPart(id, 0);
  const b = f.putPart(id, 0);
  await Promise.all(gate.entered);
  gate.release();
  const [ra, rb] = await Promise.all([a, b]);

  assert.ok([ra.statusCode, rb.statusCode].every((code) => code === 200 || code === 201), `${ra.statusCode},${rb.statusCode}`);
  assert.equal([ra, rb].filter((r) => r.statusCode === 201).length, 1, "exactly one creates the part");
  const rows = await f.partRows(id);
  assert.equal(rows.length, 1);
  assert.deepEqual(await f.partFiles(id), [rows[0].storedName], "the loser's object was removed");
});

test("a conflicting duplicate (different bytes) is refused and leaves the first part intact", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();

  const gate = f.storage.hold(2);
  const a = f.putPart(id, 0, Buffer.from("abcd"));
  const b = f.putPart(id, 0, Buffer.from("WXYZ"));
  await Promise.all(gate.entered);
  gate.release();
  const results = await Promise.all([a, b]);

  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  const rows = await f.partRows(id);
  assert.equal(rows.length, 1);
  assert.equal((await f.partFiles(id)).length, 1);
});

test("a writer that starts after the session closed gets 409, not a server error", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  assert.equal((await f.abort(id)).statusCode, 200);
  const late = await f.putPart(id, 0);
  assert.equal(late.statusCode, 409, late.body);

  // And a writer whose chunk directory is deleted mid-flight (abort cleanup) is a conflict too.
  const id2 = await f.createSession();
  await prisma.uploadSession.update({ where: { id: id2 }, data: { status: "ABORTED" } });
  await f.storage.deleteUploadSessionChunks(id2);
  const dirGone = await f.putPart(id2, 0);
  assert.equal(dirGone.statusCode, 409, dirGone.body);
});

test("completion repair removes only the exact missing-object row, never a replacement", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  for (let part = 0; part < 3; part += 1) assert.equal((await f.putPart(id, part)).statusCode, 201);

  const [broken] = await f.partRows(id);
  await fs.rm(f.storage.resolveUploadPart(id, broken.storedName));
  const refused = await f.complete(id);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual((await f.partRows(id)).map((p) => p.partNumber), [1, 2], "only the broken row was removed");
  assert.equal((await prisma.uploadSession.findUnique({ where: { id } })).status, "UPLOADING");

  assert.equal((await f.putPart(id, 0)).statusCode, 201);
  const done = await f.complete(id);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal((await f.account()).storageUsed, 12n);
});

test("a concurrently re-uploaded part survives completion's missing-object repair", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  for (let part = 0; part < 3; part += 1) assert.equal((await f.putPart(id, part)).statusCode, 201);
  const [old] = await f.partRows(id);

  // While completion assembles, a client re-uploads part 0 (new row + object), after which
  // assembly reports the OLD object as missing. Repair must delete only the old pair.
  f.storage.assembleUploadParts = async () => {
    const replacementName = crypto.randomUUID();
    await fs.writeFile(f.storage.resolveUploadPart(id, replacementName), f.bytes.subarray(0, 4));
    await prisma.uploadPart.delete({ where: { id: old.id } });
    await prisma.uploadPart.create({
      data: {
        sessionId: id,
        partNumber: 0,
        offset: 0n,
        size: 4n,
        checksum: old.checksum,
        storedName: replacementName
      }
    });
    const error = new Error("missing");
    error.code = "ENOENT";
    error.uploadPartNumber = 0;
    error.uploadPartStoredName = old.storedName;
    throw error;
  };

  const refused = await f.complete(id);
  assert.equal(refused.statusCode, 409, refused.body);
  const rows = await f.partRows(id);
  assert.deepEqual(rows.map((p) => p.partNumber), [0, 1, 2], "the replacement row was not deleted");
  assert.notEqual(rows[0].storedName, old.storedName);
});

test("a session aborted between the status check and the object open yields 409, not a 500", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();

  // The handler has already seen UPLOADING. As it opens the part object the session is
  // aborted and its chunk directory removed, so the open fails with ENOENT.
  f.storage.onCreate = (sessionId) => {
    f.storage.onCreate = null;
    f.storage.pendingClose = prisma.uploadSession.update({ where: { id: sessionId }, data: { status: "ABORTED" } });
    require("node:fs").rmSync(f.storage.resolveUploadSession(sessionId), { recursive: true, force: true });
  };
  const res = await f.putPart(id, 0);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((await f.partRows(id)).length, 0);
});

test("completion assembles the frozen part set read after the claim, not a stale pre-claim snapshot", async (t) => {
  const f = await fixture(t);
  const id = await f.createSession();
  for (let part = 0; part < 3; part += 1) assert.equal((await f.putPart(id, part)).statusCode, 201);
  const [old] = await f.partRows(id);

  // Between completion's initial read and its claim, part 0 is replaced (its object was lost
  // and the client re-uploaded it). The pre-claim snapshot still names the old object.
  const original = prisma.uploadSession.updateMany.bind(prisma.uploadSession);
  let replaced = false;
  prisma.uploadSession.updateMany = async (args) => {
    if (!replaced && args?.data?.status === "COMPLETING") {
      replaced = true;
      const name = crypto.randomUUID();
      await fs.writeFile(f.storage.resolveUploadPart(id, name), f.bytes.subarray(0, 4));
      await fs.rm(f.storage.resolveUploadPart(id, old.storedName));
      await prisma.uploadPart.delete({ where: { id: old.id } });
      await prisma.uploadPart.create({
        data: { sessionId: id, partNumber: 0, offset: 0n, size: 4n, checksum: old.checksum, storedName: name }
      });
    }
    return original(args);
  };
  t.after(() => { prisma.uploadSession.updateMany = original; });

  const done = await f.complete(id);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().file.size, "12");
});
