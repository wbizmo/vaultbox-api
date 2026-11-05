const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { createDownloadToken, etagForChecksum } = require("../src/lib/download-token");

/*
 * Issue #52 (and the error-reply ordering fix found while testing #48): a download session "starts" only when a
 * GET has opened its stream. HEAD is metadata inspection and never marks usedAt nor emits
 * DOWNLOAD_SESSION_STARTED. Every refusal is a JSON error with the right status (404 / 416 used to surface as 500).
 */

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "download-semantics-secret-long-enough-for-tests",
  jwtExpiresIn: "1h",
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};
const unique = () => crypto.randomUUID().slice(0, 10);
const BYTES = Buffer.from("0123456789abcdefghijklmnopqrstuv"); // 32 bytes

async function fixture(t, { writeBytes = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-dlsem-"));
  const storage = new LocalStorageAdapter(root);
  const plan = await prisma.plan.create({ data: { name: `dl-${unique()}`, priceMonthly: 0, storageLimit: 1000n } });
  const user = await prisma.user.create({ data: { name: "DL", email: `dl-${unique()}@example.com`, password: "x", planId: plan.id } });
  const storedName = crypto.randomUUID();
  const checksum = crypto.createHash("sha256").update(BYTES).digest("hex");
  const file = await prisma.file.create({
    data: { originalName: "range-secret.bin", storedName, mimeType: "application/octet-stream", size: BigInt(BYTES.length), path: storedName, checksum, userId: user.id }
  });
  await storage.ready();
  if (writeBytes) await fs.writeFile(path.join(root, storedName), BYTES);
  const app = buildApp({ logger: false, storage, config });
  await app.ready();

  const newSession = async ({ expiresInMs = 60_000 } = {}) => {
    const token = createDownloadToken();
    const row = await prisma.downloadToken.create({
      data: { token: token.hash, fileId: file.id, userId: user.id, expiresAt: new Date(Date.now() + expiresInMs) }
    });
    return { raw: token.raw, id: row.id, url: `/download/${token.raw}` };
  };
  const state = (session) => prisma.downloadToken.findUnique({ where: { id: session.id } });
  const started = () => prisma.auditLog.count({ where: { userId: user.id, action: "DOWNLOAD_SESSION_STARTED" } });

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.downloadToken.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { app, root, storage, file, user, checksum, etag: etagForChecksum(checksum), newSession, state, started };
}

test("HEAD (plain and ranged) inspects metadata and never starts the session", async (t) => {
  const f = await fixture(t);
  const session = await f.newSession();

  for (let i = 0; i < 3; i += 1) {
    const head = await f.app.inject({ method: "HEAD", url: session.url });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers["content-length"], String(BYTES.length));
    assert.equal(head.headers.etag, f.etag);
    assert.equal(head.headers["accept-ranges"], "bytes");
    assert.ok(head.headers["last-modified"]);
    assert.match(head.headers["content-disposition"], /attachment/);
    assert.equal(head.body, "");
  }
  const rangedHead = await f.app.inject({ method: "HEAD", url: session.url, headers: { range: "bytes=4-11" } });
  assert.equal(rangedHead.statusCode, 206);
  assert.equal(rangedHead.headers["content-range"], `bytes 4-11/${BYTES.length}`);
  assert.equal(rangedHead.headers["content-length"], "8");

  assert.equal((await f.state(session)).usedAt, null, "HEAD leaves usedAt unset");
  assert.equal(await f.started(), 0, "HEAD emits no DOWNLOAD_SESSION_STARTED");

  // The first real GET is the start, once; later GETs and HEADs add nothing.
  const first = await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=0-3" } });
  assert.equal(first.statusCode, 206);
  assert.equal(first.body, "0123");
  assert.ok((await f.state(session)).usedAt);
  assert.equal(await f.started(), 1);
  await f.app.inject({ method: "GET", url: session.url });
  await f.app.inject({ method: "HEAD", url: session.url });
  assert.equal(await f.started(), 1);
});

test("parallel first range GETs emit exactly one start and return the right bytes", async (t) => {
  const f = await fixture(t);
  const session = await f.newSession();
  const ranges = [[0, 7], [8, 15], [16, 23], [24, 31]];
  const responses = await Promise.all(ranges.map(([from, to]) => f.app.inject({
    method: "GET", url: session.url, headers: { range: `bytes=${from}-${to}` }
  })));
  responses.forEach((response, index) => {
    const [from, to] = ranges[index];
    assert.equal(response.statusCode, 206, response.body);
    assert.equal(response.body, BYTES.subarray(from, to + 1).toString());
    assert.equal(response.headers["content-range"], `bytes ${from}-${to}/${BYTES.length}`);
    assert.equal(response.headers.etag, f.etag);
  });
  assert.equal(await f.started(), 1, "exactly one first-download event for four parallel first ranges");
  assert.equal(Buffer.concat(responses.map((r) => r.rawPayload)).toString(), BYTES.toString(), "ranges reassemble the file");
});

test("a full GET, If-Range handling and ETags keep working", async (t) => {
  const f = await fixture(t);
  const session = await f.newSession();

  const full = await f.app.inject({ method: "GET", url: session.url });
  assert.equal(full.statusCode, 200);
  assert.equal(full.rawPayload.toString(), BYTES.toString());
  assert.equal(full.headers["content-length"], String(BYTES.length));
  assert.equal(full.headers.etag, f.etag);
  assert.match(full.headers["content-disposition"], /filename="range-secret\.bin"/);

  const matching = await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=2-5", "if-range": f.etag } });
  assert.equal(matching.statusCode, 206);
  assert.equal(matching.body, "2345");
  const stale = await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=2-5", "if-range": '"sha256-old"' } });
  assert.equal(stale.statusCode, 200, "a stale If-Range falls back to the whole file");
  assert.equal(stale.rawPayload.toString(), BYTES.toString());
});

test("refusals are JSON errors with the right status and never start the session (404 / 416 were 500)", async (t) => {
  const f = await fixture(t);
  const session = await f.newSession();

  // Unsatisfiable range: 416 + Content-Range, JSON body, nothing recorded.
  const unsatisfiable = await f.app.inject({ method: "GET", url: session.url, headers: { range: "bytes=999-1000" } });
  assert.equal(unsatisfiable.statusCode, 416, unsatisfiable.body);
  assert.equal(unsatisfiable.headers["content-range"], `bytes */${BYTES.length}`);
  assert.match(unsatisfiable.headers["content-type"], /application\/json/);
  assert.ok(!unsatisfiable.headers["content-disposition"], "no download headers on an error");
  assert.equal((await f.state(session)).usedAt, null);
  assert.equal(await f.started(), 0);

  // Bytes missing on disk when a GET tries to open them: 404, no start recorded.
  await fs.rm(path.join(f.root, f.file.storedName));
  const missing = await f.app.inject({ method: "GET", url: session.url });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.match(missing.headers["content-type"], /application\/json/);
  assert.deepEqual(missing.json(), { message: "Stored file missing" });
  assert.equal((await f.state(session)).usedAt, null, "a GET that never opened a stream is not a start");
  assert.equal(await f.started(), 0);
  // HEAD notices the same condition.
  assert.equal((await f.app.inject({ method: "HEAD", url: session.url })).statusCode, 404);

  // Unknown, expired and wrong-state sessions.
  assert.equal((await f.app.inject({ method: "GET", url: `/download/${"x".repeat(43)}` })).statusCode, 404);
  const expired = await f.newSession({ expiresInMs: -1000 });
  assert.equal((await f.app.inject({ method: "GET", url: expired.url })).statusCode, 410);
  assert.equal(await f.started(), 0);
});
