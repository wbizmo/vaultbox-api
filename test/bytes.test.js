const test = require("node:test");
const assert = require("node:assert/strict");

const { formatBytes } = require("../src/lib/bytes");

test("formats bytes without lossy Number conversion", () => {
  assert.equal(formatBytes(0n), "0 B");
  assert.equal(formatBytes(1024n), "1.00 KB");
  assert.equal(formatBytes(1024n ** 3n), "1.00 GB");
  assert.equal(formatBytes(5n * 1024n ** 4n), "5.00 TB");
});
