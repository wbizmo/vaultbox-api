"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const prisma = require("../src/lib/prisma");
const {
  cleanupUploadSessions, cleanupSettings, claimCleanupCandidates, getUploadCleanupStats
} = require("../src/lib/upload-session");

async function fixture(t, quantity) {
  const tag = crypto.randomUUID();
  const plan = await prisma.plan.create({
    data: { name: "cleanup-plan-" + tag, priceMonthly: 0, storageLimit: 1000000n }
  });
  const user = await prisma.user.create({
    data: { name: "Cleanup worker", email: "cleanup-" + tag + "@example.invalid", password: "unused", planId: plan.id }
  });
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  const ids = [];
  for (let start = 0; start < quantity; start += 500) {
    const rows = Array.from({ length: Math.min(500, quantity - start) }, (_, i) => ({
      id: "cleanup-" + crypto.randomUUID(),
      userId: user.id, originalName: "old-" + (start + i),
      mimeType: "application/octet-stream", expectedSize: 1n,
      chunkSize: 1, partCount: 1, status: "EXPIRED",
      expiresAt: old, updatedAt: old
    }));
    ids.push(...rows.map((r) => r.id));
    await prisma.uploadSession.createMany({ data: rows });
  }
  t.after(async () => {
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
  });
  return { user, ids, old };
}

test("worker configuration validates bounded batch/concurrency/lease settings", async () => {
  assert.equal(cleanupSettings({}).batchSize, 100);
  assert.equal(cleanupSettings({VAULTBOX_UPLOAD_CLEANUP_CONCURRENCY:"16"}).concurrency, 16);
  assert.throws(() => cleanupSettings({VAULTBOX_UPLOAD_CLEANUP_BATCH_SIZE:"0"}));
  assert.throws(() => cleanupSettings({VAULTBOX_UPLOAD_CLEANUP_CONCURRENCY:"17"}));
  assert.throws(() => cleanupSettings({VAULTBOX_UPLOAD_CLEANUP_LEASE_SECONDS:"5"}));
  await assert.rejects(claimCleanupCandidates(prisma, "invalid", cleanupSettings()));
});

test("two independent workers lease terminal sessions once, retry failed deletes, and never discard active ones", async (t) => {
  const f = await fixture(t, 225);
  const other = new PrismaClient();
  t.after(async () => other.$disconnect());
  const calls = new Map();
  const failureId = f.ids[3];
  let rejectId = failureId;
  const storage = {
    async deleteUploadSessionChunks(id) {
      calls.set(id, (calls.get(id) || 0) + 1);
      if (id === rejectId) throw new Error("INJECTED_STORAGE_OUTAGE");
    }
  };
  const settings = { batchSize: 125, concurrency: 8, leaseSeconds: 60, deleteTimeoutMs: 15000 };

  const [a, b] = await Promise.all([
    cleanupUploadSessions(storage, prisma, settings),
    cleanupUploadSessions(storage, other, settings)
  ]);
  assert.equal(a + b, 0, "terminal-only work must preserve the historic return value");
  assert.equal(calls.size, 225);
  const telemetry = getUploadCleanupStats();
  assert.ok(telemetry);
  assert.ok(Number.isSafeInteger(telemetry.durationMs));
  assert.ok(Number.isSafeInteger(telemetry.retryBacklog));
  for (const [id, n] of calls) assert.equal(n, 1, "duplicate attempt for " + id);
  const completed = await prisma.uploadSession.count({
    where: { id: { in: f.ids }, chunksCleanedAt: { not: null } }
  });
  assert.equal(completed, 224);
  const failed = await prisma.uploadSession.findUnique({ where: { id: failureId } });
  assert.equal(failed.cleanupAttempts, 1);
  assert.ok(failed.cleanupLeaseUntil > new Date());
  assert.equal(failed.cleanupLastError, "STORAGE_CHUNKS_DELETE_FAILED");

  // Leased retry is not picked up early, even by a different process.
  await cleanupUploadSessions(storage, other, settings);
  assert.equal(calls.get(failureId), 1);
  rejectId = null;
  await prisma.uploadSession.update({
    where: { id: failureId },
    data: { cleanupLeaseUntil: new Date(Date.now() - 1000) }
  });
  await cleanupUploadSessions(storage, prisma, settings);
  assert.equal(calls.get(failureId), 2);
  assert.ok((await prisma.uploadSession.findUnique({ where: { id: failureId } })).chunksCleanedAt);
  assert.equal(await prisma.uploadSession.count({
    where: { id: { in: f.ids }, cleanupToken: { not: null } }
  }), 0);

  const live = await prisma.uploadSession.create({
    data: {
      userId: f.user.id, originalName: "active", mimeType: "application/octet-stream",
      expectedSize: 1n, chunkSize: 1, partCount: 1,
      status: "UPLOADING", expiresAt: new Date(Date.now() + 180000)
    }
  });
  await cleanupUploadSessions(storage, prisma, settings);
  assert.equal(calls.get(live.id), undefined);
  assert.equal((await prisma.uploadSession.findUnique({ where: { id: live.id } })).status, "UPLOADING");
});

