const { redis } = require("./redis");

const prefix = process.env.REDIS_KEY_PREFIX || "vaultbox";

function key(namespace, value) {
  return `${prefix}:${namespace}:${value}`;
}

async function getJson(namespace, value) {
  if (!redis?.isReady) return null;

  try {
    const raw = await redis.get(key(namespace, value));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setJson(namespace, value, payload, ttlSeconds = 30) {
  if (!redis?.isReady) return false;

  try {
    await redis.set(key(namespace, value), JSON.stringify(payload), { EX: ttlSeconds });
    return true;
  } catch {
    return false;
  }
}

async function del(namespace, value) {
  if (!redis?.isReady) return false;

  try {
    await redis.del(key(namespace, value));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  key,
  getJson,
  setJson,
  del
};
