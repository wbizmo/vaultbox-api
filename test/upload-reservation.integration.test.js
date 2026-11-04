const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const { Blob } = require("node:buffer");
const FormData = globalThis.FormData;

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { lockUserForUpdate, cleanupUploadSessions } = require("../src/lib/upload-session");
const {
  createReservation,
  commitReservation,
  releaseReservation,
  reconcileExpiredReservations
} = require("../src/lib/upload-reservation");
const { switchPlanIfFits } = require("../src/lib/quota");

const JWT_SECRET = "reservation-test-secret-long-enough-for-tests";
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
  uploadReservationLeaseSeconds: 2,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

/** Holds the next part-less one-shot write open until released. */
class HoldingStorage extends LocalStorageAdapter {
  hold() {
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    this.pending = { gate, entered };
    return { entered: enteredPromise, release };
  }

  createWriteStream(key) {
    const real = super.createWriteStream(key);
    const pending = this.pending;
    this.pending = null;
    if (!pending) return real;
    return new Writable({
      write(chunk, encoding, callback) { real.write(chunk, encoding, callback); },
      final(callback) {
        pending.entered();
        pending.gate.then(() => real.end(callback), callback);
      },
      destroy(error, callback) { real.destroy(error || undefined); callback(error); }
    });
  }
}

function multipartBody(bytes) {
  const boundary = `----vaultbox${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="one.bin"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function fixture(t, storageLimit = 1000n) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-reservation-"));
  const storage = new HoldingStorage(root);
  const plan = await prisma.plan.create({
    data: { name: `resv-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit }
  });
  const user = await prisma.user.create({
    data: { name: "Resv", email: `resv-${crypto.randomUUID()}@example.com`, password: "x", planId: plan.id }
  });
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ id: user.id })}` };

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.uploadReservation.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });

  const upload = (bytes, declared = bytes.length) => {
    const body = multipartBody(bytes);
    return app.inject({
      method: "POST",
      url: "/files/upload",
      headers: { ...headers, "content-type": body.contentType, "x-upload-size": String(declared) },
      payload: body.payload
    });
  };
  const account = () => prisma.user.findUnique({ where: { id: user.id } });
  const rows = () => prisma.uploadReservation.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  const lapse = () => prisma.uploadReservation.updateMany({
    where: { userId: user.id, state: "PENDING" },
    data: { leaseUntil: new Date(Date.now() - 1000) }
  });

  return { app, storage, root, plan, user, headers, upload, account, rows, lapse };
}

test("a healthy upload converts its reservation exactly once and leaves a COMMITTED record", async (t) => {
  const f = await fixture(t);
  const res = await f.upload(Buffer.alloc(100, 7));
  assert.equal(res.statusCode, 201, res.body);
  const [row] = await f.rows();
  assert.equal(row.state, "COMMITTED");
  assert.equal(row.fileId, res.json().file.id);
  const account = await f.account();
  assert.equal(account.storageUsed, 100n);
  assert.equal(account.reservedUploadBytes, 0n);
  assert.equal(await reconcileExpiredReservations(), 0, "nothing to reconcile after a clean commit");
});

test("reservation and quota increment are one transaction; commit and release are exactly-once", async (t) => {
  const f = await fixture(t);

  const first = await createReservation(f.user.id, 40n, 60_000);
  assert.ok(first);
  assert.equal((await f.account()).reservedUploadBytes, 40n);

  // Release wins once; duplicates, and a late commit, change nothing.
  const results = await Promise.all(Array.from({ length: 6 }, () => releaseReservation(first.id)));
  assert.equal(results.filter(Boolean).length, 1, "exactly one release applies");
  assert.equal((await f.account()).reservedUploadBytes, 0n, "released once, never negative");
  const lateCommit = await prisma.$transaction(async (tx) => {
    await lockUserForUpdate(tx, f.user.id);
    return commitReservation(tx, first.id, f.user.id, 40n);
  });
  assert.equal(lateCommit, null);
  let account = await f.account();
  assert.equal(account.storageUsed, 0n);
  assert.equal(account.reservedUploadBytes, 0n);

  // Commit wins once; a later release and a second commit change nothing.
  const second = await createReservation(f.user.id, 30n, 60_000);
  await prisma.$transaction(async (tx) => {
    await lockUserForUpdate(tx, f.user.id);
    assert.ok(await commitReservation(tx, second.id, f.user.id, 30n));
  });
  assert.equal(await releaseReservation(second.id), false);
  const again = await prisma.$transaction(async (tx) => {
    await lockUserForUpdate(tx, f.user.id);
    return commitReservation(tx, second.id, f.user.id, 30n);
  });
  assert.equal(again, null);
  account = await f.account();
  assert.equal(account.storageUsed, 30n);
  assert.equal(account.reservedUploadBytes, 0n);
});

test("concurrent reservations cannot overreserve and pending bytes block an incompatible downgrade", async (t) => {
  const f = await fixture(t, 100n);
  const attempts = await Promise.all(Array.from({ length: 6 }, () => createReservation(f.user.id, 40n, 60_000)));
  assert.equal(attempts.filter(Boolean).length, 2, "only two 40-byte reservations fit in 100 bytes");
  const account = await f.account();
  assert.equal(account.reservedUploadBytes, 80n);
  assert.equal((await f.rows()).filter((row) => row.state === "PENDING").length, 2);

  const small = await prisma.plan.create({
    data: { name: `resv-small-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 50n }
  });
  try {
    assert.equal(await switchPlanIfFits(f.user.id, small.id), null, "80 pending bytes do not fit a 50-byte plan");
    assert.equal((await f.account()).planId, f.plan.id, "the plan did not change");
  } finally {
    await prisma.plan.delete({ where: { id: small.id } });
  }
});

