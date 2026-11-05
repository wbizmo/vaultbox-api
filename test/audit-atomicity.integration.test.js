const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");

/*
 * Issue #48: a committed operation and its audit event can never disagree.
 *
 * The audit store is made to FAIL for real: a trigger on "AuditLog" raises for one user and action, so the
 * insert is rejected inside PostgreSQL (not mocked). Every critical event is written in the same transaction
 * as the change it describes, so the expected outcome of an audit failure is "nothing happened": the client
 * gets an error, no row/quota/byte changed, and a retry succeeds exactly once with exactly one event.
 */

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "audit-atomicity-secret-long-enough-for-tests",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  uploadCompletionLeaseSeconds: 30,
  uploadReservationLeaseSeconds: 30,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

const unique = () => crypto.randomUUID().slice(0, 10);

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

async function listFiles(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(full));
    else found.push(full);
  }
  return found;
}

/** Make audit inserts fail for the given condition (a SQL boolean over NEW). Returns restore(). */
async function breakAudit(t, condition) {
  const name = `audit_break_${unique()}`;
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit store unavailable (injected)'; END $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER "${name}" BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION "${name}"()`
  );
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "AuditLog"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
  };
  t.after(restore);
  return restore;
}

/**
 * Make the COMMIT of any transaction that updates this user fail (a deferred constraint trigger fires at
 * commit, after every statement in the transaction -- including the audit insert -- has already run).
 * If the audit row were written outside that transaction it would survive as an event for a change that
 * never happened.
 */
async function breakCommit(t, userId) {
  const name = `commit_break_${unique()}`;
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit refused (injected)'; END $$`
  );
  await prisma.$executeRawUnsafe(
    `CREATE CONSTRAINT TRIGGER "${name}" AFTER UPDATE ON "User" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."id" = '${userId}') EXECUTE FUNCTION "${name}"()`
  );
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON "User"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${name}"()`);
  };
  t.after(restore);
  return restore;
}

async function fixture(t, { planLimit = 100000n } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-audit-"));
  const storage = new LocalStorageAdapter(root);
  const plan = await prisma.plan.create({ data: { name: `aud-${unique()}`, priceMonthly: 0, storageLimit: planLimit } });
  const otherPlan = await prisma.plan.create({ data: { name: `aud2-${unique()}`, priceMonthly: 0, storageLimit: planLimit * 2n } });
  const user = await prisma.user.create({ data: { name: "Secret Name", email: `aud-${unique()}@example.com`, password: "x", planId: plan.id } });
  const admin = await prisma.user.create({ data: { name: "Adm", email: `audadm-${unique()}@example.com`, password: "x", role: "ADMIN", planId: plan.id } });
  const target = await prisma.user.create({ data: { name: "Tgt", email: `audtgt-${unique()}@example.com`, password: "x", planId: plan.id } });
  const app = buildApp({ logger: false, storage, config });
  await app.ready();
  const bearer = (u) => ({ authorization: `Bearer ${app.jwt.sign({ id: u.id, av: 0 })}` });
  const ids = [user.id, admin.id, target.id];

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { details: { contains: user.id } }] } });
    await prisma.downloadToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.uploadReservation.deleteMany({ where: { userId: { in: ids } } });
    await prisma.uploadPart.deleteMany({ where: { session: { userId: { in: ids } } } });
    await prisma.uploadSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.file.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.plan.deleteMany({ where: { id: { in: [plan.id, otherPlan.id] } } });
    await fs.rm(root, { recursive: true, force: true });
  });

  const account = (u = user) => prisma.user.findUnique({ where: { id: u.id } });
  const events = (action, userId = user.id) => prisma.auditLog.findMany({ where: { action, userId } });
  const upload = (bytes, filename = "one.bin", headers = {}) => {
    const body = multipart(bytes, filename);
    return app.inject({
      method: "POST",
      url: "/files/upload",
      headers: { ...bearer(user), "content-type": body.contentType, ...headers },
      payload: body.payload
    });
  };
  return { app, storage, root, plan, otherPlan, user, admin, target, bearer, account, events, upload };
}

