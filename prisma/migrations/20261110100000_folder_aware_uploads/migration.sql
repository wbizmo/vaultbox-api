-- The optional folder is evaluated at commit time; a deleted folder is cleared
-- from open upload sessions by the folder-deletion transaction.
ALTER TABLE "UploadSession" ADD COLUMN "folderId" TEXT;
CREATE INDEX "File_userId_status_folderId_createdAt_id_idx"
  ON "File"("userId", "status", "folderId", "createdAt", "id");
