const prisma = require("../lib/prisma");
const { clientIp } = require("../lib/client-ip");
const { recordAudit } = require("../lib/audit");
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
      description: "storageUsed and usagePercent remain committed-only. reservedUploadBytes tracks outstanding upload reservations; totalAllocatedBytes and allocatedUsagePercent include reservations. availableBytes is immediately allocatable capacity. Byte counts are precise decimal strings.",
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: "object",
          required: ["quota"],
          properties: {
            quota: {
              type: "object",
              required: ["plan", "storageUsed", "committedStorageUsed", "reservedUploadBytes", "totalAllocatedBytes", "storageLimit", "storageUsedFormatted", "storageLimitFormatted", "usagePercent", "allocatedUsagePercent", "availableBytes", "status"],
              properties: {
                plan: { type: "string" },
                storageUsed: { type: "string", description: "Committed bytes; backwards compatible" },
                committedStorageUsed: { type: "string" },
                reservedUploadBytes: { type: "string" },
                totalAllocatedBytes: { type: "string" },
                storageLimit: { type: "string" },
                storageUsedFormatted: { type: "string" },
                storageLimitFormatted: { type: "string" },
                usagePercent: { type: "number", description: "Committed-only percentage" },
                allocatedUsagePercent: { type: "number", description: "Committed plus reserved percentage" },
                availableBytes: { type: "string", description: "Non-negative immediately allocatable bytes" },
                status: { type: "string" }
              }
            }
          }
        }
      }
    }
  }, async (request) => {
    // A single SQL statement takes a coherent MVCC snapshot of account and plan.
    // The actor id is bound as a parameter; the statement text is constant.
    const rows = await prisma.$queryRawUnsafe(
      'SELECT u."storageUsed", u."reservedUploadBytes", u."status", ' +
      'p."storageLimit", p."name" AS "planName" ' +
      'FROM "User" u LEFT JOIN "Plan" p ON p."id" = u."planId" ' +
      'WHERE u."id" = $1',
      request.user.id
    );
    const user = rows[0];
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");

    const storageUsed = user.storageUsed ?? 0n;
    const reservedUploadBytes = user.reservedUploadBytes ?? 0n;
    const storageLimit = user.storageLimit ?? 0n;
    const totalAllocatedBytes = storageUsed + reservedUploadBytes;
    const usagePercent = storageLimit > 0n
      ? Number((storageUsed * 10000n) / storageLimit) / 100
      : 0;
    const allocatedUsagePercent = storageLimit > 0n
      ? Number((totalAllocatedBytes * 10000n) / storageLimit) / 100
      : 0;

    return {
      quota: {
        plan: user.planName || "No Plan",
        storageUsed: storageUsed.toString(),
        committedStorageUsed: storageUsed.toString(),
        reservedUploadBytes: reservedUploadBytes.toString(),
        totalAllocatedBytes: totalAllocatedBytes.toString(),
        storageLimit: storageLimit.toString(),
        storageUsedFormatted: formatBytes(storageUsed),
        storageLimitFormatted: formatBytes(storageLimit),
        usagePercent,
        allocatedUsagePercent,
        availableBytes: (storageLimit > totalAllocatedBytes ? storageLimit - totalAllocatedBytes : 0n).toString(),
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
    // The plan change and its audit event are one transaction in both modes.
    const audit = (tx) => recordAudit(tx, {
      action: "PLAN_CHANGED",
      details: `${request.user.id}:${plan.id}`,
      userId: request.user.id,
      ip: clientIp(request)
    });
    const switched = demoMode
      ? await prisma.$transaction(async (tx) => {
          const changed = await switchPlanIfFits(request.user.id, plan.id, tx);
          if (changed) await audit(tx);
          return changed;
        })
      : await switchPlanIfEntitled(request.user.id, plan.id, prisma, audit);
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

    return { message: "Plan updated successfully", plan: serializePlan(plan) };
  });
}

module.exports = planRoutes;
