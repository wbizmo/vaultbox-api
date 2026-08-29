if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const buildApp = require("./app");
const prisma = require("./lib/prisma");
const { connectRedis, disconnectRedis, getRedisState } = require("./lib/redis");
const { assertRuntimeConfig } = require("./config/env");

async function start() {
  const config = assertRuntimeConfig();
  const app = buildApp({ config });

  try {
    try {
      await connectRedis();

      if (getRedisState().ready) {
        app.log.info("Redis connected");
      } else if (!getRedisState().configured) {
        app.log.warn("Redis is not configured; Redis-backed features will degrade gracefully");
      }
    } catch (error) {
      app.log.error({ err: error }, "Redis connection failed; starting with degraded Redis functionality");
    }

    const address = await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`VaultBox API running at ${address}`);

    const shutdown = async (signal) => {
      app.log.info({ signal }, "Graceful shutdown started");

      const shutdownTimer = setTimeout(() => {
        app.log.error("Graceful shutdown timed out");
        process.exit(1);
      }, 10000);
      shutdownTimer.unref();

      try {
        await app.close();
        await Promise.allSettled([
          disconnectRedis(),
          prisma.$disconnect()
        ]);
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, "Graceful shutdown failed");
        process.exit(1);
      }
    };

    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    app.log.error(error);
    await Promise.allSettled([
      disconnectRedis(),
      prisma.$disconnect()
    ]);
    process.exit(1);
  }
}

start();
