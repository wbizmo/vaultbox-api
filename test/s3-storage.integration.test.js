"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { S3Client } = require("@aws-sdk/client-s3");
const prisma = require("../src/lib/prisma");
const buildApp = require("../src/app");
const { S3StorageAdapter } = require("../src/lib/s3-storage");

const endpoint = process.env.VAULTBOX_S3_TEST_ENDPOINT;
const bucket = process.env.VAULTBOX_S3_TEST_BUCKET || "vaultbox-test";
const enabled = !!endpoint;
const config = {
  nodeEnv: "test", isProduction: false, corsOrigins: [],
  jwtSecret: "shared-S3-replica-test-secret-long-enough", jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024, uploadChunkBytes: 4, uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000, uploadSuggestedParallelParts: 4,
  downloadTokenExpiresMinutes: 10, downloadSuggestedPartBytes: 1024, downloadMaxRanges: 4
};

function multipart(bytes) {
  const boundary = "----vaultbox-" + crypto.randomUUID();
  return {
    payload: Buffer.concat([
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"s3.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"),
      bytes,
      Buffer.from("\r\n--" + boundary + "--\r\n")
    ]),
    contentType: "multipart/form-data; boundary=" + boundary
  };
}

function makeAdapter(prefix) {
  const client = new S3Client({
    region: process.env.VAULTBOX_S3_TEST_REGION || "us-east-1",
    endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "S3RVER",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "S3RVER"
    }
  });
  return new S3StorageAdapter({
    client, region: "us-east-1", bucket, prefix, sse: process.env.VAULTBOX_S3_TEST_SSE || null, verifyConditionalWrites: false
  });
}

async function bytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("S3 adapter is durable across client restarts and protects immutable keys", { skip: !enabled }, async () => {
  const prefix = "s3-test-" + crypto.randomUUID();
  const a = makeAdapter(prefix);
  const b = makeAdapter(prefix);
  await Promise.all([a.ready(), b.ready()]);
  const key = "part-" + crypto.randomUUID();
  await pipeline(Readable.from(["persistent-bytes"]), a.createWriteStream(key));
  assert.equal(await b.exists(key), true);
  assert.equal((await bytes(await b.openReadStreamForFile({ storedName: key }, { start: 0, end: 9 }))).toString(), "persistent");
  await assert.rejects(
    pipeline(Readable.from(["overwrite"]), b.createWriteStream(key)),
    { code: "EEXIST" }
  );
  assert.equal((await bytes(await b.openReadStreamForFile({ storedName: key }))).toString(), "persistent-bytes");
  await a.client.destroy();
  const fresh = makeAdapter(prefix);
  assert.equal(await fresh.exists(key), true);
  await fresh.delete(key);
  assert.equal(await b.exists(key), false);
  await Promise.all([fresh.client.destroy(), b.client.destroy()]);
});

