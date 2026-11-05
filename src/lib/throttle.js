const crypto = require("node:crypto");
const { clientIp } = require("./client-ip");
const { redis } = require("./redis");
const { key } = require("./cache");
const prisma = require("./prisma");
const { BoundedTtlMap } = require("./bounded-ttl-map");

/*
 * Fixed-window throttling with an explicit degradation policy per route class.
 *
 * Healthy: ONE atomic Redis Lua round trip decides, so limits are global across replicas.
 *
 * Redis down (not ready, or the command failed):
 *   policy "shared" (login, registration, download-token issuance -- abuse-sensitive):
 *     the decision comes from a PostgreSQL fixed-window counter (one atomic upsert), which is still
 *     global across replicas. If PostgreSQL cannot answer either, the request is REFUSED (fail
 *     closed, 503 + Retry-After); a process-local counter is never trusted for these routes because
 *     N replicas would silently admit N times the limit.
 *   policy "local" (everything else): a bounded process-local window. Documented degraded mode:
 *     the limit is per replica until Redis returns.
 *
 * Reconnect hold-down: after any degraded decision for a "shared" route, that route keeps using the
 * PostgreSQL counter until a full window has elapsed, instead of flipping straight back to Redis
 * (whose counters know nothing about the attempts made during the outage). Attempts counted during
 * an outage therefore keep protecting the account after Redis comes back.
 *
 * Known bound: if only SOME replicas lose Redis, the two stores are separate for up to one window,
 * so the effective limit is at most 2x for that window (documented in docs/DEPLOYMENT.md).
 */

const localWindows = new BoundedTtlMap({ maxEntries: 10000, cleanupIntervalMs: 30000 });
const holdDownUntil = new Map(); // namespace -> epoch ms; bounded by the (fixed) number of namespaces

const stats = {
  redisDecisions: 0,
  sharedFallbackDecisions: 0,
  localFallbackDecisions: 0,
  failedClosed: 0,
  lastDegradedAt: null
};

const throttleScript = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

function localCheck(bucket, limit, windowSeconds) {
  const now = Date.now();
  const current = localWindows.get(bucket);

  if (!current) {
    const resetAt = now + windowSeconds * 1000;
    localWindows.set(bucket, { count: 1, resetAt }, windowSeconds * 1000);
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: windowSeconds };
  }

  current.count += 1;
  return {
    allowed: current.count <= limit,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

async function redisCheck(bucket, windowSeconds) {
  const result = await redis.eval(throttleScript, {
    keys: [bucket],
    arguments: [String(windowSeconds)]
  });

  return {
    count: Number(result[0]),
    ttl: Number(result[1])
  };
}

/** Identities (addresses, e-mail addresses) are never stored: every store sees only this digest. */
function identityDigest(namespace, identity) {
  return crypto.createHash("sha256").update(`${namespace}\u0000${identity}`).digest("hex");
}

/** Atomic fixed-window increment in PostgreSQL. The primary key serialises concurrent callers. */
async function sharedCheck(namespace, identity, limit, windowSeconds, client = prisma) {
  const digest = identityDigest(namespace, identity);
  const rows = await client.$queryRaw`
    INSERT INTO "RateLimitWindow" ("key", "count", "expiresAt")
    VALUES (${`${namespace}:${digest}`}, 1, NOW() + (${windowSeconds} * INTERVAL '1 second'))
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitWindow"."expiresAt" <= NOW() THEN 1 ELSE "RateLimitWindow"."count" + 1 END,
      "expiresAt" = CASE WHEN "RateLimitWindow"."expiresAt" <= NOW()
        THEN NOW() + (${windowSeconds} * INTERVAL '1 second')
        ELSE "RateLimitWindow"."expiresAt" END
    RETURNING "count", LEAST(${windowSeconds}, GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("expiresAt" - NOW())))))::int AS "ttl"
  `;
  const count = Number(rows[0].count);
  if (Math.random() < 0.02) pruneExpiredRateLimitWindows(client).catch(() => {});
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Number(rows[0].ttl)
  };
}

