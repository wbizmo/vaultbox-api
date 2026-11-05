const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { formatBytes } = require("../lib/bytes");
const { AppError } = require("../lib/errors");
const { switchPlanIfFits } = require("../lib/quota");
const { switchPlanIfEntitled, hasActiveEntitlement } = require("../lib/entitlements");

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
      description: "Free plans are self-service. Paid plans (priceMonthly > 0) require an active server-side entitlement created by an authenticated billing event, unless the deployment runs with PLAN_SWITCH_MODE=demo.",
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const plan = await prisma.plan.findUnique({ where: { id: request.params.planId } });
    if (!plan) return reply.code(404).send({ message: "Plan not found" });

    const demoMode = app.vaultboxConfig?.planSwitchMode === "demo";
    const switched = demoMode
      ? await switchPlanIfFits(request.user.id, plan.id)
      : await switchPlanIfEntitled(request.user.id, plan.id);
    if (!switched) {
      // Not admitted: say why. A suspended/deleted account (in-flight request authenticated before the
      // change) is a 403, distinct from entitlement and quota refusals.
      const account = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { status: true }
      });
      if (account && account.status !== "ACTIVE") {
        throw new AppError(403, "ACCOUNT_NOT_ACTIVE", `Account is ${String(account.status).toLowerCase()}`);
      }

      if (!demoMode && plan.priceMonthly > 0 && !(await hasActiveEntitlement(request.user.id, plan.id))) {
        return reply.code(403).send({ message: "This plan requires an active entitlement" });
      }

      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { storageUsed: true }
      });

      return reply.code(409).send({
        message: "Current storage usage exceeds the selected plan limit",
        storageUsed: user.storageUsed.toString(),
        selectedPlanLimit: plan.storageLimit.toString()
      });
    }

    await prisma.auditLog.create({
      data: {
        action: "PLAN_CHANGED",
        details: `Changed to ${plan.name} plan`,
        userId: request.user.id,
        ip: request.ip
      }
    });

    return { message: "Plan updated successfully", plan: serializePlan(plan) };
  });
}

module.exports = planRoutes;
