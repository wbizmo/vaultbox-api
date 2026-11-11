-- Additive ledger: temp objects and their owners persist across process death.
CREATE TABLE "TemporaryObject" (
 "id" TEXT NOT NULL,
 "userId" TEXT NOT NULL,
 "objectKey" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "bytes" BIGINT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'ACTIVE',
 "token" TEXT NOT NULL,
 "leaseUntil" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TemporaryObject_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "TemporaryObject_bytes_nonnegative_check" CHECK ("bytes" >= 0)
);
CREATE UNIQUE INDEX "TemporaryObject_objectKey_key" ON "TemporaryObject"("objectKey");
CREATE INDEX "TemporaryObject_userId_state_idx" ON "TemporaryObject"("userId", "state");
CREATE INDEX "TemporaryObject_state_leaseUntil_idx" ON "TemporaryObject"("state", "leaseUntil");
