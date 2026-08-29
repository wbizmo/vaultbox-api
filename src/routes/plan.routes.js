const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { formatBytes } = require("../lib/bytes");

function serializePlan(plan) {
  return {
    ...plan,
    storageLimit: plan.storageLimit.toString(),
    storageLimitFormatted: formatBytes(plan.storageLimit)
  };
}

async function planRoutes(app) {
  app.get("/plans", {
    schema: {
      tags: ["Plans"],
      summary: "List available storage plans"
    }
  }, async () => {
    const plans = await prisma.plan.findMany({ orderBy: { priceMonthly: "asc" } });
    return { plans: plans.map(serializePlan) };
  });

  app.get("/quota", {
    preHandler: requireAuth,
    schema: {
      tags: ["Plans"],
      summary: "Get current user's storage quota",
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      include: { plan: true }
    });

    const storageUsed = user.storageUsed || 0n;
    const storageLimit = user.plan?.storageLimit || 0n;
    const usagePercent = storageLimit > 0n
      ? Number((storageUsed * 10000n) / storageLimit) / 100
      : 0;

    return {
      quota: {
        plan: user.plan?.name || "No Plan",
        storageUsed: storageUsed.toString(),
        storageLimit: storageLimit.toString(),
        storageUsedFormatted: formatBytes(storageUsed),
        storageLimitFormatted: formatBytes(storageLimit),
        usagePercent,
        availableBytes: (storageLimit > storageUsed ? storageLimit - storageUsed : 0n).toString(),
        status: user.status
      }
    };
  });

  app.patch("/plans/:planId/subscribe", {
    preHandler: requireAuth,
    schema: {
      tags: ["Plans"],
      summary: "Switch current user to another plan without violating quota",
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const [plan, user] = await Promise.all([
      prisma.plan.findUnique({ where: { id: request.params.planId } }),
      prisma.user.findUnique({ where: { id: request.user.id } })
    ]);

    if (!plan) return reply.code(404).send({ message: "Plan not found" });
    if (BigInt(user.storageUsed) > BigInt(plan.storageLimit)) {
      return reply.code(409).send({
        message: "Current storage usage exceeds the selected plan limit",
        storageUsed: user.storageUsed.toString(),
        selectedPlanLimit: plan.storageLimit.toString()
      });
    }

    const updated = await prisma.user.update({
      where: { id: request.user.id },
      data: { planId: plan.id },
      include: { plan: true }
    });

    await prisma.auditLog.create({
      data: {
        action: "PLAN_CHANGED",
        details: `Changed to ${plan.name} plan`,
        userId: updated.id,
        ip: request.ip
      }
    });

    return { message: "Plan updated successfully", plan: serializePlan(updated.plan) };
  });
}

module.exports = planRoutes;
