const test = require("node:test");
const assert = require("node:assert/strict");

const { checkThrottle } = require("../src/lib/throttle");

test("local throttle fallback preserves fixed-window limit semantics", async () => {
  const namespace = `test-${Date.now()}`;
  const identity = "identity";
  const options = { limit: 2, windowSeconds: 60 };

  const first = await checkThrottle(namespace, identity, options);
  const second = await checkThrottle(namespace, identity, options);
  const third = await checkThrottle(namespace, identity, options);

  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.ok(third.retryAfterSeconds > 0);
});
