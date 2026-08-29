const crypto = require("crypto");
const { redis } = require("./redis");
const { key } = require("./cache");

const local = new Map();

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

async function reserve(scope, idempotencyKey, payload, ttlSeconds = 300) {
  if (!idempotencyKey) return { acquired: true, token: null };

  const normalized = String(idempotencyKey).trim().slice(0, 160);
  const redisKey = key(`idempotency:${scope}`, normalized);
  const token = fingerprint(payload);

  if (redis?.isReady) {
    const acquired = await redis.set(redisKey, token, { NX: true, EX: ttlSeconds });
    if (acquired) return { acquired: true, token };

    const existing = await redis.get(redisKey);
    return { acquired: false, token: existing, samePayload: existing === token };
  }

  const now = Date.now();
  const existing = local.get(redisKey);
  if (existing && existing.expiresAt > now) {
    return { acquired: false, token: existing.token, samePayload: existing.token === token };
  }

  local.set(redisKey, { token, expiresAt: now + ttlSeconds * 1000 });
  return { acquired: true, token };
}

module.exports = {
  fingerprint,
  reserve
};
