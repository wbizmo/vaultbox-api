const test = require("node:test");
const assert = require("node:assert/strict");

const {
  encodeCursor,
  decodeCursor,
  cursorWhere,
  finishCursorPage
} = require("../src/lib/pagination");

const options = { sort: "createdAt", order: "desc", type: "date" };

test("cursor round-trips stable sort metadata", () => {
  const item = { id: "item-1", createdAt: new Date("2026-09-09T00:00:00.000Z") };
  const encoded = encodeCursor(item, options);
  const decoded = decodeCursor(encoded, options);

  assert.equal(decoded.id, item.id);
  assert.equal(decoded.value.toISOString(), item.createdAt.toISOString());
});

test("cursor cannot be reused with a different sort contract", () => {
  const encoded = encodeCursor({ id: "item-1", createdAt: new Date() }, options);
  assert.throws(() => decodeCursor(encoded, { sort: "createdAt", order: "asc", type: "date" }));
});

test("cursor where clause uses the id as a deterministic tie breaker", () => {
  const value = new Date("2026-09-09T00:00:00.000Z");
  assert.deepEqual(cursorWhere({ id: "b", value }, options), {
    OR: [
      { createdAt: { lt: value } },
      { createdAt: value, id: { lt: "b" } }
    ]
  });
});

test("cursor pages fetch one extra row and expose only the requested limit", () => {
  const rows = [
    { id: "c", createdAt: new Date("2026-09-09T03:00:00Z") },
    { id: "b", createdAt: new Date("2026-09-09T02:00:00Z") },
    { id: "a", createdAt: new Date("2026-09-09T01:00:00Z") }
  ];
  const result = finishCursorPage(rows, 2, options);

  assert.equal(result.items.length, 2);
  assert.equal(result.pagination.hasMore, true);
  assert.ok(result.pagination.nextCursor);
});
