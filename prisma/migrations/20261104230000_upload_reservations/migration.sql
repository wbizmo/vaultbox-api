-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('PENDING', 'COMMITTED', 'RELEASED');

-- CreateTable
CREATE TABLE "UploadReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'PENDING',
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UploadReservation_state_leaseUntil_idx" ON "UploadReservation"("state", "leaseUntil");

-- CreateIndex
CREATE INDEX "UploadReservation_userId_state_idx" ON "UploadReservation"("userId", "state");

-- AddForeignKey
ALTER TABLE "UploadReservation" ADD CONSTRAINT "UploadReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