/** Bounded cleanup of finished windows (called opportunistically; safe on every replica). */
async function pruneExpiredRateLimitWindows(client = prisma, limit = 500) {
  return client.$executeRaw`
    DELETE FROM "RateLimitWindow"
    WHERE "key" IN (SELECT "key" FROM "RateLimitWindow" WHERE "expiresAt" < NOW() - INTERVAL '1 minute' LIMIT ${limit})
  `;
}

function markDegraded(namespace, windowSeconds) {
  const until = Date.now() + windowSeconds * 1000;
  if ((holdDownUntil.get(namespace) || 0) < until) holdDownUntil.set(namespace, until);
  stats.lastDegradedAt = new Date().toISOString();
}

function failedClosed(windowSeconds) {
  stats.failedClosed += 1;
  return { allowed: false, unavailable: true, remaining: 0, retryAfterSeconds: Math.min(windowSeconds, 5) };
}

async function degradedCheck(namespace, identity, bucket, { limit, windowSeconds, policy }) {
  markDegraded(namespace, windowSeconds);
  if (policy === "shared") {
    try {
      const result = await sharedCheck(namespace, identity, limit, windowSeconds);
      stats.sharedFallbackDecisions += 1;
      return result;
    } catch {
      return failedClosed(windowSeconds);
    }
  }
  stats.localFallbackDecisions += 1;
  return localCheck(bucket, limit, windowSeconds);
}

async function checkThrottle(namespace, identity, { limit, windowSeconds, policy = "local" }) {
  const bucket = key(`throttle:${namespace}`, identityDigest(namespace, identity));
  const options = { limit, windowSeconds, policy };

  // Hold-down: keep counting in the shared store until the window in which Redis failed has passed.
  if (!redis?.isReady) return degradedCheck(namespace, identity, bucket, options);
  if (policy === "shared" && Date.now() < (holdDownUntil.get(namespace) || 0)) {
    return heldCheck(namespace, identity, options);
  }

  try {
    const { count, ttl } = await redisCheck(bucket, windowSeconds);
    stats.redisDecisions += 1;

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: ttl > 0 ? ttl : windowSeconds
    };
  } catch {
    return degradedCheck(namespace, identity, bucket, options);
  }
}

/** Redis is back but the hold-down is active: stay on the shared store without extending the hold-down. */
async function heldCheck(namespace, identity, { limit, windowSeconds }) {
  try {
    const result = await sharedCheck(namespace, identity, limit, windowSeconds);
    stats.sharedFallbackDecisions += 1;
    return result;
  } catch {
    return failedClosed(windowSeconds);
  }
}

/** Process-local view for the protected /metrics endpoint. Contains no identities. */
function getThrottleState() {
  const now = Date.now();
  const holding = [...holdDownUntil.entries()].filter(([, until]) => until > now).map(([namespace]) => namespace);
  return {
    mode: !redis ? "no_redis" : redis.isReady && holding.length === 0 ? "redis" : "degraded",
    redisReady: Boolean(redis?.isReady),
    holdDownNamespaces: holding,
    ...stats,
    localEntries: localWindows.size
  };
}

function throttlePreHandler(namespace, options, identityFactory = (request) => clientIp(request)) {
  return async function throttle(request, reply) {
    const identity = String(identityFactory(request) || clientIp(request));
    const result = await checkThrottle(namespace, identity, options);

    if (result.unavailable) {
      reply.header("Retry-After", result.retryAfterSeconds);
      return reply.code(503).send({ message: "Request limiting is temporarily unavailable; retry shortly" });
    }

    reply.header("X-RateLimit-Remaining", result.remaining);

    if (!result.allowed) {
      reply.header("Retry-After", result.retryAfterSeconds);
      return reply.code(429).send({ message: "Too many requests" });
    }
  };
}

module.exports = {
  checkThrottle,
  throttlePreHandler,
  throttleScript,
  getThrottleState,
  pruneExpiredRateLimitWindows
};
