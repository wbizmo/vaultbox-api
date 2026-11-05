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

module.exports = { recordFirstDownload };
