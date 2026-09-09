const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const prisma = require("../src/lib/prisma");
const { softDeleteFileWithQuota } = require("../src/lib/file-delete");

async function createUser(storageUsed) {
  return prisma.user.create({
    data: {
      name: "Delete race test",
      email: `delete-${crypto.randomUUID()}@example.com`,
      password: "not-used-in-this-test",
      storageUsed
    }
  });
}

async function createFile(userId, size) {
  const storedName = crypto.randomUUID();
  return prisma.file.create({
    data: {
      originalName: "race.bin",
      storedName,
      mimeType: "application/octet-stream",
      size,
      path: storedName,
      userId
    }
  });
}

test("concurrent deletes decrement quota exactly once", async (t) => {
  const user = await createUser(40n);
  const file = await createFile(user.id, 40n);

  t.after(async () => {
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });

  const results = await Promise.all([
    softDeleteFileWithQuota(user.id, file.id),
    softDeleteFileWithQuota(user.id, file.id)
  ]);

  assert.equal(results.filter(Boolean).length, 1);

  const [persistedUser, persistedFile] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id } }),
    prisma.file.findUnique({ where: { id: file.id } })
  ]);

  assert.equal(persistedUser.storageUsed, 0n);
  assert.equal(persistedFile.status, "DELETED");
});

test("atomic delete enforces ownership in the state-changing query", async (t) => {
  const owner = await createUser(10n);
  const attacker = await createUser(0n);
  const file = await createFile(owner.id, 10n);

  t.after(async () => {
    await prisma.file.deleteMany({ where: { userId: owner.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, attacker.id] } } });
  });

  const deleted = await softDeleteFileWithQuota(attacker.id, file.id);
  assert.equal(deleted, null);

  const [persistedOwner, persistedFile] = await Promise.all([
    prisma.user.findUnique({ where: { id: owner.id } }),
    prisma.file.findUnique({ where: { id: file.id } })
  ]);

  assert.equal(persistedOwner.storageUsed, 10n);
  assert.equal(persistedFile.status, "ACTIVE");
});
