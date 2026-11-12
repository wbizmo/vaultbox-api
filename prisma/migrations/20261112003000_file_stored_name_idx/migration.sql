-- One statement, no BEGIN: avoid blocking File writes during production cutover.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "File_storedName_idx" ON "File" ("storedName");
