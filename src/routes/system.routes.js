const { version } = require("../../package.json");
const { snapshotMetrics } = require("../lib/metrics");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

async function systemRoutes(app) {
  app.get("/", {
    config: { rateLimit: false },
    schema: {
      tags: ["System"],
      summary: "API welcome route"
    }
  }, async () => ({
    name: "VaultBox API",
    version,
    status: "operational",
    docs: "/docs",
    health: "/health"
  }));

  app.get("/health", {
    config: { rateLimit: false },
    schema: {
      tags: ["System"],
      summary: "Liveness check"
    }
  }, async () => ({
    status: "ok",
    service: "vaultbox-api",
    version,
    uptimeSeconds: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString()
  }));

  app.get("/metrics", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["System"],
      summary: "Read process and request metrics",
      security: [{ bearerAuth: [] }]
    }
  }, async () => ({ metrics: snapshotMetrics() }));
}

module.exports = systemRoutes;
