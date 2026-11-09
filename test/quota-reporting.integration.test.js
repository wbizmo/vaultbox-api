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
const { reservePendingUploadQuota, releaseUploadReservation, reserveUploadQuota, switchPlanIfFits } = require("../src/lib/quota");

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "quota-reporting-test-secret-long-enough",
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

async function fixture(t, limit = 10n) {
  const id = crypto.randomUUID();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-quota-report-"));
  const plan = await prisma.plan.create({ data: { name: "quota-report-" + id, priceMonthly: 0, storageLimit: limit } });
  const user = await prisma.user.create({
    data: { name: "Quota report", email: "quota-report-" + id + "@example.com", password: "unused", planId: plan.id }
  });
  const app = buildApp({ logger: false, config, storage: new LocalStorageAdapter(root) });
  await app.ready();
  t.after(async () => {
    await app.close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
  });
  const auth = { authorization: "Bearer " + app.jwt.sign({ id: user.id }) };
  const quota = async () => {
    const response = await app.inject({ method: "GET", url: "/quota", headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().quota;
  };
  return { app, plan, user, quota };
}

test("quota reports pending admission and keeps committed-only compatibility", async (t) => {
  const f = await fixture(t);
  const initial = await f.quota();
  assert.equal(initial.availableBytes, "10");
  assert.equal(initial.storageUsed, "0");
  assert.equal(initial.reservedUploadBytes, "0");

  assert.ok(await reservePendingUploadQuota(f.user.id, 7n));
  const reserved = await f.quota();
  assert.equal(reserved.storageUsed, "0");
  assert.equal(reserved.committedStorageUsed, "0");
  assert.equal(reserved.reservedUploadBytes, "7");
  assert.equal(reserved.totalAllocatedBytes, "7");
  assert.equal(reserved.availableBytes, "3");
  assert.equal(reserved.usagePercent, 0);
  assert.equal(reserved.allocatedUsagePercent, 70);

  await releaseUploadReservation(f.user.id, 7n);
  assert.equal((await f.quota()).availableBytes, "10");

  assert.ok(await reserveUploadQuota(f.user.id, 4n));
  assert.ok(await reservePendingUploadQuota(f.user.id, 6n));
  const combined = await f.quota();
  assert.equal(combined.storageUsed, "4");
  assert.equal(combined.reservedUploadBytes, "6");
  assert.equal(combined.totalAllocatedBytes, "10");
  assert.equal(combined.availableBytes, "0");
  assert.equal(combined.usagePercent, 40);
  assert.equal(combined.allocatedUsagePercent, 100);
  await releaseUploadReservation(f.user.id, 6n);
  assert.equal((await f.quota()).availableBytes, "6");
});

test("quota byte counts are precise above Number.MAX_SAFE_INTEGER and never negative", async (t) => {
  const limit = 9007199254741015n;
  const f = await fixture(t, limit);
  await prisma.user.update({
    where: { id: f.user.id },
    data: { storageUsed: 9007199254740993n, reservedUploadBytes: 11n }
  });
  const quota = await f.quota();
  assert.equal(quota.storageUsed, "9007199254740993");
  assert.equal(quota.reservedUploadBytes, "11");
  assert.equal(quota.totalAllocatedBytes, "9007199254741004");
  assert.equal(quota.availableBytes, "11");

  await prisma.user.update({ where: { id: f.user.id }, data: { reservedUploadBytes: 25n } });
  assert.equal((await f.quota()).availableBytes, "0", "legacy over-allocation must never expose negative bytes");
});

test("reservation versus downgrade yields one coherent non-negative account-and-plan snapshot", async (t) => {
  const f = await fixture(t, 100n);
  const small = await prisma.plan.create({
    data: { name: "quota-small-" + crypto.randomUUID(), priceMonthly: 0, storageLimit: 10n }
  });
  t.after(async () => { await prisma.plan.delete({ where: { id: small.id } }); });
  const [reservation, downgrade] = await Promise.all([
    reservePendingUploadQuota(f.user.id, 20n),
    switchPlanIfFits(f.user.id, small.id)
  ]);
  assert.ok(!(reservation && downgrade));
  const quota = await f.quota();
  assert.ok(BigInt(quota.availableBytes) >= 0n);
  assert.equal(BigInt(quota.storageLimit) - BigInt(quota.totalAllocatedBytes), BigInt(quota.availableBytes));
});
