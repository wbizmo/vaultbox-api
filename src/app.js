const Fastify = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("@fastify/jwt");
const multipart = require("@fastify/multipart");
const swagger = require("@fastify/swagger");
const swaggerUi = require("@fastify/swagger-ui");

const systemRoutes = require("./routes/system.routes");
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const planRoutes = require("./routes/plan.routes");
const fileRoutes = require("./routes/file.routes");

function buildApp() {
  const app = Fastify({
    logger: true
  });

  app.register(cors, {
    origin: true
  });

  app.register(jwt, {
    secret: process.env.JWT_SECRET || "dev_secret_change_me",
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d"
    }
  });

  app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024
    }
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: "VaultBox API",
        description: "Secure cloud storage API with quotas, signed downloads and admin controls.",
        version: "1.0.0"
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
        { name: "System", description: "System and health endpoints" },
        { name: "Auth", description: "Authentication endpoints" },
        { name: "User", description: "Current user endpoints" },
        { name: "Plans", description: "Storage plans and quota management" },
        { name: "Files", description: "File upload, listing and deletion" }
      ]
    }
  });

  app.register(swaggerUi, {
    routePrefix: "/docs"
  });

  app.register(systemRoutes);
  app.register(authRoutes);
  app.register(userRoutes);
  app.register(planRoutes);
  app.register(fileRoutes);

  return app;
}

module.exports = buildApp;
