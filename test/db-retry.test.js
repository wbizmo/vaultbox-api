const test = require("node:test");
const assert = require("node:assert/strict");

const { retryOnConflict, isRetryableConflict } = require("../src/lib/db-retry");

const noSleep = async () => {};

test("deadlock and serialization errors are classified as retryable", () => {
  assert.equal(isRetryableConflict({ code: "P2034" }), true);
  assert.equal(isRetryableConflict({ code: "40P01" }), true);
  assert.equal(isRetryableConflict({ meta: { code: "40001" } }), true);
  assert.equal(isRetryableConflict(new Error("ERROR: deadlock detected")), true);
  assert.equal(isRetryableConflict({ code: "P2002" }), false);
  assert.equal(isRetryableConflict(new Error("boom")), false);
  assert.equal(isRetryableConflict(null), false);
});

test("retryOnConflict retries a bounded number of times with growing jittered delays", async () => {
  const delays = [];
  let calls = 0;
  const result = await retryOnConflict(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    return "ok";
  }, { sleep: async (ms) => delays.push(ms), baseDelayMs: 10 });

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[0] >= 10 && delays[0] < 20);
  assert.ok(delays[1] >= 20 && delays[1] < 30);
});

test("retryOnConflict gives up after the attempt limit and never retries other errors", async () => {
  let calls = 0;
  await assert.rejects(
    retryOnConflict(async () => {
      calls += 1;
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    }, { attempts: 3, sleep: noSleep }),
    /deadlock detected/
  );
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    retryOnConflict(async () => {
      calls += 1;
      throw new Error("validation failed");
    }, { sleep: noSleep }),
    /validation failed/
  );
  assert.equal(calls, 1);
});
