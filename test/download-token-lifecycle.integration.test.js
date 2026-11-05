const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { hashDownloadToken } = require("../src/lib/download-token");
const { revokeSessions } = require("../src/lib/account");
const { snapshotMetrics } = require("../src/lib/metrics");

/*
 * Issue #51: the download bearer-token lifecycle. Sessions can be revoked (one, all for a file, or by "log out
 * everywhere"); revoked/expired sessions cannot begin new transfers (410) while a stream that is already open
 * runs to completion; the bearer value never reaches application logs, audit rows or metrics.
 */

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "download-lifecycle-secret-long-enough-for-tests",
  jwtExpiresIn: "1h",
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};
const unique = () => crypto.randomUUID().slice(0, 10);
const SMALL = Buffer.from("0123456789abcdefghijklmnopqrstuv");
const LARGE = crypto.randomBytes(32 * 1024 * 1024);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-dllife-"));
  const lines = [];
  const logStream = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
  const storage = new LocalStorageAdapter(root);
  const plan = await prisma.plan.create({ data: { name: `dl-${unique()}`, priceMonthly: 0, storageLimit: 100_000_000n } });
  const mkUser = (label) => prisma.user.create({ data: { name: label, email: `${label}-${unique()}@example.com`, password: "x", planId: plan.id } });
  const alice = await mkUser("alice");
  const bob = await mkUser("bob");
  const mkFile = async (user, bytes, name) => {
    const storedName = crypto.randomUUID();
    await fs.writeFile(path.join(root, storedName), bytes);
    return prisma.file.create({
      data: {
        originalName: name, storedName, mimeType: "application/octet-stream", size: BigInt(bytes.length), path: storedName,
        checksum: crypto.createHash("sha256").update(bytes).digest("hex"), userId: user.id
      }
    });
  };
  const aliceFile = await mkFile(alice, SMALL, "a.bin");
  const aliceFile2 = await mkFile(alice, SMALL, "a2.bin");
  const aliceLarge = await mkFile(alice, LARGE, "big.bin");
  const bobFile = await mkFile(bob, SMALL, "b.bin");
  await storage.ready();
  const app = buildApp({ logger: { level: "info", stream: logStream }, storage, config });
  await app.ready();

  const auth = async (user) => {
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    return { authorization: `Bearer ${app.jwt.sign({ id: user.id, email: user.email, role: row.role, av: row.authVersion })}` };
  };
  const issue = async (user, file) => {
    const res = await app.inject({ method: "POST", url: `/files/${file.id}/download-token`, headers: await auth(user) });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    return { id: body.id, raw: body.token, url: body.downloadUrl };
  };
  const revoke = async (user, session) =>
    app.inject({ method: "DELETE", url: `/download-sessions/${session.id}`, headers: await auth(user) });
  const users = [alice.id, bob.id];

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: { in: users } } });
    await prisma.downloadToken.deleteMany({ where: { userId: { in: users } } });
    await prisma.file.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { app, alice, bob, aliceFile, aliceFile2, aliceLarge, bobFile, auth, issue, revoke, lines, users };
}

test("revoking a session stops new transfers of every kind; it is owner-only and idempotent", async (t) => {
  const f = await fixture(t);
  const session = await f.issue(f.alice, f.aliceFile);
  const other = await f.issue(f.alice, f.aliceFile);
  assert.ok(session.id && session.id !== session.raw, "the response names the session by a non-secret id");

  assert.equal((await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=0-3" } })).statusCode, 206);

  // Not owner, not logged in, unknown id.
  assert.equal((await f.revoke(f.bob, session)).statusCode, 404);
  assert.equal((await f.app.inject({ method: "DELETE", url: `/download-sessions/${session.id}` })).statusCode, 401);
  assert.equal((await f.revoke(f.alice, { id: "nope" })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "GET", url: session.url })).statusCode, 200, "still valid after refused attempts");

  const res = await f.revoke(f.alice, session);
  assert.equal(res.statusCode, 204);
  for (const probe of [
    { method: "GET", url: session.url },
    { method: "GET", url: session.url, headers: { range: "bytes=4-7" } },
    { method: "HEAD", url: session.url }
  ]) {
    const refused = await f.app.inject(probe);
    assert.equal(refused.statusCode, 410, `${probe.method} ${probe.headers?.range ?? ""}`);
    if (probe.method === "GET") assert.deepEqual(refused.json(), { message: "Download token has been revoked" });
  }
  assert.equal((await f.app.inject({ method: "GET", url: other.url })).statusCode, 200, "sibling session unaffected");

  // Idempotent: a second revoke succeeds and adds no second audit row.
  assert.equal((await f.revoke(f.alice, session)).statusCode, 204);
  const events = await prisma.auditLog.findMany({ where: { action: "DOWNLOAD_SESSION_REVOKED", userId: f.alice.id } });
  assert.deepEqual(events.map((e) => e.details), [session.id]);
});

