DROP INDEX IF EXISTS "User_status_createdAt_idx";
DROP INDEX IF EXISTS "Folder_userId_createdAt_idx";
DROP INDEX IF EXISTS "File_userId_status_createdAt_idx";
DROP INDEX IF EXISTS "AuditLog_createdAt_idx";
DROP INDEX IF EXISTS "AuditLog_action_createdAt_idx";
DROP INDEX IF EXISTS "AuditLog_userId_createdAt_idx";

CREATE INDEX "User_status_createdAt_id_idx"
ON "User"("status", "createdAt", "id");

CREATE INDEX "User_createdAt_id_idx"
ON "User"("createdAt", "id");

CREATE INDEX "Folder_userId_createdAt_id_idx"
ON "Folder"("userId", "createdAt", "id");

CREATE INDEX "File_userId_status_createdAt_id_idx"
ON "File"("userId", "status", "createdAt", "id");

CREATE INDEX "AuditLog_createdAt_id_idx"
ON "AuditLog"("createdAt", "id");

CREATE INDEX "AuditLog_action_createdAt_id_idx"
ON "AuditLog"("action", "createdAt", "id");

CREATE INDEX "AuditLog_userId_createdAt_id_idx"
ON "AuditLog"("userId", "createdAt", "id");
