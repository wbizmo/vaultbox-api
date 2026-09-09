const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const prisma = require("../src/lib/prisma");
const { reserveUploadQuota, switchPlanIfFits } = require("../src/lib/quota");

async function createPlan(storageLimit) {
  return prisma.plan.create({
    data: {
      name: `quota-${storageLimit}-${crypto.randomUUID()}`,
      priceMonthly: 0,
      storageLimit
    }
  });
}

async function createUser(planId, storageUsed = 0n) {
  return prisma.user.create({
    data: {
      name: "Quota race test",
      email: `quota-${crypto.randomUUID()}@example.com`,
      password: "not-used-in-this-test",
      planId,
      storageUsed
    }
  });
}

test("upload reservation and plan downgrade cannot violate the current plan limit", async (t) => {
  const large = await createPlan(100n);
  const small = await createPlan(10n);
  const user = await createUser(large.id);

  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.plan.deleteMany({ where: { id: { in: [large.id, small.id] } } });
  });

  const [reserved, switched] = await Promise.all([
    reserveUploadQuota(user.id, 20n),
    switchPlanIfFits(user.id, small.id)
  ]);

  const persisted = await prisma.user.findUnique({
    where: { id: user.id },
    include: { plan: true }
  });

  assert.ok(!(reserved && switched), "upload and incompatible downgrade must not both commit");
  assert.ok(persisted.storageUsed <= persisted.plan.storageLimit);

  if (reserved) {
    assert.equal(persisted.storageUsed, 20n);
    assert.equal(persisted.planId, large.id);
    assert.equal(reserved.storageLimit, 100n);
  } else {
    assert.equal(switched.planId, small.id);
    assert.equal(persisted.storageUsed, 0n);
    assert.equal(persisted.planId, small.id);
  }
});

test("quota reservation always evaluates the plan that is current at execution time", async (t) => {
  const large = await createPlan(100n);
  const small = await createPlan(10n);
  const user = await createUser(large.id);

  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.plan.deleteMany({ where: { id: { in: [large.id, small.id] } } });
  });

  const switched = await switchPlanIfFits(user.id, small.id);
  assert.ok(switched);

  const reservation = await reserveUploadQuota(user.id, 20n);
  assert.equal(reservation, null);

  const persisted = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(persisted.planId, small.id);
  assert.equal(persisted.storageUsed, 0n);
});

test("plan downgrade rejects usage above the target limit without changing plan", async (t) => {
  const large = await createPlan(100n);
  const small = await createPlan(10n);
  const user = await createUser(large.id, 20n);

  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.plan.deleteMany({ where: { id: { in: [large.id, small.id] } } });
  });

  const switched = await switchPlanIfFits(user.id, small.id);
  assert.equal(switched, null);

  const persisted = await prisma.user.findUnique({ where: { id: user.id } });
  assert.equal(persisted.planId, large.id);
  assert.equal(persisted.storageUsed, 20n);
});
