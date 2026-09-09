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
      AND u."storageUsed" + ${fileSize} <= p."storageLimit"
    RETURNING
      u."storageUsed" AS "storageUsed",
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
      AND u."storageUsed" <= p."storageLimit"
    RETURNING
      u."id" AS "userId",
      u."storageUsed" AS "storageUsed",
      p."storageLimit" AS "storageLimit",
      p."id" AS "planId"
  `;

  return rows[0] || null;
}

module.exports = {
  reserveUploadQuota,
  switchPlanIfFits
};
