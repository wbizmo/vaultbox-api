const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

function formatBytes(bytes) {
  const value = Number(bytes);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

async function planRoutes(app) {
  app.get("/plans", {
    schema: {
      tags: ["Plans"],
      summary: "List available storage plans",
      response: {
        200: {
          type: "object",
          properties: {
            plans: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  priceMonthly: { type: "number" },
                  storageLimit: { type: "string" },
                  storageLimitFormatted: { type: "string" },
                  createdAt: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  }, async () => {
    const plans = await prisma.plan.findMany({ orderBy: { priceMonthly: "asc" } });

    return {
      plans: plans.map((plan) => ({
        ...plan,
        storageLimit: plan.storageLimit.toString(),
        storageLimitFormatted: formatBytes(plan.storageLimit)
      }))
    };
  });

  app.get("/quota", {
    preHandler: requireAuth,
    schema: {
      tags: ["Plans"],
      summary: "Get current user's storage quota",
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: "object",
          properties: {
            quota: {
              type: "object",
              properties: {
                plan: { type: "string" },
                storageUsed: { type: "string" },
                storageLimit: { type: "string" },
                storageUsedFormatted: { type: "string" },
                storageLimitFormatted: { type: "string" },
                usagePercent: { type: "number" },
                status: { type: "string" }
              }
            }
          }
        }
      }
    }
  }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      include: { plan: true }
    });

    const storageUsed = user.storageUsed || 0n;
    const storageLimit = user.plan?.storageLimit || 0n;
    const usagePercent = storageLimit > 0n ? Number((storageUsed * 10000n) / storageLimit) / 100 : 0;

    return {
      quota: {
        plan: user.plan?.name || "No Plan",
        storageUsed: storageUsed.toString(),
        storageLimit: storageLimit.toString(),
        storageUsedFormatted: formatBytes(storageUsed),
        storageLimitFormatted: formatBytes(storageLimit),
        usagePercent,
        status: user.status
      }
    };
  });

  app.patch("/plans/:planId/subscribe", {
    preHandler: requireAuth,
    schema: {
      tags: ["Plans"],
      summary: "Switch current user to another plan",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["planId"],
        properties: {
          planId: { type: "string" }
        }
      }
    }
  }, async (request, reply) => {
    const { planId } = request.params;

    const plan = await prisma.plan.findUnique({ where: { id: planId } });

    if (!plan) return reply.code(404).send({ message: "Plan not found" });

    const user = await prisma.user.update({
      where: { id: request.user.id },
      data: { planId: plan.id, status: "ACTIVE" },
      include: { plan: true }
    });

    await prisma.auditLog.create({
      data: {
        action: "PLAN_CHANGED",
        details: `Changed to ${plan.name} plan`,
        userId: user.id,
        ip: request.ip
      }
    });

    return {
      message: "Plan updated successfully",
      plan: {
        ...user.plan,
        storageLimit: user.plan.storageLimit.toString(),
        storageLimitFormatted: formatBytes(user.plan.storageLimit)
      }
    };
  });
}

module.exports = planRoutes;
