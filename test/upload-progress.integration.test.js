"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../src/lib/prisma");
const buildApp = require("../src/app");
const { LocalStorageAdapter } = require("../src/lib/storage");

const config = {
  nodeEnv: "test", isProduction: false, corsOrigins: [],
  jwtSecret: "upload-progress-test-secret-long-enough", jwtExpiresIn: "1h",
  maxUploadBytes: 20 * 1024 * 1024, uploadChunkBytes: 1,
  uploadSessionExpiresMinutes: 60, uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4, downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024, downloadMaxRanges: 4
};

async function fixture(t, partCount) {
  const tag = crypto.randomUUID();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-progress-"));
  const plan = await prisma.plan.create({
    data: { name: "progress-" + tag, priceMonthly: 0, storageLimit: 2000000n }
  });
  const user = await prisma.user.create({
    data: { name: "Progress tester", email: "progress-" + tag + "@example.com", password: "unused", planId: plan.id }
  });
  const session = await prisma.uploadSession.create({
    data: {
      userId: user.id, originalName: "many-parts.dat", mimeType: "application/octet-stream",
      expectedSize: BigInt(partCount), chunkSize: 1, partCount,
      status: "UPLOADING", expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });
  const app = buildApp({ logger: false, config, storage: new LocalStorageAdapter(root) });
  await app.ready();
  t.after(async () => {
    await app.close();
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });
  const auth = { authorization: "Bearer " + app.jwt.sign({ id: user.id }) };
  const progress = async (query = "") => {
    const response = await app.inject({
      method: "GET", url: "/upload-sessions/" + session.id + query, headers: auth
    });
    assert.equal(response.statusCode, 200, response.body);
    return { session: response.json().session, bytes: Buffer.byteLength(response.body) };
  };
  const add = async (partNumber) => prisma.uploadPart.create({
    data: {
      sessionId: session.id, partNumber, offset: BigInt(partNumber),
      size: 1n, checksum: "a".repeat(64), storedName: crypto.randomUUID()
    }
  });
  return { app, session, user, auth, progress, add };
}

test("legacy progress and bounded page/summary handle zero, gaps and changing parts", async (t) => {
  const f = await fixture(t, 10);
  const empty = (await f.progress("?view=summary")).session;
  assert.equal(empty.uploadedCount, 0);
  assert.equal(empty.missingCount, 10);
  assert.ok(!Object.hasOwn(empty, "uploadedParts"));

  await Promise.all([f.add(0), f.add(3), f.add(9)]);
  const first = (await f.progress("?view=page&limit=2")).session;
  assert.deepEqual(first.uploadedParts.map((p) => p.partNumber), [0, 3]);
  assert.deepEqual(first.partsPage, {
    afterPart: -1, limit: 2, hasMore: true, nextAfterPart: 3
  });
  assert.equal(first.uploadedCount, 3);
  assert.equal(first.missingCount, 7);

  await f.add(5);
  const second = (await f.progress("?view=page&limit=2&afterPart=3")).session;
  assert.deepEqual(second.uploadedParts.map((p) => p.partNumber), [5, 9]);
  assert.equal(second.partsPage.hasMore, false);
  assert.equal(second.uploadedCount, 4);

  const legacy = (await f.progress()).session;
  assert.deepEqual(legacy.uploadedParts.map((p) => p.partNumber), [0, 3, 5, 9]);
  assert.deepEqual(legacy.missingParts, [1, 2, 4, 6, 7, 8]);

  await assert.rejects(f.add(3), /unique/i);
  assert.equal((await f.progress("?view=summary")).session.uploadedCount, 4);
});

test("10,000-part upload has bounded progress pages with complete incremental traversal", async (t) => {
  const f = await fixture(t, 10000);
  for (let first = 0; first < 10000; first += 500) {
    const data = Array.from({ length: 500 }, (_, i) => ({
      sessionId: f.session.id, partNumber: first + i,
      offset: BigInt(first + i), size: 1n,
      checksum: "a".repeat(64), storedName: crypto.randomUUID()
    }));
    await prisma.uploadPart.createMany({ data });
  }

  const summary = (await f.progress("?view=summary")).session;
  assert.equal(summary.uploadedCount, 10000);
  assert.equal(summary.missingCount, 0);
  let after = -1;
  let total = 0;
  let pages = 0;
  while (true) {
    const response = await f.progress("?view=page&limit=100&afterPart=" + after);
    assert.ok(response.bytes < 25000, "each page must have bounded transfer cost");
    const { uploadedParts, partsPage } = response.session;
    total += uploadedParts.length;
    pages += 1;
    if (!partsPage.hasMore) break;
    after = partsPage.nextAfterPart;
  }
  assert.equal(total, 10000);
  assert.equal(pages, 100);
});

test("progress cannot reveal a foreign user's upload session", async (t) => {
  const f = await fixture(t, 2);
  const otherPlan = await prisma.plan.create({
    data: { name: "other-" + crypto.randomUUID(), priceMonthly: 0, storageLimit: 100n }
  });
  const other = await prisma.user.create({
    data: {
      name: "Other", email: "other-" + crypto.randomUUID() + "@example.com",
      password: "unused", planId: otherPlan.id
    }
  });
  t.after(async () => {
    await prisma.user.delete({ where: { id: other.id } });
    await prisma.plan.delete({ where: { id: otherPlan.id } });
  });
  for (const query of ["", "?view=summary", "?view=page&limit=1"]) {
    const response = await f.app.inject({
      method: "GET",
      url: "/upload-sessions/" + f.session.id + query,
      headers: { authorization: "Bearer " + f.app.jwt.sign({ id: other.id }) }
    });
    assert.equal(response.statusCode, 404);
  }
});
