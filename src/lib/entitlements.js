const crypto = require("node:crypto");
const prisma = require("./prisma");

const ACTIVE_ENTITLEMENT_SQL = `
  e."userId" = u."id"
  AND e."planId" = p."id"
  AND e."status" = 'ACTIVE'::"EntitlementStatus"
  AND e."validFrom" <= NOW()
  AND (e."validUntil" IS NULL OR e."validUntil" > NOW())
`;

function hashPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Verify a `t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>` header.
 * Returns false (never throws) for any malformed, stale, or mismatching signature.
 */
function verifyWebhookSignature({ secret, header, rawBody, toleranceSeconds, now = Date.now() }) {
  if (!secret || typeof header !== "string" || typeof rawBody !== "string") return false;

  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    })
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/i.test(parts.v1 || "")) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > toleranceSeconds) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(parts.v1, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function lockUser(tx, userId) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Switch a user to a plan only when it fits current usage AND the plan is free
 * or the user holds an active entitlement for it. The user row is locked first
 * so the entitlement read in the UPDATE (a fresh statement snapshot) cannot
 * race a concurrent revocation, which takes the same lock.
 */
async function switchPlanIfEntitled(userId, planId, client = prisma, afterSwitch = null) {
  return client.$transaction(async (tx) => {
    if (!(await lockUser(tx, userId))) return null;
    const rows = await tx.$queryRawUnsafe(`
      UPDATE "User" AS u
      SET "planId" = p."id", "updatedAt" = NOW()
      FROM "Plan" AS p
      WHERE u."id" = $1
        AND u."status" = 'ACTIVE'::"UserStatus"
        AND p."id" = $2
        AND u."storageUsed" + u."reservedUploadBytes" <= p."storageLimit"
        AND (
          p."priceMonthly" = 0
          OR EXISTS (SELECT 1 FROM "PlanEntitlement" e WHERE ${ACTIVE_ENTITLEMENT_SQL})
        )
      RETURNING
        u."id" AS "userId",
        u."storageUsed" AS "storageUsed",
        u."reservedUploadBytes" AS "reservedUploadBytes",
        p."storageLimit" AS "storageLimit",
        p."id" AS "planId"
    `, userId, planId);
    // Runs in the same transaction as the plan change (used to write the audit event atomically).
    if (rows[0] && afterSwitch) await afterSwitch(tx, rows[0]);
    return rows[0] || null;
  });
}

async function hasActiveEntitlement(userId, planId, client = prisma) {
  const rows = await client.$queryRawUnsafe(`
    SELECT 1 FROM "PlanEntitlement" e
    JOIN "User" u ON u."id" = e."userId"
    JOIN "Plan" p ON p."id" = e."planId"
    WHERE u."id" = $1 AND p."id" = $2 AND ${ACTIVE_ENTITLEMENT_SQL}
    LIMIT 1
  `, userId, planId);
  return rows.length > 0;
}

/**
 * Downgrade to the free fallback plan (the plan named "Free", or the free plan named
 * by the event's fallbackPlanId) when the user is on `planId` without any
 * remaining active entitlement for it and current usage fits the free plan.
 * If usage does not fit, the user keeps the plan in a documented grace state
 * (no data is ever deleted or made unreadable) until usage drops or an
 * entitlement is granted again.
 */
async function downgradeIfUnentitled(tx, userId, planId, fallbackPlanId = null) {
  const rows = await tx.$queryRawUnsafe(`
    UPDATE "User" AS u
    SET "planId" = f."id", "updatedAt" = NOW()
    FROM "Plan" AS f
    WHERE u."id" = $1
      AND u."planId" = $2
      AND f."priceMonthly" = 0
      AND f."id" = COALESCE($3, (SELECT "id" FROM "Plan" WHERE "name" = 'Free'))
      AND u."storageUsed" + u."reservedUploadBytes" <= f."storageLimit"
      AND NOT EXISTS (
        SELECT 1 FROM "PlanEntitlement" e, "Plan" p
        WHERE p."id" = $2 AND ${ACTIVE_ENTITLEMENT_SQL}
      )
    RETURNING u."id"
  `, userId, planId, fallbackPlanId);
  return rows.length > 0;
}

async function recordEvent(tx, event, payload) {
  const payloadHash = hashPayload(payload);
  const inserted = await tx.$queryRaw`
    INSERT INTO "BillingEvent" ("id", "type", "payloadHash")
    VALUES (${event.eventId}, ${event.type}, ${payloadHash})
    ON CONFLICT ("id") DO NOTHING
    RETURNING "id"
  `;
  if (inserted.length > 0) return { duplicate: false };

  const existing = await tx.billingEvent.findUnique({ where: { id: event.eventId } });
  return { duplicate: true, sameEvent: existing.payloadHash === payloadHash };
}

/**
 * Apply one verified billing event atomically and idempotently.
 * Returns { status: "applied" | "replayed" | "conflict" | "unknown-user" | "unknown-plan", ... }.
 */
async function applyBillingEvent(event, client = prisma) {
  const payload = {
    eventId: event.eventId,
    type: event.type,
    userId: event.userId,
    planId: event.planId,
    validUntil: event.validUntil || null,
    fallbackPlanId: event.fallbackPlanId || null
  };

  return client.$transaction(async (tx) => {
    // Lock first: grant/revoke/subscribe for one user are fully serialized.
    if (!(await lockUser(tx, event.userId))) return { status: "unknown-user" };
    const plan = await tx.plan.findUnique({ where: { id: event.planId } });
    if (!plan) return { status: "unknown-plan" };

    const recorded = await recordEvent(tx, event, payload);
    if (recorded.duplicate) {
      return { status: recorded.sameEvent ? "replayed" : "conflict" };
    }

    if (event.type === "entitlement.granted") {
      await tx.planEntitlement.create({
        data: {
          userId: event.userId,
          planId: event.planId,
          eventId: event.eventId,
          validUntil: event.validUntil ? new Date(event.validUntil) : null
        }
      });
      return { status: "applied", downgraded: false };
    }

    await tx.planEntitlement.updateMany({
      where: { userId: event.userId, planId: event.planId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() }
    });
    const downgraded = await downgradeIfUnentitled(tx, event.userId, event.planId, event.fallbackPlanId || null);
    return { status: "applied", downgraded };
  });
}

module.exports = {
  verifyWebhookSignature,
  switchPlanIfEntitled,
  hasActiveEntitlement,
  applyBillingEvent
};
