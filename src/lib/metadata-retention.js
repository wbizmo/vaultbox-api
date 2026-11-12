"use strict";

const prisma = require("./prisma");

const DEFAULTS = Object.freeze({ batchSize: 100, uploadDays: 30, downloadDays: 30, auditDays: 0 });

function intSetting(value, name, { min, max }) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(name + " must be an integer in [" + min + ", " + max + "]");
  }
  return n;
}

function retentionSettings(env = process.env) {
  return {
    batchSize: intSetting(env.VAULTBOX_METADATA_PRUNE_BATCH_SIZE ?? DEFAULTS.batchSize,
      "VAULTBOX_METADATA_PRUNE_BATCH_SIZE", { min: 1, max: 500 }),
    uploadDays: intSetting(env.VAULTBOX_UPLOAD_METADATA_RETENTION_DAYS ?? DEFAULTS.uploadDays,
      "VAULTBOX_UPLOAD_METADATA_RETENTION_DAYS", { min: 1, max: 3650 }),
    downloadDays: intSetting(env.VAULTBOX_DOWNLOAD_METADATA_RETENTION_DAYS ?? DEFAULTS.downloadDays,
      "VAULTBOX_DOWNLOAD_METADATA_RETENTION_DAYS", { min: 1, max: 3650 }),
    auditDays: intSetting(env.VAULTBOX_AUDIT_RETENTION_DAYS ?? DEFAULTS.auditDays,
      "VAULTBOX_AUDIT_RETENTION_DAYS", { min: 0, max: 36500 })
  };
}

function daysBefore(now, days) { return new Date(now.getTime() - days * 86400000); }

/**
 * All three operations are independently bounded, keyset ordered, and concurrent-worker-safe.
 * Only terminal upload sessions are removed. UploadPart rows cascade; committed File data
 * and quota state are independent and are NEVER changed here.
 * Audit retention is explicitly opt-in (0 = never delete); audit records may be subject to
 * legal and regulatory holds, so deployments must approve an archival/hold policy first.
 */
async function pruneMetadata(options = {}, client = prisma) {
  const settings = { ...retentionSettings(), ...options };
  const { batchSize, uploadDays, downloadDays, auditDays } = settings;
  intSetting(batchSize, "batchSize", { min: 1, max: 500 });
  intSetting(uploadDays, "uploadDays", { min: 1, max: 3650 });
  intSetting(downloadDays, "downloadDays", { min: 1, max: 3650 });
  intSetting(auditDays, "auditDays", { min: 0, max: 36500 });
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");

  const uploadCutoff = daysBefore(now, uploadDays);
  const downloadCutoff = daysBefore(now, downloadDays);

  const uploads = await client.$queryRaw`
    WITH candidates AS (
      SELECT "id" FROM "UploadSession"
      WHERE "status" IN ('COMPLETED'::"UploadSessionStatus", 'ABORTED'::"UploadSessionStatus", 'EXPIRED'::"UploadSessionStatus")
        AND "chunksCleanedAt" IS NOT NULL
        AND "updatedAt" < ${uploadCutoff}
      ORDER BY "updatedAt" ASC, "id" ASC
      LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "UploadSession" u USING candidates c WHERE u."id" = c."id"
    RETURNING u."id"
  `;

  const downloads = await client.$queryRaw`
    WITH candidates AS (
      SELECT "id" FROM "DownloadToken"
      WHERE "expiresAt" < ${downloadCutoff}
      ORDER BY "expiresAt" ASC, "id" ASC
      LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "DownloadToken" d USING candidates c WHERE d."id" = c."id"
    RETURNING d."id"
  `;

  let audits = [];
  if (auditDays > 0) {
    const auditCutoff = daysBefore(now, auditDays);
    audits = await client.$queryRaw`
      WITH candidates AS (
        SELECT "id" FROM "AuditLog"
        WHERE "createdAt" < ${auditCutoff}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "AuditLog" a USING candidates c WHERE a."id" = c."id"
      RETURNING a."id"
    `;
  }
  return { uploads: uploads.length, downloads: downloads.length, audits: audits.length,
    total: uploads.length + downloads.length + audits.length };
}

module.exports = { DEFAULTS, retentionSettings, pruneMetadata };
