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
const { createReservation, releaseReservation, reconcileExpiredReservations } = require("../src/lib/upload-reservation");
const {
  reserveUploadQuota,
  reservePendingUploadQuota,
  commitUploadReservation,
  releaseUploadReservation,
  switchPlanIfFits
} = require("../src/lib/quota");
const { switchPlanIfEntitled } = require("../src/lib/entitlements");
const { setAccountStatus } = require("../src/lib/account");

/*
 * Issue #45: a request authenticated before a suspension must not CREATE new usage after it. Every
 * state-changing transaction takes the owner's row lock and requires ACTIVE at its commit point;
 * cleanup (abort / expiry / reservation release) keeps working for suspended accounts.
 *
 * Interleavings are deterministic: either the request is held inside storage (in flight, already
 * authenticated), or the suspension is committed by a transaction that holds the owner's row lock
 * while the request is blocked waiting for it.
 */

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "account-state-fence-secret-long-enough-for-tests",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  uploadCompletionLeaseSeconds: 30,
  uploadReservationLeaseSeconds: 2,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

class HookedStorage extends LocalStorageAdapter {
  /** Hold the next one-shot write open at `final` until released. */
  holdWrite() {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    this.writeHold = { gate, entered };
    return { entered: enteredPromise, release };
  }

  /** Hold the next assembly (completion) before it returns. */
  holdAssemble() {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    this.assembleHold = { gate, entered };
    return { entered: enteredPromise, release };
  }

  createWriteStream(key) {
    const real = super.createWriteStream(key);
    const hold = this.writeHold;
    this.writeHold = null;
    if (!hold) return real;
    return new Writable({
      write(chunk, encoding, callback) { real.write(chunk, encoding, callback); },
      final(callback) {
        hold.entered();
        hold.gate.then(() => real.end(callback), callback);
      },
      destroy(error, callback) { real.destroy(error || undefined); callback(error); }
    });
  }

  async assembleUploadParts(...args) {
    const result = await super.assembleUploadParts(...args);
    const hold = this.assembleHold;
    this.assembleHold = null;
    if (hold) {
      hold.entered();
      await hold.gate;
    }
    return result;
  }
}

function multipart(bytes, filename = "one.bin") {
  const boundary = `----vaultbox${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function fixture(t, storageLimit = 10000n) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-fence45-"));
  const storage = new HookedStorage(root);
  const plan = await prisma.plan.create({
    data: { name: `f45-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit }
  });
  const otherPlan = await prisma.plan.create({
    data: { name: `f45b-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: storageLimit * 2n }
  });
  const user = await prisma.user.create({
    data: { name: "F45", email: `f45-${crypto.randomUUID()}@example.com`, password: "x", planId: plan.id }
  });
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ id: user.id, av: 0 })}` };

  t.after(async () => {
    await app.close();
    await prisma.idempotencyKey.deleteMany({ where: { userId: user.id } });
    await prisma.downloadToken.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.uploadReservation.deleteMany({ where: { userId: user.id } });
    await prisma.uploadPart.deleteMany({ where: { session: { userId: user.id } } });
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.folder.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.deleteMany({ where: { id: { in: [plan.id, otherPlan.id] } } });
    await fs.rm(root, { recursive: true, force: true });
  });

  const account = () => prisma.user.findUnique({ where: { id: user.id } });
  const suspend = () => setAccountStatus(user.id, "SUSPENDED");

  /**
   * Run `start()` (an HTTP request that will block on the owner's row lock) while a separate
   * transaction holds that lock; commit a suspension from inside it, then let the request run.
   * Returns the request's response. The request is authenticated BEFORE the suspension committed.
   */
  async function suspendWhileBlocked(start) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let locked;
    const lockedSignal = new Promise((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      locked();
      await gate;
      await tx.user.update({ where: { id: user.id }, data: { status: "SUSPENDED", authVersion: { increment: 1 } } });
    }, { timeout: 30000, maxWait: 30000 });
    await lockedSignal;

    const response = start();
    // Wait until the request is genuinely blocked on a row lock, then commit the suspension.
    const deadline = Date.now() + 10000;
    for (;;) {
      const waiting = await prisma.$queryRaw`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
      `;
      if (waiting[0].n > 0) break;
      if (Date.now() > deadline) throw new Error("request never blocked on the owner row lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await holder;
    return response;
  }

  return { app, storage, headers, user, plan, otherPlan, account, suspend, suspendWhileBlocked };
}

function createSession(f, body = { originalName: "s.bin", mimeType: "application/octet-stream", expectedSize: 8 }) {
  return f.app.inject({ method: "POST", url: "/upload-sessions", headers: f.headers, payload: body });
}

async function putPart(f, id, part, bytes) {
  const body = multipart(bytes, "part.bin");
  return f.app.inject({
    method: "PUT",
    url: `/upload-sessions/${id}/parts/${part}`,
    headers: {
      ...f.headers,
      "content-type": body.contentType,
      "content-range": `bytes ${part * 4}-${part * 4 + bytes.length - 1}/8`
    },
    payload: body.payload
  });
}

function oneShot(f, bytes, declared) {
  const body = multipart(bytes);
  return f.app.inject({
    method: "POST",
    url: "/files/upload",
    headers: {
      ...f.headers,
      "content-type": body.contentType,
      ...(declared !== undefined ? { "x-upload-size": String(declared) } : {})
    },
    payload: body.payload
  });
}

function assertNotActive(response) {
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "ACCOUNT_NOT_ACTIVE");
  assert.match(response.json().error.message, /suspended/);
}

test("suspended mid one-shot upload (with x-upload-size): no File commits and the reservation is returned", async (t) => {
  const f = await fixture(t);
  const hold = f.storage.holdWrite();
  const pending = oneShot(f, Buffer.from("abcdefgh"), 8);
  await hold.entered;
  assert.equal((await f.account()).reservedUploadBytes, 8n);

  await f.suspend();
  hold.release();
  assertNotActive(await pending);

  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);
  const account = await f.account();
  assert.equal(account.storageUsed, 0n);
  assert.equal(account.reservedUploadBytes, 0n, "reservation released although the account is suspended");
  const [row] = await prisma.uploadReservation.findMany({ where: { userId: f.user.id } });
  assert.equal(row.state, "RELEASED");
});

