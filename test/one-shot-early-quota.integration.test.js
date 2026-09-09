const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "one-shot-quota-test-secret-long-enough",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: 1024,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};

class CountingStorage extends LocalStorageAdapter {
  constructor(root) {
    super(root);
    this.writeCalls = 0;
  }

  createWriteStream(key) {
    this.writeCalls += 1;
    return super.createWriteStream(key);
  }
}

function multipart(buffer) {
  const boundary = `----vaultbox-${crypto.randomUUID()}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        "Content-Disposition: form-data; name=\"file\"; filename=\"upload.bin\"\r\n" +
        "Content-Type: application/octet-stream\r\n\r\n"
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

async function fixture(t, storageLimit) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-one-shot-"));
  const storage = new CountingStorage(root);
  const plan = await prisma.plan.create({
    data: {
      name: `one-shot-${crypto.randomUUID()}`,
      priceMonthly: 0,
      storageLimit
    }
  });
  const user = await prisma.user.create({
    data: {
      name: "One Shot Upload Test",
      email: `one-shot-${crypto.randomUUID()}@example.com`,
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

  return { app, storage, user, authorization };
}

async function upload(fx, bytes, declaredSize) {
  const body = multipart(bytes);
  return fx.app.inject({
    method: "POST",
    url: "/files/upload",
    headers: {
      authorization: fx.authorization,
      "content-type": body.contentType,
      ...(declaredSize === undefined ? {} : { "x-upload-size": String(declaredSize) })
    },
    payload: body.payload
  });
}

async function account(userId) {
  return prisma.user.findUnique({ where: { id: userId } });
}

test("insufficient declared quota is rejected before any storage write", async (t) => {
  const fx = await fixture(t, 5n);
  const response = await upload(fx, Buffer.alloc(7), 7);

  assert.equal(response.statusCode, 413, response.body);
  assert.equal(fx.storage.writeCalls, 0);
  assert.equal(await prisma.file.count({ where: { userId: fx.user.id } }), 0);
  const user = await account(fx.user.id);
  assert.equal(user.storageUsed, 0n);
  assert.equal(user.reservedUploadBytes, 0n);
});

test("successful declared upload converts reservation into storageUsed", async (t) => {
  const fx = await fixture(t, 20n);
  const bytes = Buffer.from("data");
  const response = await upload(fx, bytes, bytes.length);

  assert.equal(response.statusCode, 201, response.body);
  const user = await account(fx.user.id);
  assert.equal(user.storageUsed, BigInt(bytes.length));
  assert.equal(user.reservedUploadBytes, 0n);
  assert.equal(fx.storage.writeCalls, 1);
});

test("short body mismatch releases the early reservation and removes bytes", async (t) => {
  const fx = await fixture(t, 20n);
  const response = await upload(fx, Buffer.from("data"), 5);

  assert.equal(response.statusCode, 422, response.body);
  const user = await account(fx.user.id);
  assert.equal(user.storageUsed, 0n);
  assert.equal(user.reservedUploadBytes, 0n);
  assert.equal(await prisma.file.count({ where: { userId: fx.user.id } }), 0);
});

test("body beyond declared size truncates early and releases the reservation", async (t) => {
  const fx = await fixture(t, 20n);
  const response = await upload(fx, Buffer.from("abcde"), 4);

  assert.equal(response.statusCode, 413, response.body);
  const user = await account(fx.user.id);
  assert.equal(user.storageUsed, 0n);
  assert.equal(user.reservedUploadBytes, 0n);
  assert.equal(await prisma.file.count({ where: { userId: fx.user.id } }), 0);
});

test("concurrent declared uploads cannot both consume capacity that fits only one", async (t) => {
  const fx = await fixture(t, 10n);
  const bytes = Buffer.alloc(7, 1);
  const [left, right] = await Promise.all([
    upload(fx, bytes, bytes.length),
    upload(fx, bytes, bytes.length)
  ]);

  assert.deepEqual([left.statusCode, right.statusCode].sort(), [201, 413]);
  const user = await account(fx.user.id);
  assert.equal(user.storageUsed, 7n);
  assert.equal(user.reservedUploadBytes, 0n);
  assert.equal(await prisma.file.count({ where: { userId: fx.user.id } }), 1);
});

test("clients without x-upload-size keep the compatible final quota path", async (t) => {
  const fx = await fixture(t, 20n);
  const bytes = Buffer.from("legacy");
  const response = await upload(fx, bytes);

  assert.equal(response.statusCode, 201, response.body);
  const user = await account(fx.user.id);
  assert.equal(user.storageUsed, BigInt(bytes.length));
  assert.equal(user.reservedUploadBytes, 0n);
});
