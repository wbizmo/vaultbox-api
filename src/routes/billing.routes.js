const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { verifyWebhookSignature, applyBillingEvent } = require("../lib/entitlements");

async function billingRoutes(app) {
  // Encapsulated so the raw bytes of the body are available for HMAC verification
  // without changing JSON parsing for any other route.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (request, body, done) => {
      request.rawBody = body;
      try {
        done(null, JSON.parse(body));
      } catch {
        const error = new Error("Invalid JSON body");
        error.statusCode = 400;
        done(error);
      }
    });

    scope.post("/billing/webhook", {
      schema: {
        tags: ["Billing"],
        summary: "Receive a signed billing event that grants or revokes a plan entitlement",
        description: "Authenticated with `x-vaultbox-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t.rawBody)>`. Idempotent by eventId; replays return 200 with no changes.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["eventId", "type", "userId", "planId"],
          properties: {
            eventId: { type: "string", minLength: 1, maxLength: 200 },
            type: { type: "string", enum: ["entitlement.granted", "entitlement.revoked"] },
            userId: { type: "string", minLength: 1, maxLength: 100 },
            planId: { type: "string", minLength: 1, maxLength: 100 },
            validUntil: { type: "string", format: "date-time" },
            fallbackPlanId: { type: "string", minLength: 1, maxLength: 100 }
          }
        }
      }
    }, async (request, reply) => {
      const config = app.vaultboxConfig || {};
      if (!config.billingWebhookSecret) {
        return reply.code(503).send({ message: "Billing webhook is not configured" });
      }
      const valid = verifyWebhookSignature({
        secret: config.billingWebhookSecret,
        header: request.headers["x-vaultbox-signature"],
        rawBody: request.rawBody,
        toleranceSeconds: config.billingWebhookToleranceSeconds || 300
      });
      if (!valid) return reply.code(401).send({ message: "Invalid webhook signature" });

      const result = await applyBillingEvent(request.body);
      switch (result.status) {
        case "unknown-user":
        case "unknown-plan":
          return reply.code(404).send({ message: "Unknown user or plan" });
        case "conflict":
          return reply.code(409).send({ message: "Event id was already used with a different payload" });
        case "replayed":
          return { message: "Event already processed", replayed: true };
        default:
          return { message: "Event applied", replayed: false, downgraded: result.downgraded };
      }
    });
  });

  app.post("/billing/simulate-failed-payment", {
    preHandler: requireAuth,
    schema: {
      tags: ["Billing"],
      summary: "Simulate failed payment and suspend account",
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: request.user.id },
        data: { status: "SUSPENDED", authVersion: { increment: 1 } },
        select: { id: true, name: true, email: true, status: true }
      });

      await tx.auditLog.create({
        data: {
          action: "PAYMENT_FAILED",
          details: "Simulated billing failure. Account suspended.",
          userId: updated.id,
          ip: request.ip
        }
      });

      return updated;
    });


    return {
      message: "Payment failure simulated. Account suspended.",
      user
    };
  });
}

module.exports = billingRoutes;