test("suspended mid one-shot upload (no x-upload-size): no File, no quota charge", async (t) => {
  const f = await fixture(t);
  const hold = f.storage.holdWrite();
  const pending = oneShot(f, Buffer.from("abcdefgh"));
  await hold.entered;

  await f.suspend();
  hold.release();
  assertNotActive(await pending);

  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);
  const account = await f.account();
  assert.equal(account.storageUsed, 0n);
  assert.equal(account.reservedUploadBytes, 0n);
});

test("suspended while completion assembles: no File, the session returns to UPLOADING and expiry releases its reservation", async (t) => {
  const f = await fixture(t);
  const created = await createSession(f);
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().session.id;
  assert.equal((await putPart(f, id, 0, Buffer.from("abcd"))).statusCode, 201);
  assert.equal((await putPart(f, id, 1, Buffer.from("efgh"))).statusCode, 201);
  assert.equal((await f.account()).reservedUploadBytes, 8n);

  const hold = f.storage.holdAssemble();
  const completing = f.app.inject({ method: "POST", url: `/upload-sessions/${id}/complete`, headers: f.headers, payload: {} });
  await hold.entered;
  await f.suspend();
  hold.release();
  assertNotActive(await completing);

  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);
  const session = await prisma.uploadSession.findUnique({ where: { id } });
  assert.equal(session.status, "UPLOADING", "completion was given back, not left COMPLETING");
  assert.equal(session.fileId, null);
  const held = await f.account();
  assert.equal(held.storageUsed, 0n);
  assert.equal(held.reservedUploadBytes, 8n, "the reservation is still owned by the live session");

  // Expiry for a SUSPENDED account still succeeds and returns the bytes.
  await prisma.uploadSession.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await cleanupUploadSessions(f.storage);
  const after = await f.account();
  assert.equal(after.reservedUploadBytes, 0n);
  assert.equal((await prisma.uploadSession.findUnique({ where: { id } })).status, "EXPIRED");
});

test("a part that would commit after the suspension is refused and leaves no part row", async (t) => {
  const f = await fixture(t);

  // Part: the session exists and is healthy; the PUT is blocked on the owner lock when the suspension lands.
  const created = await createSession(f);
  const id = created.json().session.id;
  const part = await f.suspendWhileBlocked(() => putPart(f, id, 0, Buffer.from("abcd")));
  assertNotActive(part);
  assert.equal(await prisma.uploadPart.count({ where: { sessionId: id } }), 0, "no part row for a suspended account");
});

test("a new upload session that would commit after the suspension is refused and reserves nothing", async (t) => {
  const f = await fixture(t);
  const response = await f.suspendWhileBlocked(() => createSession(f));
  assertNotActive(response);
  assert.equal(await prisma.uploadSession.count({ where: { userId: f.user.id } }), 0);
  assert.equal((await f.account()).reservedUploadBytes, 0n);
});

test("folder creation (plain and idempotent) that commits after the suspension is refused", async (t) => {
  const f = await fixture(t);
  const plain = await f.suspendWhileBlocked(() => f.app.inject({
    method: "POST", url: "/folders", headers: f.headers, payload: { name: "late" }
  }));
  assertNotActive(plain);
  assert.equal(await prisma.folder.count({ where: { userId: f.user.id } }), 0);

  const g = await fixture(t);
  const idem = await g.suspendWhileBlocked(() => g.app.inject({
    method: "POST", url: "/folders", headers: { ...g.headers, "idempotency-key": "late-key" }, payload: { name: "late" }
  }));
  assertNotActive(idem);
  assert.equal(await prisma.folder.count({ where: { userId: g.user.id } }), 0);
  assert.equal(await prisma.idempotencyKey.count({ where: { userId: g.user.id } }), 0, "no claim row survives a refused request");
});

