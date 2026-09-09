-- CreateEnum
CREATE TYPE "UploadSessionStatus" AS ENUM ('UPLOADING', 'COMPLETING', 'COMPLETED', 'ABORTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "reservedUploadBytes" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "expectedSize" BIGINT NOT NULL,
    "expectedChecksum" TEXT,
    "chunkSize" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'UPLOADING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fileId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadPart" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "offset" BIGINT NOT NULL,
    "size" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UploadPart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_fileId_key" ON "UploadSession"("fileId");
CREATE INDEX "UploadSession_userId_status_expiresAt_idx" ON "UploadSession"("userId", "status", "expiresAt");
CREATE INDEX "UploadSession_status_expiresAt_idx" ON "UploadSession"("status", "expiresAt");
CREATE INDEX "UploadSession_userId_createdAt_idx" ON "UploadSession"("userId", "createdAt");
CREATE UNIQUE INDEX "UploadPart_sessionId_partNumber_key" ON "UploadPart"("sessionId", "partNumber");
CREATE INDEX "UploadPart_sessionId_offset_idx" ON "UploadPart"("sessionId", "offset");

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UploadPart" ADD CONSTRAINT "UploadPart_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "UploadSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