test("a stalled stream's reservation swept by the sweeper makes its commit fail cleanly without double counting", async (t) => {
  const f = await fixture(t);
  const gate = f.storage.hold();
  const inFlight = f.upload(Buffer.alloc(64, 1));
  await gate.entered;

  // An unrelated pending reservation of the same size belongs to the same user. If the swept
  // upload could still commit, it would silently consume THIS reservation's bytes.
  const bystander = await createReservation(f.user.id, 64n, 60_000);
  assert.ok(bystander);
  const stalled = (await f.rows()).find((row) => row.id !== bystander.id);
  assert.equal(stalled.state, "PENDING");
  // The sweeper decided the stalled worker is dead and released its reservation.
  assert.equal(await releaseReservation(stalled.id), true);
  assert.equal((await f.account()).reservedUploadBytes, 64n, "only the bystander's bytes remain reserved");

  gate.release();
  const late = await inFlight;
  assert.equal(late.statusCode, 409, late.body);
  const account = await f.account();
  assert.equal(account.storageUsed, 0n, "the swept upload committed nothing");
  assert.equal(account.reservedUploadBytes, 64n, "the bystander's reservation is untouched");
  assert.equal((await f.rows()).find((row) => row.id === bystander.id).state, "PENDING");
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);
  assert.equal((await fs.readdir(f.root, { withFileTypes: true })).filter((e) => e.isFile()).length, 0, "bytes removed");
});

test("a slow but alive upload keeps its lease via the heartbeat and is never swept", async (t) => {
  const f = await fixture(t);
  const gate = f.storage.hold();
  const inFlight = f.upload(Buffer.alloc(64, 2));
  await gate.entered;

  await new Promise((resolve) => setTimeout(resolve, 3000)); // longer than the 2s lease
  assert.equal(await reconcileExpiredReservations(), 0, "a live heartbeat must keep the lease valid");
  assert.equal((await f.rows())[0].state, "PENDING");

  gate.release();
  const res = await inFlight;
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((await f.account()).storageUsed, 64n);
});

test("the shared upload sweeper also reconciles lapsed one-shot reservations", async (t) => {
  const f = await fixture(t);
  const reservation = await createReservation(f.user.id, 25n, 60_000);
  await f.lapse();
  await cleanupUploadSessions(f.storage);
  assert.equal((await f.rows())[0].state, "RELEASED");
  assert.equal((await f.account()).reservedUploadBytes, 0n);
  assert.ok(reservation);
});

