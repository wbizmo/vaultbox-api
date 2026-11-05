const prisma = require("./prisma");

/*
 * Account authorization state (status, role) and the session version that binds JWTs to it.
 *
 * Every transition goes through these functions: the change and the "authVersion" bump are ONE
 * UPDATE, so no reader can observe the new status/role with the old version or vice versa, and
 * the row lock the UPDATE takes serialises it against other writers of the same account.
 * Authentication reads this state from PostgreSQL on every request (no cache), so a committed
 * change is enforced on the very next request on every instance.
 */

const SELECT_PUBLIC = '"id", "name", "email", "role"::text AS "role", "status"::text AS "status"';

async function setAccountStatus(userId, status, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User"
    SET "status" = ${status}::"UserStatus", "authVersion" = "authVersion" + 1, "updatedAt" = NOW()
    WHERE "id" = ${userId}
    RETURNING "id", "name", "email", "role"::text AS "role", "status"::text AS "status"
  `;
  return rows[0] || null;
}

async function setAccountRole(userId, role, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User"
    SET "role" = ${role}::"UserRole", "authVersion" = "authVersion" + 1, "updatedAt" = NOW()
    WHERE "id" = ${userId}
    RETURNING "id", "name", "email", "role"::text AS "role", "status"::text AS "status"
  `;
  return rows[0] || null;
}

/** Revoke every outstanding token without changing status or role (e.g. password change, forced logout). */
async function revokeSessions(userId, client = prisma) {
  const rows = await client.$queryRaw`
    UPDATE "User" SET "authVersion" = "authVersion" + 1, "updatedAt" = NOW()
    WHERE "id" = ${userId}
    RETURNING "id", "authVersion"
  `;
  return rows[0] || null;
}

/** The claim a token must carry. Tokens issued before versioning have no claim and count as 0. */
function tokenVersion(payload) {
  return Number.isInteger(payload?.av) && payload.av >= 0 ? payload.av : 0;
}

module.exports = { setAccountStatus, setAccountRole, revokeSessions, tokenVersion, SELECT_PUBLIC };
