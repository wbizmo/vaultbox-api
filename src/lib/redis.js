const { createClient } = require("redis");

const redisUrl = process.env.REDIS_URL?.trim() || null;

const redis = redisUrl
  ? createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
        keepAlive: 5000,
        reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 5), 3000)
      }
    })
  : null;

if (redis) {
  redis.on("error", (error) => {
    console.error("Redis error:", error.message);
  });

  redis.on("reconnecting", () => {
    console.warn("Redis reconnecting");
  });
}

async function connectRedis() {
  if (!redis) {
    return null;
  }

  if (!redis.isOpen) {
    await redis.connect();
  }

  return redis;
}

async function disconnectRedis() {
  if (redis?.isOpen) {
    await redis.quit();
  }
}

function getRedisState() {
  return {
    configured: Boolean(redisUrl),
    open: Boolean(redis?.isOpen),
    ready: Boolean(redis?.isReady)
  };
}

module.exports = {
  redis,
  connectRedis,
  disconnectRedis,
  getRedisState
};
