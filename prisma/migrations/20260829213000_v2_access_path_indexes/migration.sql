CREATE INDEX IF NOT EXISTS "User_status_createdAt_idx"
ON "User"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "User_planId_idx"
ON "User"("planId");

CREATE INDEX IF NOT EXISTS "Folder_userId_createdAt_idx"
ON "Folder"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "File_userId_status_createdAt_idx"
ON "File"("userId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "File_userId_originalName_idx"
ON "File"("userId", "originalName");

CREATE INDEX IF NOT EXISTS "File_folderId_idx"
ON "File"("folderId");

CREATE INDEX IF NOT EXISTS "DownloadToken_userId_expiresAt_idx"
ON "DownloadToken"("userId", "expiresAt");

CREATE INDEX IF NOT EXISTS "DownloadToken_fileId_expiresAt_idx"
ON "DownloadToken"("fileId", "expiresAt");

CREATE INDEX IF NOT EXISTS "DownloadToken_expiresAt_idx"
ON "DownloadToken"("expiresAt");

CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"
ON "AuditLog"("createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx"
ON "AuditLog"("action", "createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_userId_createdAt_idx"
ON "AuditLog"("userId", "createdAt");
