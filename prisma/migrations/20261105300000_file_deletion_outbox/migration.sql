-- CreateEnum
CREATE TYPE "FileDeletionStatus" AS ENUM ('PENDING', 'DONE', 'DEAD');

-- CreateTable
CREATE TABLE "FileDeletion" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "status" "FileDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FileDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FileDeletion_fileId_key" ON "FileDeletion"("fileId");

-- CreateIndex
CREATE INDEX "FileDeletion_status_nextAttemptAt_idx" ON "FileDeletion"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FileDeletion_userId_idx" ON "FileDeletion"("userId");
