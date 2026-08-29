const { performance } = require("perf_hooks");

const prisma = require("../lib/prisma");
const { redis, getRedisState } = require("../lib/redis");

async function timed(operation) {
  const startedAt = performance.now();
  await operation();
  return Number((performance.now() - startedAt).toFixed(2));
}

async function infraRoutes(app) {
  app.get("/infra/health", {
    schema: {
      tags: ["Infrastructure"],
      summary: "Check database and Redis connectivity"
    }
  }, async (request, reply) => {
    const checks = {
      database: {
        status: "offline",
        latencyMs: null
      },
      redis: {
        status: getRedisState().configured ? "offline" : "not_configured",
        latencyMs: null,
        ...getRedisState()
      }
    };

    try {
      checks.database.latencyMs = await timed(() => prisma.$queryRaw`SELECT 1`);
      checks.database.status = "online";
    } catch (error) {
      request.log.error({ err: error }, "Database health check failed");
    }

    if (redis?.isReady) {
      try {
        checks.redis.latencyMs = await timed(() => redis.ping());
        checks.redis.status = "online";
      } catch (error) {
        request.log.error({ err: error }, "Redis health check failed");
      }
    }

    const healthy = checks.database.status === "online" &&
      ["online", "not_configured"].includes(checks.redis.status);

    return reply.code(healthy ? 200 : 503).send({
      service: "vaultbox-api",
      status: healthy ? "healthy" : "degraded",
      checks,
      uptimeSeconds: Number(process.uptime().toFixed(2))
    });
  });
}

module.exports = infraRoutes;
