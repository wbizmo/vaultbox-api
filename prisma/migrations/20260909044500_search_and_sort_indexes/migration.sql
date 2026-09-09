CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS "File_userId_originalName_idx";

CREATE INDEX "File_originalName_trgm_idx"
ON "File" USING GIN ("originalName" gin_trgm_ops);

CREATE INDEX "User_name_trgm_idx"
ON "User" USING GIN ("name" gin_trgm_ops);

CREATE INDEX "User_email_trgm_idx"
ON "User" USING GIN ("email" gin_trgm_ops);

CREATE INDEX "File_userId_status_updatedAt_id_idx"
ON "File"("userId", "status", "updatedAt", "id");

CREATE INDEX "File_userId_status_size_id_idx"
ON "File"("userId", "status", "size", "id");

CREATE INDEX "File_userId_status_originalName_id_idx"
ON "File"("userId", "status", "originalName", "id");
