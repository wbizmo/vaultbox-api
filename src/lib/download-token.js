const crypto = require("crypto");

function createDownloadToken() {
  const raw = crypto.randomBytes(32).toString("base64url");
  return {
    raw,
    hash: hashDownloadToken(raw)
  };
}

function hashDownloadToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function etagForChecksum(checksum) {
  return checksum ? `"sha256-${checksum}"` : null;
}

module.exports = {
  createDownloadToken,
  hashDownloadToken,
  etagForChecksum
};