test("revoking all sessions of a file only touches the owner's sessions for that file", async (t) => {
  const f = await fixture(t);
  const a1 = await f.issue(f.alice, f.aliceFile);
  const a2 = await f.issue(f.alice, f.aliceFile);
  const keep = await f.issue(f.alice, f.aliceFile2);
  const bobs = await f.issue(f.bob, f.bobFile);

  const crossUser = await f.app.inject({ method: "DELETE", url: `/files/${f.bobFile.id}/download-sessions`, headers: await f.auth(f.alice) });
  assert.deepEqual(crossUser.json(), { revoked: 0 });
  assert.equal((await f.app.inject({ method: "GET", url: bobs.url })).statusCode, 200, "another user's session is untouchable");

  const res = await f.app.inject({ method: "DELETE", url: `/files/${f.aliceFile.id}/download-sessions`, headers: await f.auth(f.alice) });
  assert.deepEqual(res.json(), { revoked: 2 });
  assert.equal((await f.app.inject({ method: "GET", url: a1.url })).statusCode, 410);
  assert.equal((await f.app.inject({ method: "GET", url: a2.url })).statusCode, 410);
  assert.equal((await f.app.inject({ method: "GET", url: keep.url })).statusCode, 200);
  assert.equal(await prisma.auditLog.count({ where: { action: "DOWNLOAD_SESSION_REVOKED", userId: f.alice.id } }), 2);

  const again = await f.app.inject({ method: "DELETE", url: `/files/${f.aliceFile.id}/download-sessions`, headers: await f.auth(f.alice) });
  assert.deepEqual(again.json(), { revoked: 0 });
});

test("\"log out everywhere\" (revokeSessions) also kills the user's download sessions, atomically", async (t) => {
  const f = await fixture(t);
  const mine = await f.issue(f.alice, f.aliceFile);
  const expired = await f.issue(f.alice, f.aliceFile2);
  await prisma.downloadToken.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const bobs = await f.issue(f.bob, f.bobFile);

  await revokeSessions(f.alice.id);
  assert.equal((await f.app.inject({ method: "GET", url: mine.url })).statusCode, 410);
  assert.equal((await f.app.inject({ method: "GET", url: bobs.url })).statusCode, 200, "other users keep their sessions");
  const rows = await prisma.downloadToken.findMany({ where: { id: { in: [mine.id, expired.id] } } });
  assert.ok(rows.find((r) => r.id === mine.id).revokedAt);
  assert.equal(rows.find((r) => r.id === expired.id).revokedAt, null, "already-expired rows are left alone");
});

test("an expired session cannot begin a transfer (410) even before the sweeper runs", async (t) => {
  const f = await fixture(t);
  const session = await f.issue(f.alice, f.aliceFile);
  await prisma.downloadToken.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await f.app.inject({ method: "GET", url: session.url })).statusCode, 410);
  assert.equal((await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=0-1" } })).statusCode, 410);
});

function slowGet(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: url, headers }, (res) => {
      const chunks = [];
      let paused = false;
      res.on("data", (chunk) => {
        chunks.push(chunk);
        if (!paused) {
          paused = true;
          res.pause();
          resolve({ res, chunks, resume: () => res.resume(), done: new Promise((r, j) => { res.on("end", () => r(Buffer.concat(chunks))); res.on("error", j); }) });
        }
      });
    });
    req.on("error", reject);
  });
}

