CREATE INDEX "UploadSession_status_updatedAt_id_idx" ON "UploadSession"("status", "updatedAt", "id");
CREATE INDEX "DownloadToken_expiresAt_id_idx" ON "DownloadToken"("expiresAt", "id");
