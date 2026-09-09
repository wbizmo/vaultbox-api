const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const prisma = require("../src/lib/prisma");

async function createUser(name) {
  return prisma.user.create({
    data: {
      name,
      email: `search-${crypto.randomUUID()}@example.com`,
      password: "not-used-in-this-test"
    }
  });
}

async function createFile(userId, originalName) {
  const storedName = crypto.randomUUID();
  return prisma.file.create({
    data: {
      originalName,
      storedName,
      mimeType: "application/pdf",
      size: 1n,
      path: storedName,
      userId
    }
  });
}

test("case-insensitive substring file search stays ownership scoped", async (t) => {
  const owner = await createUser("Search Owner");
  const other = await createUser("Other Owner");
  await Promise.all([
    createFile(owner.id, "Quarterly REPORT.PDF"),
    createFile(other.id, "Private report.pdf")
  ]);

  t.after(async () => {
    await prisma.file.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  });

  const files = await prisma.file.findMany({
    where: {
      userId: owner.id,
      status: "ACTIVE",
      originalName: { contains: "report", mode: "insensitive" }
    }
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].originalName, "Quarterly REPORT.PDF");
});

test("trigram and sort indexes are deployed", async () => {
  const rows = await prisma.$queryRaw`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'File_originalName_trgm_idx',
        'User_name_trgm_idx',
        'User_email_trgm_idx',
        'File_userId_status_updatedAt_id_idx',
        'File_userId_status_size_id_idx',
        'File_userId_status_originalName_id_idx'
      )
  `;

  const names = new Set(rows.map((row) => row.indexname));
  for (const expected of [
    "File_originalName_trgm_idx",
    "User_name_trgm_idx",
    "User_email_trgm_idx",
    "File_userId_status_updatedAt_id_idx",
    "File_userId_status_size_id_idx",
    "File_userId_status_originalName_id_idx"
  ]) {
    assert.ok(names.has(expected), `${expected} should exist`);
  }
});

test("file substring query is eligible for the trigram index", async () => {
  const plan = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
    return tx.$queryRawUnsafe(`
      EXPLAIN (FORMAT JSON)
      SELECT * FROM "File"
      WHERE "originalName" ILIKE '%report%'
    `);
  });

  assert.match(JSON.stringify(plan), /File_originalName_trgm_idx/);
});