test("requests without x-upload-size still use the compatible final quota path and create no reservation", async (t) => {
  const f = await fixture(t);
  const body = multipartBody(Buffer.alloc(50, 3));
  const res = await f.app.inject({
    method: "POST",
    url: "/files/upload",
    headers: { ...f.headers, "content-type": body.contentType },
    payload: body.payload
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal((await f.rows()).length, 0);
  assert.equal((await f.account()).storageUsed, 50n);
});

// ---------------------------------------------------------------------------------------------
// Real crashes: a child process running the application is SIGKILLed at each phase, then the
// reservation is reconciled. Nothing in the dead process gets to run any cleanup.
// ---------------------------------------------------------------------------------------------

async function crashAt(t, phase) {
  const f = await fixture(t);
  const worker = fork(path.join(__dirname, "..", "scripts", "one-shot-crash-worker.js"), [], {
    env: { ...process.env, PHASE: phase, JWT_SECRET },
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });

  const message = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker never sent the expected message (phase ${phase})`)), 20_000);
    worker.on("message", function onMessage(value) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve(value);
    });
  });

  const listening = message((m) => m.port);
  const { port } = await listening;
  const hit = message((m) => m.reached === phase);

  const bytes = Buffer.alloc(300, 9);
  const form = new FormData();
  form.append("file", new Blob([bytes]), "crash.bin");
  const request = fetch(`http://127.0.0.1:${port}/files/upload`, {
    method: "POST",
    headers: { ...f.headers, "x-upload-size": String(bytes.length) },
    body: form
  }).catch(() => null);

  await hit;
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  worker.kill("SIGKILL");
  await exited;
  await request;

  // PostgreSQL releases the dead worker's locks when it notices the dropped connection.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const free = await prisma.$transaction(async (tx) => {
      try {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${f.user.id} FOR UPDATE NOWAIT`;
        return true;
      } catch {
        return false;
      }
    }).catch(() => false);
    if (free) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { f, size: BigInt(bytes.length) };
}

for (const phase of ["before-stream", "mid-stream", "after-bytes", "in-commit-tx"]) {
  test(`SIGKILL at "${phase}": the reservation survives, is held until its lease lapses, then released exactly once`, async (t) => {
    const { f, size } = await crashAt(t, phase);

    const [row] = await f.rows();
    assert.equal(row.state, "PENDING", "the dead worker never finished or released it");
    let account = await f.account();
    assert.equal(account.reservedUploadBytes, size, "quota is held (and owned by a durable row), not lost");
    assert.equal(account.storageUsed, 0n, "nothing was committed");
    assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);

    // Grace period: a lease that has not lapsed is never swept.
    await prisma.uploadReservation.update({ where: { id: row.id }, data: { leaseUntil: new Date(Date.now() + 60_000) } });
    assert.equal(await reconcileExpiredReservations(), 0);
    assert.equal((await f.account()).reservedUploadBytes, size);

    await f.lapse();
    const swept = await Promise.all([reconcileExpiredReservations(), reconcileExpiredReservations()]);
    assert.equal(swept[0] + swept[1], 1, "two sweepers race; exactly one releases");
    assert.equal(await reconcileExpiredReservations(), 0, "idempotent");
    account = await f.account();
    assert.equal(account.reservedUploadBytes, 0n, "no leaked quota");
    assert.equal(account.storageUsed, 0n);
    assert.equal((await f.rows())[0].state, "RELEASED");
  });
}

test('SIGKILL at "reservation-tx": reservation and quota increment roll back together, nothing leaks', async (t) => {
  const { f } = await crashAt(t, "reservation-tx");
  assert.equal((await f.rows()).length, 0, "the reservation row was never committed");
  assert.equal((await f.account()).reservedUploadBytes, 0n, "and neither was the quota increment");
  assert.equal(await reconcileExpiredReservations(), 0);
});