test("one-shot upload: an audit failure rolls the whole upload back; the retry succeeds with exactly one event", async (t) => {
  const f = await fixture(t);
  const restore = await breakAudit(t, `NEW."action" = 'FILE_UPLOADED' AND NEW."userId" = '${f.user.id}'`);

  for (const headers of [{}, { "x-upload-size": "8" }]) {
    const failed = await f.upload(Buffer.from("abcdefgh"), "report-secret.pdf", headers);
    assert.equal(failed.statusCode, 500, `${JSON.stringify(headers)} ${failed.body}`);
    assert.doesNotMatch(failed.body, /injected|audit/i, "no internal detail leaks");
    assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0, "no File without its event");
    const account = await f.account();
    assert.equal(account.storageUsed, 0n);
    assert.equal(account.reservedUploadBytes, 0n, "reservation returned");
    assert.deepEqual(await listFiles(f.root), [], "the streamed bytes were removed");
    assert.equal((await f.events("FILE_UPLOADED")).length, 0);
  }

  await restore();
  const ok = await f.upload(Buffer.from("abcdefgh"), "report-secret.pdf", { "x-upload-size": "8" });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 1);
  assert.equal((await f.account()).storageUsed, 8n);
  const logged = await f.events("FILE_UPLOADED");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].details, `${ok.json().file.id}:8`);
  assert.ok(!logged[0].details.includes("secret"), "no file name in the audit details");
});

test("file delete: an audit failure leaves the file, its quota and its bytes untouched; concurrent duplicates emit one event", async (t) => {
  const f = await fixture(t);
  const ok = await f.upload(Buffer.from("abcdefgh"), "keep.bin");
  assert.equal(ok.statusCode, 201, ok.body);
  const id = ok.json().file.id;

  const restore = await breakAudit(t, `NEW."action" = 'FILE_DELETED' AND NEW."userId" = '${f.user.id}'`);
  const failed = await f.app.inject({ method: "DELETE", url: `/files/${id}`, headers: f.bearer(f.user) });
  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal((await prisma.file.findUnique({ where: { id } })).status, "ACTIVE");
  assert.equal((await f.account()).storageUsed, 8n, "quota not decremented");
  assert.equal((await listFiles(f.root)).length, 1, "bytes not removed");
  assert.equal((await f.events("FILE_DELETED")).length, 0);

  await restore();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.app.inject({ method: "DELETE", url: `/files/${id}`, headers: f.bearer(f.user) })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1, results.map((r) => r.statusCode).join(","));
  assert.equal(results.filter((r) => r.statusCode === 404).length, 4);
  assert.equal((await f.account()).storageUsed, 0n, "quota decremented once");
  const logged = await f.events("FILE_DELETED");
  assert.equal(logged.length, 1, "duplicate deletes emit exactly one event");
  assert.equal(logged[0].details, id);
});

test("a byte-removal failure is a separate best-effort event: the delete outcome stays accurate even if that event fails too", async (t) => {
  const f = await fixture(t);
  const ok = await f.upload(Buffer.from("abcdefgh"), "stuck.bin");
  const id = ok.json().file.id;
  f.storage.deleteFile = async () => { throw new Error("disk unavailable"); };
  await breakAudit(t, `NEW."action" = 'FILE_DELETED_METADATA_ONLY' AND NEW."userId" = '${f.user.id}'`);

  const response = await f.app.inject({ method: "DELETE", url: `/files/${id}`, headers: f.bearer(f.user) });
  assert.equal(response.statusCode, 200, "the committed deletion is reported accurately");
  assert.equal((await prisma.file.findUnique({ where: { id } })).status, "DELETED");
  assert.equal((await f.events("FILE_DELETED")).length, 1, "the critical event exists");
  assert.equal((await f.events("FILE_DELETED_METADATA_ONLY")).length, 0, "the best-effort follow-up was lost without hurting anything");
});

