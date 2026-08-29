const test = require("node:test");
const assert = require("node:assert/strict");

const { parseInteger, parseList, assertRuntimeConfig } = require("../src/config/env");

test("parseInteger clamps unsafe configuration", () => {
  assert.equal(parseInteger("999", 10, { min: 1, max: 100 }), 100);
  assert.equal(parseInteger("0", 10, { min: 1, max: 100 }), 1);
  assert.equal(parseInteger("nope", 10, { min: 1, max: 100 }), 10);
});

test("parseList normalizes comma separated configuration", () => {
  assert.deepEqual(parseList(" https://a.test,https://b.test ,, "), [
    "https://a.test",
    "https://b.test"
  ]);
});

test("production configuration rejects short JWT secrets", () => {
  assert.throws(() => assertRuntimeConfig({
    databaseUrl: "postgresql://example",
    jwtSecret: "short",
    isProduction: true
  }), /JWT_SECRET/);
});
