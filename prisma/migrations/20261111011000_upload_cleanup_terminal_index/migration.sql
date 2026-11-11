-- Benchmarked: the older (status, updatedAt, id) index cannot satisfy
-- global updatedAt ordering across three terminal status values; the
-- 10k-session terminal-claim EXPLAIN used a full Seq Scan and Sort.
-- This partial index only tracks terminal sessions with uncleaned chunks.
CREATE INDEX "UploadSession_cleanup_terminal_due_idx"
ON "UploadSession" ("updatedAt", "id")
WHERE "chunksCleanedAt" IS NULL
  AND "status" IN (
    'COMPLETED'::"UploadSessionStatus",
    'ABORTED'::"UploadSessionStatus",
    'EXPIRED'::"UploadSessionStatus"
  );