test("resumable upload: create, complete and abort each commit atomically with their event", async (t) => {
  const f = await fixture(t);
  const create = () => f.app.inject({
    method: "POST", url: "/upload-sessions", headers: f.bearer(f.user),
    payload: { originalName: "secret-session.bin", mimeType: "application/octet-stream", expectedSize: 8 }
  });

  // create
  let restore = await breakAudit(t, `NEW."action" = 'UPLOAD_SESSION_CREATED' AND NEW."userId" = '${f.user.id}'`);
  const failedCreate = await create();
  assert.equal(failedCreate.statusCode, 500, failedCreate.body);
  assert.equal(await prisma.uploadSession.count({ where: { userId: f.user.id } }), 0);
  assert.equal((await f.account()).reservedUploadBytes, 0n, "no quota reserved for a session that does not exist");
  await restore();
  const created = await create();
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().session.id;
  assert.equal((await f.events("UPLOAD_SESSION_CREATED")).length, 1);
  assert.ok(!(await f.events("UPLOAD_SESSION_CREATED"))[0].details.includes("secret"));

  // parts
  for (const part of [0, 1]) {
    const bytes = Buffer.from("abcdefgh").subarray(part * 4, part * 4 + 4);
    const body = multipart(bytes, "part.bin");
    const stored = await f.app.inject({
      method: "PUT", url: `/upload-sessions/${id}/parts/${part}`,
      headers: { ...f.bearer(f.user), "content-type": body.contentType, "content-range": `bytes ${part * 4}-${part * 4 + 3}/8` },
      payload: body.payload
    });
    assert.equal(stored.statusCode, 201, stored.body);
  }

  // complete
  restore = await breakAudit(t, `NEW."action" = 'UPLOAD_SESSION_COMPLETED' AND NEW."userId" = '${f.user.id}'`);
  const failedComplete = await f.app.inject({ method: "POST", url: `/upload-sessions/${id}/complete`, headers: f.bearer(f.user), payload: {} });
  assert.equal(failedComplete.statusCode, 500, failedComplete.body);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);
  assert.equal((await prisma.uploadSession.findUnique({ where: { id } })).status, "UPLOADING", "completion handed back, retryable");
  const held = await f.account();
  assert.equal(held.storageUsed, 0n);
  assert.equal(held.reservedUploadBytes, 8n);
  await restore();
  const done = await f.app.inject({ method: "POST", url: `/upload-sessions/${id}/complete`, headers: f.bearer(f.user), payload: {} });
  assert.equal(done.statusCode, 200, done.body);
  const after = await f.account();
  assert.equal(after.storageUsed, 8n, "charged once");
  assert.equal(after.reservedUploadBytes, 0n);
  assert.equal((await f.events("UPLOAD_SESSION_COMPLETED")).length, 1);

  // abort (a second session)
  const second = await create();
  const secondId = second.json().session.id;
  restore = await breakAudit(t, `NEW."action" = 'UPLOAD_SESSION_ABORTED' AND NEW."userId" = '${f.user.id}'`);
  const failedAbort = await f.app.inject({ method: "DELETE", url: `/upload-sessions/${secondId}`, headers: f.bearer(f.user) });
  assert.equal(failedAbort.statusCode, 500, failedAbort.body);
  assert.equal((await prisma.uploadSession.findUnique({ where: { id: secondId } })).status, "UPLOADING", "abort rolled back");
  assert.equal((await f.account()).reservedUploadBytes, 8n, "reservation not released by a rolled-back abort");
  await restore();
  const aborts = await Promise.all(Array.from({ length: 4 }, () => f.app.inject({ method: "DELETE", url: `/upload-sessions/${secondId}`, headers: f.bearer(f.user) })));
  assert.ok(aborts.every((r) => r.statusCode === 200 || r.statusCode === 409), aborts.map((r) => r.statusCode).join(","));
  assert.equal((await f.account()).reservedUploadBytes, 0n, "released once");
  assert.equal((await f.events("UPLOAD_SESSION_ABORTED")).length, 1, "concurrent aborts emit exactly one event");
});

test("first download: the started flag and its event cannot disagree", async (t) => {
  const f = await fixture(t);
  // The download routes still read through the process-wide storage adapter (a single injected adapter is
  // tracked in #56), so point that adapter at this test's directory for the duration of the test.
  const { storage: sharedStorage } = require("../src/lib/storage");
  const original = { root: sharedStorage.root, partsRoot: sharedStorage.partsRoot };
  sharedStorage.root = f.storage.root;
  sharedStorage.partsRoot = f.storage.partsRoot;
  t.after(() => Object.assign(sharedStorage, original));
  // Track every read stream the routes open, to prove none is left open when recording the event fails.
  const opened = [];
  const openRead = sharedStorage.openReadStreamForFile.bind(sharedStorage);
  sharedStorage.openReadStreamForFile = async (...args) => {
    const stream = await openRead(...args);
    opened.push(stream);
    return stream;
  };
  t.after(() => { delete sharedStorage.openReadStreamForFile; });
  const ok = await f.upload(Buffer.from("abcdefgh"), "dl-secret.bin");
  const fileId = ok.json().file.id;
  const token = await f.app.inject({ method: "POST", url: `/files/${fileId}/download-token`, headers: f.bearer(f.user) });
  assert.equal(token.statusCode, 200, token.body);
  assert.equal((await f.events("DOWNLOAD_SESSION_CREATED")).length, 1);
  const url = token.json().downloadUrl;
  const row = () => prisma.downloadToken.findFirst({ where: { userId: f.user.id } });

  const restore = await breakAudit(t, `NEW."action" = 'DOWNLOAD_SESSION_STARTED' AND NEW."userId" = '${f.user.id}'`);
  const failed = await f.app.inject({ method: "GET", url });
  assert.equal(failed.statusCode, 500, "an event that cannot be recorded does not start the session");
  assert.equal(opened.length, 1, "the failing request had opened the file");
  assert.ok(opened.every((stream) => stream.destroyed), "its read stream (and file descriptor) was released");
  assert.equal((await row()).usedAt, null, "usedAt stays unset together with the missing event");
  assert.equal((await f.events("DOWNLOAD_SESSION_STARTED")).length, 0);

  await restore();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.app.inject({ method: "GET", url })));
  assert.ok(results.every((r) => r.statusCode === 200), results.map((r) => `${r.statusCode} ${r.body.slice(0, 200)}`).join(" | "));
  assert.ok((await row()).usedAt, "usedAt set");
  const started = await f.events("DOWNLOAD_SESSION_STARTED");
  assert.equal(started.length, 1, "concurrent first requests emit exactly one event");
  assert.equal(started[0].details, fileId, "no file name in the event");
});

