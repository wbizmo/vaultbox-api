const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const prisma = require("../src/lib/prisma");
const {
  decodeCursor,
  cursorWhere,
  cursorOrderBy,
  finishCursorPage
} = require("../src/lib/pagination");

const options = { sort: "createdAt", order: "desc", type: "date" };

test("cursor pagination does not duplicate or skip rows with equal timestamps", async (t) => {
  const user = await prisma.user.create({
    data: {
      name: "Cursor integration test",
      email: `cursor-${crypto.randomUUID()}@example.com`,
      password: "not-used-in-this-test"
    }
  });
  const timestamp = new Date("2026-09-09T00:00:00.000Z");

  await Promise.all(Array.from({ length: 5 }, (_, index) => {
    const storedName = crypto.randomUUID();
    return prisma.file.create({
      data: {
        originalName: `file-${index}.bin`,
        storedName,
        mimeType: "application/octet-stream",
        size: 1n,
        path: storedName,
        userId: user.id,
        createdAt: timestamp
      }
    });
  }));

  t.after(async () => {
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });

  const where = { userId: user.id, status: "ACTIVE" };
  const firstRows = await prisma.file.findMany({
    where,
    orderBy: cursorOrderBy("createdAt", "desc"),
    take: 3
  });
  const first = finishCursorPage(firstRows, 2, options);
  const decoded = decodeCursor(first.pagination.nextCursor, options);

  const secondRows = await prisma.file.findMany({
    where: { AND: [where, cursorWhere(decoded, options)] },
    orderBy: cursorOrderBy("createdAt", "desc"),
    take: 3
  });
  const second = finishCursorPage(secondRows, 2, options);
  const decodedSecond = decodeCursor(second.pagination.nextCursor, options);

  const thirdRows = await prisma.file.findMany({
    where: { AND: [where, cursorWhere(decodedSecond, options)] },
    orderBy: cursorOrderBy("createdAt", "desc"),
    take: 3
  });
  const third = finishCursorPage(thirdRows, 2, options);

  const ids = [...first.items, ...second.items, ...third.items].map((file) => file.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.equal(third.pagination.hasMore, false);
});
