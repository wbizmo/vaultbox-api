const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { once } = require("events");

class LocalStorageAdapter {
  constructor(root = path.join(process.cwd(), "storage", "uploads")) {
    this.root = path.resolve(root);
    this.partsRoot = path.join(this.root, ".chunks");
  }

  async ready() {
    await Promise.all([
      fs.promises.mkdir(this.root, { recursive: true }),
      fs.promises.mkdir(this.partsRoot, { recursive: true })
    ]);
  }

  assertInsideRoot(candidate) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage path escaped the storage root");
    }
    return resolved;
  }

  resolve(key) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      throw new Error("Invalid storage key");
    }
    return this.assertInsideRoot(path.join(this.root, key));
  }

  resolveFile(file) {
    if (!file?.storedName) throw new Error("Stored file key is missing");

    if (/^[a-zA-Z0-9._-]+$/.test(file.storedName)) {
      return this.resolve(file.storedName);
    }

    return this.assertInsideRoot(path.join(this.root, file.storedName));
  }

  resolveUploadSession(sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid upload session id");
    return this.assertInsideRoot(path.join(this.partsRoot, sessionId));
  }

  resolveUploadPart(sessionId, storedName) {
    if (!/^[a-zA-Z0-9._-]+$/.test(storedName)) throw new Error("Invalid upload part key");
    return this.assertInsideRoot(path.join(this.resolveUploadSession(sessionId), storedName));
  }

  createWriteStream(key) {
    return fs.createWriteStream(this.resolve(key), { flags: "wx" });
  }

  createReadStream(key, options = {}) {
    return fs.createReadStream(this.resolve(key), options);
  }

  createReadStreamForFile(file, options = {}) {
    return fs.createReadStream(this.resolveFile(file), options);
  }

  async openReadStreamForFile(file, options = {}) {
    const handle = await fs.promises.open(this.resolveFile(file), "r");
    return handle.createReadStream(options);
  }

  async prepareUploadSession(sessionId) {
    await fs.promises.mkdir(this.resolveUploadSession(sessionId), { recursive: false });
  }

  createUploadPartWriteStream(sessionId, storedName) {
    return fs.createWriteStream(this.resolveUploadPart(sessionId, storedName), { flags: "wx" });
  }

  async existsUploadPart(sessionId, storedName) {
    try {
      await fs.promises.access(this.resolveUploadPart(sessionId, storedName), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async deleteUploadPart(sessionId, storedName) {
    try {
      await fs.promises.unlink(this.resolveUploadPart(sessionId, storedName));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async deleteUploadSessionChunks(sessionId) {
    await fs.promises.rm(this.resolveUploadSession(sessionId), { recursive: true, force: true });
  }

  async assembleUploadParts(sessionId, parts, finalKey) {
    const outputPath = this.resolve(finalKey);
    const output = fs.createWriteStream(outputPath, { flags: "wx" });
    const hash = crypto.createHash("sha256");
    let bytes = 0n;

    try {
      for (const part of parts) {
        const input = fs.createReadStream(this.resolveUploadPart(sessionId, part.storedName));
        try {
          for await (const chunk of input) {
            hash.update(chunk);
            bytes += BigInt(chunk.length);
            if (!output.write(chunk)) await once(output, "drain");
          }
        } catch (error) {
          error.uploadPartNumber = part.partNumber;
          error.uploadPartStoredName = part.storedName;
          throw error;
        }
      }

      output.end();
      await once(output, "finish");
      return { size: bytes, checksum: hash.digest("hex") };
    } catch (error) {
      output.destroy();
      await fs.promises.unlink(outputPath).catch(() => {});
      throw error;
    }
  }

  async stat(key) {
    return fs.promises.stat(this.resolve(key));
  }

  async exists(key) {
    try {
      await fs.promises.access(this.resolve(key), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async existsFile(file) {
    try {
      await fs.promises.access(this.resolveFile(file), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key) {
    try {
      await fs.promises.unlink(this.resolve(key));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async deleteFile(file) {
    try {
      await fs.promises.unlink(this.resolveFile(file));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
}

const storage = new LocalStorageAdapter();

module.exports = {
  LocalStorageAdapter,
  storage
};
