const prisma = require("./prisma");

async function softDeleteFileWithQuota(userId, fileId, client = prisma) {
  const rows = await client.$queryRaw`
    WITH deleted AS (
      UPDATE "File"
      SET "status" = 'DELETED'::"FileStatus", "updatedAt" = NOW()
      WHERE "id" = ${fileId}
        AND "userId" = ${userId}
        AND "status" = 'ACTIVE'::"FileStatus"
      RETURNING
        "id",
        "originalName",
        "storedName",
        "mimeType",
        "size",
        "path",
        "checksum",
        "status",
        "userId",
        "folderId",
        "createdAt",
        "updatedAt"
    ),
    accounted AS (
      UPDATE "User"
      SET
        "storageUsed" = GREATEST("User"."storageUsed" - deleted."size", 0),
        "updatedAt" = NOW()
      FROM deleted
      WHERE "User"."id" = ${userId}
      RETURNING "User"."id"
    )
    SELECT deleted.*
    FROM deleted
    JOIN accounted ON TRUE
  `;

  return rows[0] || null;
}

module.exports = { softDeleteFileWithQuota };
