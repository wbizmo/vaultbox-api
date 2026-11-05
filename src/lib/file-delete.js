const prisma = require("./prisma");

/**
 * Logical deletion, once-only: mark the file DELETED, refund its quota and enqueue the byte removal
 * (FileDeletion outbox row) in a single statement. The physical removal is retried by
 * src/lib/file-deletion.js until it is verified done or explicitly dead-lettered.
 */
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
    ),
    queued AS (
      -- The durable "remove the bytes" job, in the same statement (and so the same transaction) as the
      -- status change and the refund. UNIQUE("fileId") plus the ACTIVE guard above make it once-only.
      INSERT INTO "FileDeletion" ("fileId", "userId", "storedName", "size")
      SELECT deleted."id", deleted."userId", deleted."storedName", deleted."size" FROM deleted
      ON CONFLICT ("fileId") DO NOTHING
      RETURNING "id"
    )
    SELECT deleted.*
    FROM deleted
    JOIN accounted ON TRUE
  `;

  return rows[0] || null;
}

module.exports = { softDeleteFileWithQuota };
