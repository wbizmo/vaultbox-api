const { createClient } = require("redis");

const rawRedisUrl = process.env.REDIS_URL;
const redisUrl = rawRedisUrl?.startsWith("redis://")
  ? rawRedisUrl.replace("redis://", "rediss://")
  : rawRedisUrl;

const redis = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
  }
});

redis.on("error", (error) => {
  console.error("Redis Error:", error.message);
});

async function connectRedis() {
  if (!redisUrl) {
    console.warn("Redis URL not configured");
    return null;
  }

  if (!redis.isOpen) {
    await redis.connect();
    console.log("Redis connected");
  }

  return redis;
}

module.exports = {
  redis,
  connectRedis
};
