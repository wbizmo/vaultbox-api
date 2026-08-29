const test = require("node:test");
const assert = require("node:assert/strict");

const { parseSingleRange, rangeHeader } = require("../src/lib/range");

test("parses explicit ranges", () => {
  assert.deepEqual(parseSingleRange("bytes=0-99", 1000n), {
    start: 0n,
    end: 99n,
    length: 100n
  });
});

test("clamps ranges to the file boundary", () => {
  assert.deepEqual(parseSingleRange("bytes=900-2000", 1000n), {
    start: 900n,
    end: 999n,
    length: 100n
  });
});

test("supports open ended ranges", () => {
  assert.deepEqual(parseSingleRange("bytes=500-", 1000n), {
    start: 500n,
    end: 999n,
    length: 500n
  });
});

test("supports suffix ranges", () => {
  assert.deepEqual(parseSingleRange("bytes=-128", 1000n), {
    start: 872n,
    end: 999n,
    length: 128n
  });
});

test("rejects unsatisfiable ranges", () => {
  assert.throws(
    () => parseSingleRange("bytes=1000-1001", 1000n),
    (error) => error.code === "RANGE_NOT_SATISFIABLE"
  );
});

test("formats Content-Range", () => {
  assert.equal(
    rangeHeader({ start: 10n, end: 19n }, 100n),
    "bytes 10-19/100"
  );
});