test("registration, admin actions and plan changes commit atomically with their events", async (t) => {
  const f = await fixture(t);

  // registration: no half-created account behind an error
  const remoteAddress = `2001:db8:${unique().slice(0, 4)}::${unique().slice(0, 3)}`;
  const email = `reg-${unique()}@example.com`;
  const register = () => f.app.inject({
    method: "POST", url: "/auth/register", remoteAddress,
    payload: { name: "Reg", email, password: "Correct-Horse-1234" }
  });
  t.after(async () => {
    const created = await prisma.user.findUnique({ where: { email } });
    if (created) {
      await prisma.auditLog.deleteMany({ where: { userId: created.id } });
      await prisma.user.delete({ where: { id: created.id } });
    }
  });
  let restore = await breakAudit(t, `NEW."action" = 'ACCOUNT_REGISTERED' AND NEW."ip" = '${remoteAddress}'`);
  const failedRegister = await register();
  assert.equal(failedRegister.statusCode, 500, failedRegister.body);
  assert.equal(await prisma.user.count({ where: { email } }), 0, "no account without its event");
  await restore();
  const registered = await register();
  assert.equal(registered.statusCode, 201, registered.body);
  assert.equal(await prisma.auditLog.count({ where: { action: "ACCOUNT_REGISTERED", userId: registered.json().user.id } }), 1);

  // admin suspend / reactivate / delete
  const adminCall = (verb, suffix = "") => f.app.inject({
    method: verb, url: `/admin/users/${f.target.id}${suffix}`, headers: f.bearer(f.admin), payload: verb === "DELETE" ? undefined : {}
  });
  restore = await breakAudit(t, `NEW."userId" = '${f.admin.id}' AND NEW."action" IN ('USER_SUSPENDED','USER_REACTIVATED','USER_DELETED')`);
  const before = await f.account(f.target);
  for (const [verb, suffix] of [["PATCH", "/suspend"], ["DELETE", ""]]) {
    const failed = await adminCall(verb, suffix);
    assert.equal(failed.statusCode, 500, `${verb}${suffix} ${failed.body}`);
    const now = await f.account(f.target);
    assert.equal(now.status, "ACTIVE");
    assert.equal(now.authVersion, before.authVersion, "no session revocation without its event");
  }
  await restore();
  const suspended = await adminCall("PATCH", "/suspend");
  assert.equal(suspended.statusCode, 200, suspended.body);
  const events = await f.events("USER_SUSPENDED", f.admin.id);
  assert.equal(events.length, 1);
  assert.ok(!events[0].details.includes(f.target.email), "no e-mail address in the event");
  assert.ok(events[0].details.includes(f.target.id));

  // plan change, both modes
  for (const mode of ["entitled", "demo"]) {
    const planApp = buildApp({ logger: false, storage: f.storage, config: { ...config, planSwitchMode: mode } });
    await planApp.ready();
    t.after(() => planApp.close());
    const planUser = await prisma.user.create({ data: { name: "P", email: `plan-${mode}-${unique()}@example.com`, password: "x", planId: f.plan.id } });
    t.after(async () => {
      await prisma.auditLog.deleteMany({ where: { userId: planUser.id } });
      await prisma.user.delete({ where: { id: planUser.id } });
    });
    const switchPlan = () => planApp.inject({
      method: "PATCH", url: `/plans/${f.otherPlan.id}/subscribe`,
      headers: { authorization: `Bearer ${planApp.jwt.sign({ id: planUser.id, av: 0 })}` }
    });
    restore = await breakAudit(t, `NEW."action" = 'PLAN_CHANGED' AND NEW."userId" = '${planUser.id}'`);
    const failed = await switchPlan();
    assert.equal(failed.statusCode, 500, `${mode} ${failed.body}`);
    assert.equal((await prisma.user.findUnique({ where: { id: planUser.id } })).planId, f.plan.id, `${mode}: plan not changed without its event`);
    await restore();
    const changed = await switchPlan();
    assert.equal(changed.statusCode, 200, `${mode} ${changed.body}`);
    assert.equal((await prisma.user.findUnique({ where: { id: planUser.id } })).planId, f.otherPlan.id);
    assert.equal(await prisma.auditLog.count({ where: { action: "PLAN_CHANGED", userId: planUser.id } }), 1);
  }
});

