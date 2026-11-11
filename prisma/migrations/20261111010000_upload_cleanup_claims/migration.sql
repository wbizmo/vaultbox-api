-- Preserve existing session states; no physical data is removed by the migration.
ALTER TABLE "UploadSession"
 ADD COLUMN "cleanupToken" TEXT,
 ADD COLUMN "cleanupLeaseUntil" TIMESTAMP(3),
 ADD COLUMN "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "cleanupLastError" TEXT,
 ADD COLUMN "chunksCleanedAt" TIMESTAMP(3);

CREATE INDEX "UploadSession_cleanupLeaseUntil_id_idx"
 ON "UploadSession"("cleanupLeaseUntil", "id");
