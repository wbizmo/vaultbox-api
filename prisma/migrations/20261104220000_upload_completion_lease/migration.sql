-- AlterTable
ALTER TABLE "UploadSession" ADD COLUMN "completionToken" TEXT,
ADD COLUMN "completionLeaseUntil" TIMESTAMP(3),
ADD COLUMN "completionGeneration" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "UploadSession_status_completionLeaseUntil_idx" ON "UploadSession"("status", "completionLeaseUntil");
