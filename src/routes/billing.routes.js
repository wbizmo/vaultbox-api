const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

async function billingRoutes(app) {
  app.post("/billing/simulate-failed-payment", {
    preHandler: requireAuth,
    schema: {
      tags: ["Billing"],
      summary: "Simulate failed payment and suspend account",
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const user = await prisma.user.update({
      where: { id: request.user.id },
      data: { status: "SUSPENDED" },
      select: {
        id: true,
        name: true,
        email: true,
        status: true
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "PAYMENT_FAILED",
        details: "Simulated billing failure. Account suspended.",
        userId: user.id,
        ip: request.ip
      }
    });

    return {
      message: "Payment failure simulated. Account suspended.",
      user
    };
  });
}

module.exports = billingRoutes;
