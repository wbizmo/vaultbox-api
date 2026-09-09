const test = require("node:test");
const assert = require("node:assert/strict");

const { reserve, complete } = require("../src/lib/idempotency");
const { checkThrottle } = require("../src/lib/throttle");

test("local idempotency fallback preserves pending and replay semantics", async () => {
  const scope = `test-${Date.now()}`;
  const key = "same-request";
  const payload = { userId: "user-1", name: "folder" };

  const first = await reserve(scope, key, payload, 60);
  assert.equal(first.acquired, true);

  const duplicate = await reserve(scope, key, payload, 60);
  assert.equal(duplicate.acquired, false);
  assert.equal(duplicate.samePayload, true);
  assert.equal(duplicate.inProgress, true);
  assert.equal(duplicate.replay, null);

  const mismatched = await reserve(scope, key, { ...payload, name: "other" }, 60);
  assert.equal(mismatched.acquired, false);
  assert.equal(mismatched.samePayload, false);

  const response = { message: "created", id: "folder-1" };
  await complete(scope, key, payload, response, 60);

  const replay = await reserve(scope, key, payload, 60);
  assert.equal(replay.acquired, false);
  assert.equal(replay.samePayload, true);
  assert.deepEqual(replay.replay, response);
});

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
