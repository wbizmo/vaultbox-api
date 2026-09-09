const test = require("node:test");
const assert = require("node:assert/strict");

const { BoundedTtlMap } = require("../src/lib/bounded-ttl-map");

test("removes expired entries without requiring key reuse", async (t) => {
  const cache = new BoundedTtlMap({ maxEntries: 4, cleanupIntervalMs: 5 });
  t.after(() => cache.close());

  cache.set("expired", { value: 1 }, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(cache.size, 0);
});

test("never grows beyond its configured maximum", (t) => {
  const cache = new BoundedTtlMap({ maxEntries: 3, cleanupIntervalMs: 1000 });
  t.after(() => cache.close());

  cache.set("a", 1, 60000);
  cache.set("b", 2, 60000);
  cache.set("c", 3, 60000);
  cache.set("d", 4, 60000);

  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("d"), 4);
});

test("expired capacity is reclaimed before live entries are evicted", (t) => {
  let now = 1000;
  const cache = new BoundedTtlMap({
    maxEntries: 2,
    cleanupIntervalMs: 60000,
    now: () => now
  });
  t.after(() => cache.close());

  cache.set("expired", 1, 10);
  cache.set("live", 2, 1000);
  now = 1020;
  cache.set("new", 3, 1000);

  assert.equal(cache.size, 2);
  assert.equal(cache.get("expired"), undefined);
  assert.equal(cache.get("live"), 2);
  assert.equal(cache.get("new"), 3);
});
