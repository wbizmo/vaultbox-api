const { snapshotMetrics } = require("../lib/metrics");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

async function systemRoutes(app) {
  app.get("/", {
    schema: {
      tags: ["System"],
      summary: "API welcome route"
    }
  }, async () => ({
    name: "VaultBox API",
    version: "2.0.0",
    status: "running",
    docs: "/docs"
  }));

  app.get("/health", {
    schema: {
      tags: ["System"],
      summary: "Liveness check"
    }
  }, async () => ({
    status: "ok",
    service: "vaultbox-api",
    version: "2.0.0",
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
