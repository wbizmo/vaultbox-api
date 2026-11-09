"use strict";
const { AppError } = require("./errors");

// Every folder-associating mutation calls this under the owner's User lock.
// A shared row lock serializes with folder deletion's FOR UPDATE, so a folder
// cannot disappear after validation but before the file/session commits.
async function assertOwnedFolderLocked(tx, userId, folderId) {
  if (folderId == null) return null;
  const rows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "Folder" WHERE "id" = $1 AND "userId" = $2 FOR SHARE',
    folderId,
    userId
  );
  if (!rows.length) throw new AppError(404, "FOLDER_NOT_FOUND", "Folder not found");
  return folderId;
}

module.exports = { assertOwnedFolderLocked };
