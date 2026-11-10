"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { percentile } = require("../scripts/benchmark-transfers");

test("latency percentiles are deterministic nearest rank, independent of request completion order", () => {
  const values = [90, 1, 50, 20, 60, 35, 100, 3, 10, 5, 80, 45, 70, 30, 40, 95, 25, 15, 55, 85];
  assert.equal(percentile(values, 0.5), 40);
  assert.equal(percentile(values, 0.95), 95);
  assert.equal(percentile(values, 0.99), 100);
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([0.0004], 0.5), 0);
});
