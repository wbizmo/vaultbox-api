const prisma = require("./prisma");

async function reserveUploadQuota(userId, fileSize, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User" AS u
    SET
      "storageUsed" = u."storageUsed" + ${fileSize},
      "updatedAt" = NOW()
    FROM "Plan" AS p
    WHERE u."id" = ${userId}
      AND u."planId" = p."id"
      AND u."storageUsed" + u."reservedUploadBytes" + ${fileSize} <= p."storageLimit"
    RETURNING
      u."storageUsed" AS "storageUsed",
      u."reservedUploadBytes" AS "reservedUploadBytes",
      p."storageLimit" AS "storageLimit",
      p."id" AS "planId"
  `;

  return rows[0] || null;
}

async function reservePendingUploadQuota(userId, bytes, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User" AS u
    SET
      "reservedUploadBytes" = u."reservedUploadBytes" + ${bytes},
      "updatedAt" = NOW()
    FROM "Plan" AS p
    WHERE u."id" = ${userId}
      AND u."planId" = p."id"
      AND u."storageUsed" + u."reservedUploadBytes" + ${bytes} <= p."storageLimit"
    RETURNING
      u."storageUsed" AS "storageUsed",
      u."reservedUploadBytes" AS "reservedUploadBytes",
      p."storageLimit" AS "storageLimit",
      p."id" AS "planId"
  `;

  return rows[0] || null;
}

async function releaseUploadReservation(userId, bytes, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User"
    SET
      "reservedUploadBytes" = GREATEST("reservedUploadBytes" - ${bytes}, 0),
      "updatedAt" = NOW()
    WHERE "id" = ${userId}
    RETURNING "storageUsed", "reservedUploadBytes"
  `;

  return rows[0] || null;
}

async function commitUploadReservation(userId, bytes, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User" AS u
    SET
      "storageUsed" = u."storageUsed" + ${bytes},
      "reservedUploadBytes" = u."reservedUploadBytes" - ${bytes},
      "updatedAt" = NOW()
    FROM "Plan" AS p
    WHERE u."id" = ${userId}
      AND u."planId" = p."id"
      AND u."reservedUploadBytes" >= ${bytes}
      AND u."storageUsed" + u."reservedUploadBytes" <= p."storageLimit"
    RETURNING
      u."storageUsed" AS "storageUsed",
      u."reservedUploadBytes" AS "reservedUploadBytes",
      p."storageLimit" AS "storageLimit",
      p."id" AS "planId"
  `;

  return rows[0] || null;
}

async function switchPlanIfFits(userId, planId, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User" AS u
    SET
      "planId" = p."id",
      "updatedAt" = NOW()
    FROM "Plan" AS p
    WHERE u."id" = ${userId}
      AND p."id" = ${planId}
      AND u."storageUsed" + u."reservedUploadBytes" <= p."storageLimit"
    RETURNING
      u."id" AS "userId",
      u."storageUsed" AS "storageUsed",
      u."reservedUploadBytes" AS "reservedUploadBytes",
      p."storageLimit" AS "storageLimit",
      p."id" AS "planId"
  `;

  return rows[0] || null;
}

module.exports = {
  reserveUploadQuota,
  reservePendingUploadQuota,
  releaseUploadReservation,
  commitUploadReservation,
  switchPlanIfFits
};