test("a plan change that commits after the suspension is refused (self-service and entitled paths)", async (t) => {
  const f = await fixture(t);
  const response = await f.suspendWhileBlocked(() => f.app.inject({
    method: "PATCH", url: `/plans/${f.otherPlan.id}/subscribe`, headers: f.headers
  }));
  assert.equal(response.statusCode, 403, response.body);
  assert.match(response.json().message, /suspended/);
  assert.equal((await f.account()).planId, f.plan.id);

  // The SQL predicates alone (callers that bypass the route) also refuse.
  assert.equal(await switchPlanIfFits(f.user.id, f.otherPlan.id), null);
  assert.equal(await switchPlanIfEntitled(f.user.id, f.otherPlan.id), null);
  assert.equal((await f.account()).planId, f.plan.id);
});

test("a download token requested in flight is not created for a suspended account", async (t) => {
  const f = await fixture(t);
  const file = await prisma.file.create({
    data: { originalName: "d.bin", storedName: crypto.randomUUID(), mimeType: "x/y", size: 1n, path: "p", checksum: "0".repeat(64), userId: f.user.id }
  });
  const response = await f.suspendWhileBlocked(() => f.app.inject({
    method: "POST", url: `/files/${file.id}/download-token`, headers: f.headers
  }));
  assertNotActive(response);
  assert.equal(await prisma.downloadToken.count({ where: { userId: f.user.id } }), 0);
});

test("quota statements never admit a suspended account, but releasing always works; reactivation restores service", async (t) => {
  const f = await fixture(t);
  const reservation = await createReservation(f.user.id, 100n, 60_000);
  assert.ok(reservation);
  assert.equal((await f.account()).reservedUploadBytes, 100n);

  await f.suspend();
  assert.equal(await reserveUploadQuota(f.user.id, 10n), null);
  assert.equal(await reservePendingUploadQuota(f.user.id, 10n), null);
  assert.equal(await commitUploadReservation(f.user.id, 100n), null);
  await assert.rejects(() => createReservation(f.user.id, 10n, 60_000), (error) => error.code === "ACCOUNT_NOT_ACTIVE");
  assert.equal((await f.account()).reservedUploadBytes, 100n, "refused statements changed nothing");

  // Give-back paths are unconditional.
  assert.equal(await releaseReservation(reservation.id), true);
  assert.equal((await f.account()).reservedUploadBytes, 0n);
  assert.ok(await releaseUploadReservation(f.user.id, 0n));

  await setAccountStatus(f.user.id, "ACTIVE");
  assert.ok(await reserveUploadQuota(f.user.id, 10n), "an ACTIVE account is admitted again");
});

test("lease-lapsed reservations of a suspended account are still reconciled by the sweeper", async (t) => {
  const f = await fixture(t);
  const reservation = await createReservation(f.user.id, 50n, 60_000);
  await prisma.uploadReservation.update({ where: { id: reservation.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
  await f.suspend();
  await reconcileExpiredReservations();
  assert.equal((await f.account()).reservedUploadBytes, 0n);
  assert.equal((await prisma.uploadReservation.findUnique({ where: { id: reservation.id } })).state, "RELEASED");
});

test("race: parallel session creations against a suspension never leak or overspend quota", async (t) => {
  const f = await fixture(t, 100000n);
  const attempts = Array.from({ length: 24 }, (_, i) => (async () => {
    if (i === 8) await f.suspend();
    return createSession(f, { originalName: `r${i}.bin`, mimeType: "x/y", expectedSize: 8 });
  })());
  const responses = await Promise.all(attempts);

  // Requests either pass authentication before the suspension (201 / 403 ACCOUNT_NOT_ACTIVE at commit)
  // or are rejected by authentication (403) afterwards: never anything else.
  for (const response of responses) {
    assert.ok([201, 403].includes(response.statusCode), `${response.statusCode} ${response.body}`);
  }
  const created = responses.filter((response) => response.statusCode === 201).length;
  const sessions = await prisma.uploadSession.findMany({ where: { userId: f.user.id } });
  assert.equal(sessions.length, created, "every 201 has a session and every refusal has none");
  const account = await f.account();
  assert.equal(account.reservedUploadBytes, BigInt(created * 8), "reserved bytes equal the sessions that exist");
  assert.equal(account.status, "SUSPENDED");

  // After the dust settles nothing more can be created.
  assert.notEqual((await createSession(f)).statusCode, 201);
});
