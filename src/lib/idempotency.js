const crypto = require("crypto");
const { redis } = require("./redis");
const { key } = require("./cache");
const { BoundedTtlMap } = require("./bounded-ttl-map");

const local = new BoundedTtlMap({ maxEntries: 10000, cleanupIntervalMs: 30000 });

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function storageKey(scope, idempotencyKey) {
  const normalized = String(idempotencyKey).trim().slice(0, 160);
  return key(`idempotency:${scope}`, normalized);
}

async function reserve(scope, idempotencyKey, payload, ttlSeconds = 300) {
  if (!idempotencyKey) return { acquired: true, idempotencyKey: null };

  const redisKey = storageKey(scope, idempotencyKey);
  const payloadFingerprint = fingerprint(payload);
  const pending = JSON.stringify({ fingerprint: payloadFingerprint, state: "pending" });

  if (redis?.isReady) {
    const acquired = await redis.set(redisKey, pending, { NX: true, EX: ttlSeconds });
    if (acquired) return { acquired: true, idempotencyKey, fingerprint: payloadFingerprint };

    const existingRaw = await redis.get(redisKey);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    return {
      acquired: false,
      samePayload: existing?.fingerprint === payloadFingerprint,
      inProgress: existing?.state === "pending",
      replay: existing?.state === "complete" ? existing.response : null
    };
  }

  const existing = local.get(redisKey);
  if (existing) {
    return {
      acquired: false,
      samePayload: existing.fingerprint === payloadFingerprint,
      inProgress: existing.state === "pending",
      replay: existing.state === "complete" ? existing.response : null
    };
  }

  local.set(redisKey, {
    fingerprint: payloadFingerprint,
    state: "pending"
  }, ttlSeconds * 1000);

  return { acquired: true, idempotencyKey, fingerprint: payloadFingerprint };
}

async function complete(scope, idempotencyKey, payload, response, ttlSeconds = 300) {
  if (!idempotencyKey) return;

  const redisKey = storageKey(scope, idempotencyKey);
  const record = {
    fingerprint: fingerprint(payload),
    state: "complete",
    response
  };

  if (redis?.isReady) {
    await redis.set(redisKey, JSON.stringify(record), { EX: ttlSeconds });
    return;
  }

  local.set(redisKey, record, ttlSeconds * 1000);
}

module.exports = {
  fingerprint,
  reserve,
  complete
};