test("a stream already open survives revocation and expiry; only new requests are refused", async (t) => {
  const f = await fixture(t);
  await f.app.listen({ port: 0, host: "127.0.0.1" });
  const port = f.app.server.address().port;

  for (const ending of ["revoke", "expire"]) {
    const session = await f.issue(f.alice, f.aliceLarge);
    const open = await slowGet(port, session.url);
    assert.equal(open.res.statusCode, 200);

    if (ending === "revoke") assert.equal((await f.revoke(f.alice, session)).statusCode, 204);
    else await prisma.downloadToken.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    try {
      // New requests (including another range of the same transfer) are refused ...
      const refused = await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=0-9" } });
      assert.equal(refused.statusCode, 410, ending);
    } catch (error) {
      open.res.destroy();
      throw error;
    }
    // ... while the transfer that was already underway completes with every byte.
    open.resume();
    const body = await open.done;
    assert.equal(Buffer.compare(body, LARGE), 0, `${ending}: the open transfer delivered the whole file`);
  }
});

test("parallel ranges and ETag handling are unchanged for a live session", async (t) => {
  const f = await fixture(t);
  const session = await f.issue(f.alice, f.aliceFile);
  const parts = await Promise.all([[0, 7], [8, 15], [16, 23], [24, 31]].map(([a, b]) =>
    f.app.inject({ method: "GET", url: session.url, headers: { range: `bytes=${a}-${b}` } })));
  assert.ok(parts.every((p) => p.statusCode === 206));
  assert.equal(Buffer.concat(parts.map((p) => p.rawPayload)).toString(), SMALL.toString());
  const etag = parts[0].headers.etag;
  assert.match(etag, /^"sha256-/);
  const ifRange = await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=0-3", "if-range": etag } });
  assert.equal(ifRange.statusCode, 206);
});

test("download responses and refusals are never cached and never leak a referrer", async (t) => {
  const f = await fixture(t);
  const session = await f.issue(f.alice, f.aliceFile);
  const live = await f.app.inject({ method: "GET", url: session.url });
  assert.equal(live.headers["cache-control"], "private, no-store");
  assert.equal(live.headers["referrer-policy"], "no-referrer");
  await f.revoke(f.alice, session);
  for (const url of [session.url, `/download/${"z".repeat(43)}`]) {
    const refused = await f.app.inject({ method: "GET", url });
    assert.equal(refused.headers["referrer-policy"], "no-referrer");
    assert.ok(!/public|max-age=[1-9]/.test(refused.headers["cache-control"] || ""), "refusals are not publicly cacheable");
  }
});

test("the bearer value never appears in application logs, audit rows or metrics", async (t) => {
  const f = await fixture(t);
  const session = await f.issue(f.alice, f.aliceFile);
  const secrets = [session.raw, hashDownloadToken(session.raw)];

  await f.app.inject({ method: "GET", url: session.url });
  await f.app.inject({ method: "GET", url: `${session.url}?x=1` });
  await f.app.inject({ method: "HEAD", url: session.url });
  await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=999-1000" } }); // 416
  await f.app.inject({ method: "GET", url: `${session.url}/extra` }); // no such route
  await f.app.inject({ method: "GET", url: "/download/short" }); // schema validation error
  await f.revoke(f.alice, session);
  await f.app.inject({ method: "GET", url: session.url }); // 410 revoked
  // A storage failure must not log the URL either.
  const real = f.app.vaultboxStorage.openReadStreamForFile;
  const live = await f.issue(f.alice, f.aliceFile2);
  secrets.push(live.raw, hashDownloadToken(live.raw));
  f.app.vaultboxStorage.openReadStreamForFile = async () => { throw new Error("boom"); };
  assert.equal((await f.app.inject({ method: "GET", url: live.url })).statusCode, 500);
  f.app.vaultboxStorage.openReadStreamForFile = real;

  const logs = f.lines.join("");
  assert.ok(logs.includes("/download/[redacted]"), "download requests are logged, redacted");
  assert.ok(logs.includes("request completed"));
  for (const secret of secrets) assert.ok(!logs.includes(secret), "no raw token or token hash in application logs");

  const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { userId: { in: f.users } } }));
  assert.ok(audit.includes("DOWNLOAD_SESSION_STARTED") && audit.includes("DOWNLOAD_SESSION_REVOKED"));
  for (const secret of secrets) assert.ok(!audit.includes(secret), "no raw token or token hash in audit rows");

  const metrics = JSON.stringify(snapshotMetrics());
  for (const secret of secrets) assert.ok(!metrics.includes(secret), "no raw token or token hash in metrics");
});
