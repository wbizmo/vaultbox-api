const prisma = require("./prisma");
const { recordAudit } = require("./audit");

/**
 * Mark a download session as started and record the event, atomically. The compare-and-set on `usedAt`
 * decides which request is first; the audit row is written in the same transaction, so the flag and the
 * event can never disagree (a failing insert leaves `usedAt` unset and a later request records it).
 */
async function recordFirstDownload(record, ip, client = prisma) {
  if (record.usedAt) return false;

  return client.$transaction(async (tx) => {
    const updated = await tx.downloadToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() }
    });

    if (updated.count !== 1) return false;

    await recordAudit(tx, {
      action: "DOWNLOAD_SESSION_STARTED",
      details: record.file.id,
      userId: record.userId,
      ip
    });

    return true;
  });
}

/**
 * Revoke one of the owner's download sessions (or all active ones for a file). Revocation is a cleanup path:
 * it never requires the account to be ACTIVE and is idempotent. Only sessions that were still usable
 * (unexpired, not yet revoked) are changed and audited; the audit row carries the session id, never the bearer
 * value or its hash. Requests that begin after the commit are refused with 410; a stream already open is
 * not interrupted (see docs/DEPLOYMENT.md "Download sessions").
 */
async function revokeDownloadSessions(userId, where, ip, client = prisma) {
  return client.$transaction(async (tx) => {
    const live = await tx.downloadToken.findMany({
      where: { ...where, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true }
    });
    let revoked = 0;
    for (const { id } of live) {
      const updated = await tx.downloadToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (updated.count !== 1) continue;
      revoked += 1;
      await recordAudit(tx, { action: "DOWNLOAD_SESSION_REVOKED", details: id, userId, ip });
    }
    return revoked;
  });
}

module.exports = { recordFirstDownload, revokeDownloadSessions };