test("10k terminal backlog drains in bounded ordered batches with two workers", {
  skip: process.env.VAULTBOX_RUN_LARGE_CLEANUP_TEST !== "true",
  timeout: 180000
}, async (t) => {
  const f = await fixture(t, 10000);
  const other = new PrismaClient();
  t.after(async () => other.$disconnect());
  const calls = new Set();
  const storage = {
    async deleteUploadSessionChunks(id) {
      assert.equal(calls.has(id), false, "session must be claimed only once");
      calls.add(id);
    }
  };
  const settings = { batchSize: 250, concurrency: 16, leaseSeconds: 180, deleteTimeoutMs: 30000 };
  await prisma.$executeRawUnsafe('ANALYZE "UploadSession"');
  const planRows = await prisma.$queryRawUnsafe(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT "id" FROM "UploadSession"
    WHERE "status" IN ('COMPLETED'::"UploadSessionStatus",
      'ABORTED'::"UploadSessionStatus", 'EXPIRED'::"UploadSessionStatus")
      AND "chunksCleanedAt" IS NULL AND "updatedAt" <= $1
    ORDER BY "updatedAt", "id" LIMIT 250 FOR UPDATE SKIP LOCKED
  `, new Date(Date.now() - 60000));
  const plan = planRows[0]["QUERY PLAN"][0];
  const nodes = [];
  const walk = (node) => {
    nodes.push({ node: node["Node Type"], index: node["Index Name"] ?? null });
    for (const child of node.Plans || []) walk(child);
  };
  walk(plan.Plan);
  console.log("cleanup 10k query plan (aggregate only):", JSON.stringify({
    executionMs: plan["Execution Time"],
    planningMs: plan["Planning Time"],
    rootNode: plan.Plan["Node Type"],
    nodes,
    rowCount: plan.Plan["Actual Rows"],
    sharedHitBlocks: plan.Plan["Shared Hit Blocks"]
  }));
  let sweeps = 0;
  const began = Date.now();
  while (calls.size < 10000) {
    await Promise.all([
      cleanupUploadSessions(storage, prisma, settings),
      cleanupUploadSessions(storage, other, settings)
    ]);
    if (++sweeps > 80) throw new Error("cleanup made no bounded progress after 80 sweeps");
  }
  assert.equal(calls.size, 10000);
  assert.ok(sweeps <= 40);
  console.log("cleanup 10k worker throughput (aggregate only):", JSON.stringify({
    drained: calls.size, sweeps, durationMs: Date.now() - began
  }));
  assert.equal(await prisma.uploadSession.count({
    where: { id: { in: f.ids }, chunksCleanedAt: { not: null } }
  }), 10000);
});

test("claim lease survives process death, is reclaimed, and releases reserved quota only once", async (t) => {
  const f = await fixture(t, 0);
  const expired = await prisma.uploadSession.create({
    data: {
      userId: f.user.id, originalName: "expired-after-crash",
      mimeType: "application/octet-stream", expectedSize: 15n,
      chunkSize: 15, partCount: 1, status: "UPLOADING", expiresAt: f.old
    }
  });
  await prisma.user.update({
    where: { id: f.user.id }, data: { reservedUploadBytes: 15n }
  });

  const settings = { batchSize: 20, concurrency: 2, leaseSeconds: 60, deleteTimeoutMs: 3000 };
  const claim = await claimCleanupCandidates(prisma, "expired", settings);
  assert.equal(claim.candidates.length, 1);
  assert.equal(claim.candidates[0].id, expired.id);
  const deleted = [];
  const storage = { async deleteUploadSessionChunks(id) { deleted.push(id); } };

  // A second process cannot steal the unexpired lease of a dead first worker.
  const standby = new PrismaClient();
  t.after(async () => standby.$disconnect());
  assert.equal(await cleanupUploadSessions(storage, standby, settings), 0);
  assert.equal((await prisma.uploadSession.findUnique({ where: { id: expired.id } })).status, "UPLOADING");

  // Simulate the first worker being killed and its lease timing out.
  await prisma.uploadSession.update({
    where: { id: expired.id }, data: { cleanupLeaseUntil: new Date(Date.now() - 1000) }
  });
  const [a, b] = await Promise.all([
    cleanupUploadSessions(storage, prisma, settings),
    cleanupUploadSessions(storage, standby, settings)
  ]);
  assert.equal(a + b, 1);
  assert.deepEqual(deleted, [expired.id]);
  const after = await prisma.uploadSession.findUnique({ where: { id: expired.id } });
  assert.equal(after.status, "EXPIRED");
  assert.ok(after.chunksCleanedAt);
  assert.equal(after.cleanupToken, null);
  assert.equal((await prisma.user.findUnique({ where: { id: f.user.id } })).reservedUploadBytes, 0n);
  await cleanupUploadSessions(storage, prisma, settings);
  assert.deepEqual(deleted, [expired.id], "repeated sweep cannot delete twice or re-release quota");
});
