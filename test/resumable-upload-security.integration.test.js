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
  jwtSecret: "resumable-security-test-secret-long-enough",
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

async function user(planId) {
  return prisma.user.create({
    data: {
      name: "Upload Owner",
      email: `owner-${crypto.randomUUID()}@example.com`,
      password: "not-used",
      planId
    }
  });
}

test("expired sessions release quota and another user cannot inspect them", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-upload-security-"));
  const storage = new LocalStorageAdapter(root);
  const plan = await prisma.plan.create({
    data: { name: `security-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 100n }
  });
  const owner = await user(plan.id);
  const stranger = await user(plan.id);
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const ownerAuth = `Bearer ${app.jwt.sign({ id: owner.id })}`;
  const strangerAuth = `Bearer ${app.jwt.sign({ id: stranger.id })}`;

  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: { in: [owner.id, stranger.id] } } });
    await prisma.uploadSession.deleteMany({ where: { userId: { in: [owner.id, stranger.id] } } });
    await prisma.file.deleteMany({ where: { userId: { in: [owner.id, stranger.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });

  const created = await app.inject({
    method: "POST",
    url: "/upload-sessions",
    headers: { authorization: ownerAuth },
    payload: {
      originalName: "expire.bin",
      mimeType: "application/octet-stream",
      expectedSize: 8
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const sessionId = created.json().session.id;

  const hidden = await app.inject({
    method: "GET",
    url: `/upload-sessions/${sessionId}`,
    headers: { authorization: strangerAuth }
  });
  assert.equal(hidden.statusCode, 404);

  await prisma.uploadSession.update({
    where: { id: sessionId },
    data: { expiresAt: new Date(Date.now() - 1000) }
  });
  const expired = await app.inject({
    method: "GET",
    url: `/upload-sessions/${sessionId}`,
    headers: { authorization: ownerAuth }
  });
  assert.equal(expired.statusCode, 200);
  assert.equal(expired.json().session.status, "EXPIRED");

  const persisted = await prisma.user.findUnique({ where: { id: owner.id } });
  assert.equal(persisted.reservedUploadBytes, 0n);
  await assert.rejects(fs.access(storage.resolveUploadSession(sessionId)));
});