test("two VaultBox replicas share S3 parts, completion, range reads, and deletion without double quota", { skip: !enabled }, async (t) => {
  const tag = crypto.randomUUID();
  const prefix = "s3-replicas-" + tag;
  const plan = await prisma.plan.create({
    data: { name: "s3-plan-" + tag, priceMonthly: 0, storageLimit: 1000n }
  });
  const user = await prisma.user.create({
    data: { name: "S3 replica user", email: "s3-replica-" + tag + "@example.com", password: "unused", planId: plan.id }
  });
  const storageA = makeAdapter(prefix);
  const storageB = makeAdapter(prefix);
  const a = buildApp({ config, storage: storageA, logger: false });
  const b = buildApp({ config, storage: storageB, logger: false });
  await Promise.all([a.ready(), b.ready()]);
  t.after(async () => {
    await Promise.allSettled([a.close(), b.close()]);
    await prisma.downloadToken.deleteMany({ where: { userId: user.id } });
    await prisma.uploadReservation.deleteMany({ where: { userId: user.id } });
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.fileDeletion.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await Promise.allSettled([storageA.client.destroy(), storageB.client.destroy()]);
  });
  const auth = { authorization: "Bearer " + a.jwt.sign({ id: user.id }) };
  const input = Buffer.from("hello world");
  const session = await a.inject({
    method: "POST", url: "/upload-sessions", headers: auth,
    payload: { originalName: "shared.bin", mimeType: "application/octet-stream", expectedSize: input.length }
  });
  assert.equal(session.statusCode, 201, session.body);
  const sessionId = session.json().session.id;

  for (let partNumber = 0; partNumber < 3; partNumber++) {
    const from = partNumber * 4;
    const part = input.subarray(from, Math.min(from + 4, input.length));
    const request = partNumber % 2 ? a : b;
    const body = multipart(part);
    const response = await request.inject({
      method: "PUT",
      url: "/upload-sessions/" + sessionId + "/parts/" + partNumber,
      headers: {
        ...auth, "content-type": body.contentType,
        "content-range": "bytes " + from + "-" + (from + part.length - 1) + "/" + input.length
      },
      payload: body.payload
    });
    assert.equal(response.statusCode, 201, response.body);
  }

  const progress = await b.inject({
    method: "GET", url: "/upload-sessions/" + sessionId + "?view=summary", headers: auth
  });
  assert.equal(progress.json().session.missingCount, 0);
  const complete = await b.inject({
    method: "POST", url: "/upload-sessions/" + sessionId + "/complete", headers: auth
  });
  assert.equal(complete.statusCode, 200, complete.body);
  const fileId = complete.json().file.id;
  const quota = await a.inject({ method: "GET", url: "/quota", headers: auth });
  assert.equal(quota.json().quota.storageUsed, String(input.length));
  assert.equal(quota.json().quota.reservedUploadBytes, "0");
  const token = await a.inject({
    method: "POST", url: "/files/" + fileId + "/download-token", headers: auth
  });
  assert.equal(token.statusCode, 200, token.body);
  const raw = token.json().token;
  const range = await b.inject({
    method: "GET", url: "/download/" + raw, headers: { range: "bytes=6-10" }
  });
  assert.equal(range.statusCode, 206, range.body);
  assert.equal(range.rawPayload.toString(), "world");
  const head = await b.inject({ method: "HEAD", url: "/download/" + raw });
  assert.equal(head.statusCode, 200, head.body);
  assert.equal(head.headers["content-length"], String(input.length));

  const destroyed = await a.inject({ method: "DELETE", url: "/files/" + fileId, headers: auth });
  assert.equal(destroyed.statusCode, 200, destroyed.body);
  assert.equal(await storageB.exists(complete.json().file.storedName || (await prisma.file.findUnique({ where: { id: fileId } })).storedName), false);
  assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).storageUsed, 0n);
});

test("large S3 multipart transfer retains exact bytes, checksum and range reads", { skip: !enabled }, async () => {
  const prefix = "large-" + crypto.randomUUID();
  const a = makeAdapter(prefix);
  const b = makeAdapter(prefix);
  const key = "multipart-" + crypto.randomUUID();
  const buffer = crypto.randomBytes(11 * 1024 * 1024 + 19);
  try {
    await Promise.all([a.ready(), b.ready()]);
    await pipeline(Readable.from([buffer]), a.createWriteStream(key));
    const stored = await bytes(await b.openReadStreamForFile({ storedName: key }));
    assert.deepEqual(stored, buffer);
    const range = await bytes(await a.openReadStreamForFile({ storedName: key }, {
      start: 5 * 1024 * 1024 - 11, end: 5 * 1024 * 1024 + 27
    }));
    assert.deepEqual(range, buffer.subarray(5 * 1024 * 1024 - 11, 5 * 1024 * 1024 + 28));
  } finally {
    await b.delete(key).catch(() => {});
    a.client.destroy();
    b.client.destroy();
  }
});

test("unsafe S3 providers that ignore conditional create-only headers fail closed at readiness", { skip: !enabled }, async () => {
  const a = makeAdapter("conditional-probe-" + crypto.randomUUID());
  const strict = new S3StorageAdapter({
    client: a.client, bucket, region: "us-east-1",
    prefix: "conditional-probe-" + crypto.randomUUID(), sse: null,
    verifyConditionalWrites: true
  });
  try {
    await assert.rejects(strict.ready(), /ignored If-None-Match|refusing unsafe/);
  } finally {
    a.client.destroy();
  }
});
