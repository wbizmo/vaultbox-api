const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

async function userRoutes(app) {
  app.get("/me", {
    preHandler: requireAuth,
    schema: {
      tags: ["User"],
      summary: "Get current authenticated user",
      security: [
        {
          bearerAuth: []
        }
      ],
      response: {
        200: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
                role: { type: "string" },
                status: { type: "string" },
                storageUsed: { type: "string" },
                createdAt: { type: "string" },
                plan: {
                  type: "object",
                  nullable: true,
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    priceMonthly: { type: "number" },
                    storageLimit: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        storageUsed: true,
        createdAt: true,
        plan: true
      }
    });

    return {
      user: {
        ...user,
        storageUsed: user.storageUsed.toString(),
        plan: user.plan
          ? {
              ...user.plan,
              storageLimit: user.plan.storageLimit.toString()
            }
          : null
      }
    };
  });
}

module.exports = userRoutes;
