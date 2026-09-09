const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { reservePendingUploadQuota } = require("../src/lib/quota");

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "resumable-upload-test-secret-long-enough",
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

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function multipart(buffer, filename = "part.bin") {
  const boundary = `----vaultbox-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function makeFixture(t, storageLimit = 1024n) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-upload-"));
  const storage = new LocalStorageAdapter(root);
  const plan = await prisma.plan.create({
    data: {
      name: `upload-${crypto.randomUUID()}`,
      priceMonthly: 0,
      storageLimit
    }
  });
  const user = await prisma.user.create({
    data: {
      name: "Resumable Upload Test",
      email: `upload-${crypto.randomUUID()}@example.com`,
      password: "not-used",
      planId: plan.id
    }
  });
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const authorization = `Bearer ${app.jwt.sign({ id: user.id })}`;

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.downloadToken.deleteMany({ where: { userId: user.id } });
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.plan.deleteMany({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });

  return { app, storage, user, plan, authorization };
}

async function createSession(fixture, bytes, name = "resume.bin") {
  const response = await fixture.app.inject({
    method: "POST",
    url: "/upload-sessions",
    headers: { authorization: fixture.authorization },
    payload: {
      originalName: name,
      mimeType: "application/octet-stream",
      expectedSize: bytes.length,
      checksum: sha256(bytes)
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().session;
}

async function putPart(fixture, session, partNumber, bytes, checksum = sha256(bytes), rangeOverride) {
  const start = BigInt(partNumber * session.chunkSize);
  const end = start + BigInt(bytes.length) - 1n;
  const body = multipart(bytes);
  return fixture.app.inject({
    method: "PUT",
    url: `/upload-sessions/${session.id}/parts/${partNumber}`,
    headers: {
      authorization: fixture.authorization,
      "content-type": body.contentType,
      "content-range": rangeOverride || `bytes ${start}-${end}/${session.expectedSize}`,
      ...(checksum ? { "x-chunk-sha256": checksum } : {})
    },
    payload: body.payload
  });
}

test("interrupted upload resumes missing parts, retries idempotently, and assembles exact bytes", async (t) => {
  const fixture = await makeFixture(t);
  const bytes = Buffer.from("hello world");
  const session = await createSession(fixture, bytes);
  assert.equal(session.partCount, 3);

  assert.equal((await putPart(fixture, session, 0, bytes.subarray(0, 4))).statusCode, 201);
  assert.equal((await putPart(fixture, session, 2, bytes.subarray(8))).statusCode, 201);

  const progress = await fixture.app.inject({
    method: "GET",
    url: `/upload-sessions/${session.id}`,
    headers: { authorization: fixture.authorization }
  });
  assert.equal(progress.statusCode, 200);
  assert.deepEqual(progress.json().session.missingParts, [1]);

  const middle = bytes.subarray(4, 8);
  assert.equal((await putPart(fixture, session, 1, middle)).statusCode, 201);
  const replay = await putPart(fixture, session, 1, middle);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers["idempotent-replay"], "true");

  const complete = await fixture.app.inject({
    method: "POST",
    url: `/upload-sessions/${session.id}/complete`,
    headers: { authorization: fixture.authorization }
  });
  assert.equal(complete.statusCode, 200, complete.body);
  const result = complete.json();
  assert.equal(result.file.size, String(bytes.length));
  assert.equal(result.file.checksum, sha256(bytes));
  assert.equal(result.quota.reservedUploadBytes, "0");

  const file = await prisma.file.findUnique({ where: { id: result.file.id } });
  assert.deepEqual(await fs.readFile(fixture.storage.resolve(file.storedName)), bytes);
  const user = await prisma.user.findUnique({ where: { id: fixture.user.id } });
  assert.equal(user.storageUsed, BigInt(bytes.length));
  assert.equal(user.reservedUploadBytes, 0n);

  const again = await fixture.app.inject({
    method: "POST",
    url: `/upload-sessions/${session.id}/complete`,
    headers: { authorization: fixture.authorization }
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().file.id, result.file.id);
});

test("malformed ranges and corrupt chunks are rejected without creating parts", async (t) => {
  const fixture = await makeFixture(t);
  const bytes = Buffer.from("abcdefgh");
  const session = await createSession(fixture, bytes, "invalid.bin");
  const first = bytes.subarray(0, 4);

  const range = await putPart(fixture, session, 0, first, sha256(first), `bytes 1-4/${bytes.length}`);
  assert.equal(range.statusCode, 400);

  const checksum = await putPart(fixture, session, 0, first, "0".repeat(64));
  assert.equal(checksum.statusCode, 422);
  assert.equal(await prisma.uploadPart.count({ where: { sessionId: session.id } }), 0);
});

test("quota reservation prevents oversubscribed sessions and abort releases capacity", async (t) => {
  const fixture = await makeFixture(t, 10n);
  const first = await createSession(fixture, Buffer.alloc(7), "first.bin");

  const second = await fixture.app.inject({
    method: "POST",
    url: "/upload-sessions",
    headers: { authorization: fixture.authorization },
    payload: {
      originalName: "second.bin",
      mimeType: "application/octet-stream",
      expectedSize: 7
    }
  });
  assert.equal(second.statusCode, 413);

  const aborted = await fixture.app.inject({
    method: "DELETE",
    url: `/upload-sessions/${first.id}`,
    headers: { authorization: fixture.authorization }
  });
  assert.equal(aborted.statusCode, 200);
  const user = await prisma.user.findUnique({ where: { id: fixture.user.id } });
  assert.equal(user.reservedUploadBytes, 0n);

  const afterAbort = await fixture.app.inject({
    method: "POST",
    url: "/upload-sessions",
    headers: { authorization: fixture.authorization },
    payload: {
      originalName: "after.bin",
      mimeType: "application/octet-stream",
      expectedSize: 7
    }
  });
  assert.equal(afterAbort.statusCode, 201, afterAbort.body);
});

test("concurrent completion creates one file and charges quota once", async (t) => {
  const fixture = await makeFixture(t);
  const bytes = Buffer.from("12345678");
  const session = await createSession(fixture, bytes, "concurrent.bin");
  assert.equal((await putPart(fixture, session, 0, bytes.subarray(0, 4))).statusCode, 201);
  assert.equal((await putPart(fixture, session, 1, bytes.subarray(4))).statusCode, 201);

  const [left, right] = await Promise.all([
    fixture.app.inject({
      method: "POST",
      url: `/upload-sessions/${session.id}/complete`,
      headers: { authorization: fixture.authorization }
    }),
    fixture.app.inject({
      method: "POST",
      url: `/upload-sessions/${session.id}/complete`,
      headers: { authorization: fixture.authorization }
    })
  ]);

  assert.ok([200, 409].includes(left.statusCode), left.body);
  assert.ok([200, 409].includes(right.statusCode), right.body);
  assert.ok(left.statusCode === 200 || right.statusCode === 200);
  assert.equal(await prisma.file.count({
    where: { userId: fixture.user.id, originalName: "concurrent.bin" }
  }), 1);
  const user = await prisma.user.findUnique({ where: { id: fixture.user.id } });
  assert.equal(user.storageUsed, BigInt(bytes.length));
  assert.equal(user.reservedUploadBytes, 0n);
});

test("concurrent reservation primitive admits only quota that fits", async (t) => {
  const fixture = await makeFixture(t, 10n);
  const [a, b] = await Promise.all([
    reservePendingUploadQuota(fixture.user.id, 7n),
    reservePendingUploadQuota(fixture.user.id, 7n)
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const user = await prisma.user.findUnique({ where: { id: fixture.user.id } });
  assert.equal(user.reservedUploadBytes, 7n);
});
