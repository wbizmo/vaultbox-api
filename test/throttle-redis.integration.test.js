const test = require("node:test");
const assert = require("node:assert/strict");

const { redis, connectRedis, disconnectRedis } = require("../src/lib/redis");
const { checkThrottle } = require("../src/lib/throttle");

test("Redis-backed throttle uses one eval round trip and preserves fixed-window semantics", async (t) => {
  await connectRedis();
  t.after(async () => disconnectRedis());

  const namespace = `redis-test-${Date.now()}`;
  const identity = "client";
  const originalEval = redis.eval.bind(redis);
  let evalCalls = 0;
  redis.eval = async (...args) => {
    evalCalls += 1;
    return originalEval(...args);
  };
  t.after(() => {
    redis.eval = originalEval;
  });

  const first = await checkThrottle(namespace, identity, { limit: 2, windowSeconds: 30 });
  assert.equal(evalCalls, 1);
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 1);
  assert.ok(first.retryAfterSeconds > 0);

  const second = await checkThrottle(namespace, identity, { limit: 2, windowSeconds: 30 });
  assert.equal(evalCalls, 2);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);

  const third = await checkThrottle(namespace, identity, { limit: 2, windowSeconds: 30 });
  assert.equal(evalCalls, 3);
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);

  const keys = await redis.keys(`vaultbox:throttle:${namespace}:*`);
  assert.equal(keys.length, 1);
  assert.ok(await redis.ttl(keys[0]) > 0);
  await redis.del(keys);
});
