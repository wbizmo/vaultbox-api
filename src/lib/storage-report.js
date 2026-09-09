const prisma = require("./prisma");

async function getStorageReport(client = prisma) {
  const [row] = await client.$queryRaw`
    SELECT
      COUNT(*)::int AS "totalUsers",
      COUNT(*) FILTER (WHERE "status" = 'ACTIVE')::int AS "activeUsers",
      COUNT(*) FILTER (WHERE "status" = 'SUSPENDED')::int AS "suspendedUsers",
      COUNT(*) FILTER (WHERE "status" = 'DELETED')::int AS "deletedUsers",
      COALESCE(SUM("storageUsed"), 0)::bigint AS "totalStorageUsed"
    FROM "User"
  `;

  return row || {
    totalUsers: 0,
    activeUsers: 0,
    suspendedUsers: 0,
    deletedUsers: 0,
    totalStorageUsed: 0n
  };
}

module.exports = { getStorageReport };
