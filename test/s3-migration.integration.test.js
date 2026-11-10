"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");
const { S3StorageAdapter } = require("../src/lib/s3-storage");
const { S3Client } = require("@aws-sdk/client-s3");
const { optionsFromArgs, migrate } = require("../scripts/migrate-local-to-s3");

test("migration arguments default to dry-run, cap batch, and reject competing modes", () => {
  assert.deepEqual(optionsFromArgs([]), {
    apply: false, verifyOnly: false, limit: 500, after: "", userId: null
  });
  assert.equal(optionsFromArgs(["--apply", "--limit=15", "--user-id=user1"]).limit, 15);
  assert.throws(() => optionsFromArgs(["--apply", "--verify-only"]));
  assert.throws(() => optionsFromArgs(["--limit=0"]));
  assert.throws(() => optionsFromArgs(["--unknown"]));
});

test("local-to-S3 cutover is dry-run by default, verifies checksums, refuses active uploads, and never deletes originals", {
  skip: !process.env.VAULTBOX_S3_TEST_ENDPOINT
}, async (t) => {
  const tag = crypto.randomUUID();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-migrate-"));
  const local = new LocalStorageAdapter(root);
  await local.ready();
  const client = new S3Client({
    region: "us-east-1", endpoint: process.env.VAULTBOX_S3_TEST_ENDPOINT,
    forcePathStyle: true, maxAttempts: 1,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "S3RVER",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "S3RVER"
    }
  });
  const remote = new S3StorageAdapter({
    client, region: "us-east-1", bucket: process.env.VAULTBOX_S3_TEST_BUCKET || "vaultbox-test",
    prefix: "migration-" + tag, sse: null, verifyConditionalWrites: false
  });
  const plan = await prisma.plan.create({
    data: { name: "migration-" + tag, priceMonthly: 0, storageLimit: 2000n }
  });
  const user = await prisma.user.create({
    data: { name: "Migration tester", email: "migrate-" + tag + "@example.com", password: "unused", planId: plan.id }
  });
  const storedName = "copy-" + tag;
  const body = Buffer.from("a verified migration must never remove local bytes");
  await fs.writeFile(local.resolve(storedName), body);
  const file = await prisma.file.create({
    data: {
      userId: user.id, originalName: "backup.bin", storedName, path: storedName,
      mimeType: "application/octet-stream", size: BigInt(body.length),
      checksum: crypto.createHash("sha256").update(body).digest("hex")
    }
  });
  t.after(async () => {
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await remote.delete(storedName).catch(() => {});
    client.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  const options = { local, remote, userId: user.id, limit: 10 };
  assert.equal((await migrate(options)).wouldCopy, 1);
  assert.equal(await remote.existsFile(file), false);
  await assert.rejects(migrate({ ...options, verifyOnly: true }), /Missing S3 file/);

  const blocking = await prisma.uploadSession.create({
    data: {
      userId: user.id, originalName: "in-flight", mimeType: "application/octet-stream",
      expectedSize: 10n, chunkSize: 10, partCount: 1, status: "UPLOADING",
      expiresAt: new Date(Date.now() + 60000)
    }
  });
  await assert.rejects(migrate({ ...options, apply: true }), /Cannot migrate with active sessions/);
  await prisma.uploadSession.delete({ where: { id: blocking.id } });

  const applied = await migrate({ ...options, apply: true });
  assert.equal(applied.copied, 1);
  assert.equal(applied.scanned, 1);
  const verified = await migrate({ ...options, verifyOnly: true });
  assert.equal(verified.verified, 1);
  assert.equal((await migrate({ ...options, apply: true })).verified, 1);
  assert.deepEqual(await fs.readFile(local.resolve(storedName)), body, "original must survive");
  const unchanged = await prisma.file.findUnique({ where: { id: file.id } });
  assert.equal(unchanged.size, BigInt(body.length));
});
