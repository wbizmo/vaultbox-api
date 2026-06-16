const { createClient } = require("redis");

const redis = createClient({
  url: process.env.REDIS_URL
});

redis.on("error", (error) => {
  console.error("Redis Error:", error);
});

(async () => {
  if (!redis.isOpen) {
    await redis.connect();
    console.log("Redis connected");
  }
})();

module.exports = redis;
