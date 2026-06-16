const prisma = require("../lib/prisma");
const redis = require("../lib/redis");

async function infraRoutes(app) {
  app.get("/infra/health", {
    schema: {
      tags: ["Infrastructure"],
      summary: "Check database and redis connectivity"
    }
  }, async () => {
    let redisStatus = "offline";

    try {
      await redis.ping();
      redisStatus = "online";
    } catch {}

    let databaseStatus = "offline";

    try {
      await prisma.$queryRaw`SELECT 1`;
      databaseStatus = "online";
    } catch {}

    return {
      service: "vaultbox-api",
      database: databaseStatus,
      redis: redisStatus,
      uptime: process.uptime()
    };
  });
}

module.exports = infraRoutes;
