const prisma = require("./prisma");

async function recordFirstDownload(record, ip, client = prisma) {
  if (record.usedAt) return false;

  const updated = await client.downloadToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() }
  });

  if (updated.count !== 1) return false;

  await client.auditLog.create({
    data: {
      action: "DOWNLOAD_SESSION_STARTED",
      details: `${record.file.id}:${record.file.originalName}`,
      userId: record.userId,
      ip
    }
  });

  return true;
}

module.exports = { recordFirstDownload };