test("a failure at COMMIT leaves neither the change nor an event (the audit row lives in the same transaction)", async (t) => {
  const f = await fixture(t);

  // one-shot upload
  let restore = await breakCommit(t, f.user.id);
  const failedUpload = await f.upload(Buffer.from("abcdefgh"), "commit.bin");
  assert.equal(failedUpload.statusCode, 500, failedUpload.body);
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);
  assert.equal((await f.events("FILE_UPLOADED")).length, 0, "no event for an upload that did not commit");
  await restore();
  const ok = await f.upload(Buffer.from("abcdefgh"), "commit.bin");
  assert.equal(ok.statusCode, 201, ok.body);
  const id = ok.json().file.id;
  assert.equal((await f.events("FILE_UPLOADED")).length, 1);

  // delete
  restore = await breakCommit(t, f.user.id);
  const failedDelete = await f.app.inject({ method: "DELETE", url: `/files/${id}`, headers: f.bearer(f.user) });
  assert.equal(failedDelete.statusCode, 500, failedDelete.body);
  assert.equal((await prisma.file.findUnique({ where: { id } })).status, "ACTIVE");
  assert.equal((await f.account()).storageUsed, 8n);
  assert.equal((await f.events("FILE_DELETED")).length, 0, "no event for a deletion that did not commit");
  await restore();
  assert.equal((await f.app.inject({ method: "DELETE", url: `/files/${id}`, headers: f.bearer(f.user) })).statusCode, 200);
  assert.equal((await f.events("FILE_DELETED")).length, 1);

  // admin suspension
  restore = await breakCommit(t, f.target.id);
  const failedSuspend = await f.app.inject({ method: "PATCH", url: `/admin/users/${f.target.id}/suspend`, headers: f.bearer(f.admin), payload: {} });
  assert.equal(failedSuspend.statusCode, 500, failedSuspend.body);
  assert.equal((await f.account(f.target)).status, "ACTIVE");
  assert.equal((await f.events("USER_SUSPENDED", f.admin.id)).length, 0, "no event for a suspension that did not commit");
  await restore();
});

test("login is written before any credential exists: an audit failure issues no token", async (t) => {
  const f = await fixture(t);
  const bcrypt = require("bcryptjs");
  const password = "Correct-Horse-1234";
  await prisma.user.update({ where: { id: f.user.id }, data: { password: await bcrypt.hash(password, 4) } });
  const login = () => f.app.inject({ method: "POST", url: "/auth/login", remoteAddress: `2001:db8:${unique().slice(0, 4)}::1`, payload: { email: f.user.email, password } });

  const restore = await breakAudit(t, `NEW."action" = 'LOGIN' AND NEW."userId" = '${f.user.id}'`);
  const failed = await login();
  assert.equal(failed.statusCode, 500, failed.body);
  assert.ok(!failed.body.includes("token"), "no token was issued");
  await restore();
  const ok = await login();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);
  assert.equal((await f.events("LOGIN")).length, 1);
});

test("the audit helpers: details are bounded; the best-effort writer never throws and logs the failure", async () => {
  const { auditData, recordAuditBestEffort, MAX_DETAILS } = require("../src/lib/audit");
  assert.equal(auditData({ action: "X", details: "y".repeat(5000) }).details.length, MAX_DETAILS);
  assert.deepEqual(auditData({ action: "X" }), { action: "X", userId: null, ip: null, details: null });

  const logged = [];
  const failing = { auditLog: { create: async () => { throw new Error("store down"); } } };
  const result = await recordAuditBestEffort(failing, { action: "X" }, { error: (...args) => logged.push(args) });
  assert.equal(result, false);
  assert.equal(logged.length, 1);
  assert.equal(await recordAuditBestEffort({ auditLog: { create: async () => ({}) } }, { action: "X" }), true);
});
