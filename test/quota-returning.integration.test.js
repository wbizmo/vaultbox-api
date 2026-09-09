const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const prisma = require("../src/lib/prisma");
const { reserveUploadQuota } = require("../src/lib/quota");

test("concurrent reservations return their committed storageUsed values", async (t) => {
  const plan = await prisma.plan.create({
    data: {
      name: `returning-${crypto.randomUUID()}`,
      priceMonthly: 0,
      storageLimit: 100n
    }
  });
  const user = await prisma.user.create({
    data: {
      name: "Quota returning test",
      email: `returning-${crypto.randomUUID()}@example.com`,
      password: "not-used",
      planId: plan.id
    }
  });

  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
  });

  const results = await Promise.all([
    reserveUploadQuota(user.id, 20n),
    reserveUploadQuota(user.id, 20n)
  ]);

  assert.ok(results.every(Boolean));
  assert.deepEqual(
    results.map((row) => row.storageUsed).sort((a, b) => Number(a - b)),
    [20n, 40n]
  );
  assert.ok(results.every((row) => row.storageLimit === 100n));

  const persisted = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(persisted.storageUsed, 40n);
});
