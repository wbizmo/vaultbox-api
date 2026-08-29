const Fastify = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const multipart = require("@fastify/multipart");
const swagger = require("@fastify/swagger");
const swaggerUi = require("@fastify/swagger-ui");
const rateLimit = require("@fastify/rate-limit");

const { getConfig } = require("./config/env");
const { installErrorHandler } = require("./lib/errors");
const { installRequestMetrics } = require("./lib/metrics");
const { installSecurityHeaders, redactRequestUrl } = require("./lib/security");

const systemRoutes = require("./routes/system.routes");
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const planRoutes = require("./routes/plan.routes");
const fileRoutes = require("./routes/file.routes");
const folderRoutes = require("./routes/folder.routes");
const downloadRoutes = require("./routes/download.routes");
const billingRoutes = require("./routes/billing.routes");
const adminRoutes = require("./routes/admin.routes");
const infraRoutes = require("./routes/infra.routes");

function buildApp(options = {}) {
  const config = options.config || getConfig();
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: config.isProduction,
    requestIdHeader: "x-request-id",
    disableRequestLogging: true
  });

  app.decorate("vaultboxConfig", config);

  app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      if (!config.isProduction && config.corsOrigins.length === 0) return callback(null, true);
      return callback(null, false);
    }
  });

  app.register(rateLimit, {
    max: 240,
    timeWindow: "1 minute"
  });

  app.register(jwt, {
    secret: config.jwtSecret || "local-development-only-secret",
    sign: { expiresIn: config.jwtExpiresIn }
  });

  app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1
    }
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: "VaultBox API",
        description: "Secure cloud storage API with quotas, resumable transfers, signed downloads and admin controls.",
        version: "2.0.0"
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT"
          }
        }
      },
      tags: [
        { name: "System", description: "System, readiness and metrics endpoints" },
        { name: "Auth", description: "Authentication endpoints" },
        { name: "User", description: "Current user endpoints" },
        { name: "Plans", description: "Storage plans and quota management" },
        { name: "Files", description: "File upload, listing and deletion" },
        { name: "Folders", description: "Folder organization endpoints" },
        { name: "Downloads", description: "Resumable and range-capable secure downloads" },
        { name: "Billing", description: "Billing simulation and suspension workflow" },
        { name: "Admin", description: "Administrative controls and reports" },
        { name: "Infrastructure", description: "Database and Redis health checks" }
      ]
    }
  });

  app.register(swaggerUi, { routePrefix: "/docs" });

  installRequestMetrics(app);
  installSecurityHeaders(app);
  installErrorHandler(app);

  app.addHook("onRequest", async (request) => {
    request.log.info({
      requestId: request.id,
      method: request.method,
      url: redactRequestUrl(request.raw.url),
      ip: request.ip
    }, "request started");
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info({
      requestId: request.id,
      method: request.method,
      url: redactRequestUrl(request.raw.url),
      statusCode: reply.statusCode
    }, "request completed");
  });

  app.register(systemRoutes);
  app.register(authRoutes);
  app.register(userRoutes);
  app.register(planRoutes);
  app.register(fileRoutes);
  app.register(folderRoutes);
  app.register(downloadRoutes);
  app.register(billingRoutes);
  app.register(adminRoutes);
  app.register(infraRoutes);

  return app;
}

module.exports = buildApp;
