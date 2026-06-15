async function systemRoutes(app) {
  app.get("/", {
    schema: {
      tags: ["System"],
      summary: "API welcome route",
      response: {
        200: {
          type: "object",
          properties: {
            name: { type: "string" },
            status: { type: "string" },
            docs: { type: "string" }
          }
        }
      }
    }
  }, async () => {
    return {
      name: "VaultBox API",
      status: "running",
      docs: "/docs"
    };
  });

  app.get("/health", {
    schema: {
      tags: ["System"],
      summary: "Health check",
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            service: { type: "string" },
            uptime: { type: "number" }
          }
        }
      }
    }
  }, async () => {
    return {
      status: "ok",
      service: "vaultbox-api",
      uptime: process.uptime()
    };
  });
}

module.exports = systemRoutes;
