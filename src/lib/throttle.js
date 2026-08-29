const { redis } = require("./redis");
const { key } = require("./cache");

const localWindows = new Map();

function localCheck(bucket, limit, windowSeconds) {
  const now = Date.now();
  const current = localWindows.get(bucket);

  if (!current || current.resetAt <= now) {
    localWindows.set(bucket, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: windowSeconds };
  }

  current.count += 1;
  return {
    allowed: current.count <= limit,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

async function checkThrottle(namespace, identity, { limit, windowSeconds }) {
  const bucket = key(`throttle:${namespace}`, identity);

  if (!redis?.isReady) {
    return localCheck(bucket, limit, windowSeconds);
  }

  try {
    const count = await redis.incr(bucket);
    if (count === 1) await redis.expire(bucket, windowSeconds);
    const ttl = await redis.ttl(bucket);

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds
    };
  } catch {
    return localCheck(bucket, limit, windowSeconds);
  }
}

function throttlePreHandler(namespace, options, identityFactory = (request) => request.ip) {
  return async function throttle(request, reply) {
    const identity = String(identityFactory(request) || request.ip);
    const result = await checkThrottle(namespace, identity, options);

    reply.header("X-RateLimit-Remaining", result.remaining);

    if (!result.allowed) {
      reply.header("Retry-After", result.retryAfterSeconds);
      return reply.code(429).send({ message: "Too many requests" });
    }
  };
}

module.exports = {
  checkThrottle,
  throttlePreHandler
};
