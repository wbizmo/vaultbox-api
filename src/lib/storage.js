const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

/** Resolve once the stream has closed (bounded, so a misbehaving custom writer cannot stall cleanup). */
function whenClosed(stream, timeoutMs = 5000) {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    stream.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

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

  /**
   * Final object writer for assembly. A separate method so tests can inject writers that fail,
   * stall or close mid-write.
   */
  createAssemblyOutputStream(outputPath) {
    return fs.createWriteStream(outputPath, { flags: "wx" });
  }

  /**
   * Concatenate the parts, in the given order, into the final object while hashing (SHA-256) and
   * counting every byte exactly once, using bounded memory.
   *
   * Composed with stream.pipeline so that backpressure, an error or an unexpected close on either side,
   * and an abort `signal` all settle the returned promise promptly and tear down every stream and file
   * descriptor involved (a hand-written write/drain loop only listened for "drain" and could wait forever
   * on a writer that was destroyed meanwhile). On any failure the partial output is removed -- but only
   * if this call's output stream actually opened (created) the file: ownership is tracked through the
   * stream's "open" event, so an object that already existed ("wx" refuses it) is never deleted, even when
   * an upstream error such as a missing part wins the race against the open error. An output stream that
   * creates a file at `outputPath` must emit "open" once it has.
   */
  async assembleUploadParts(sessionId, parts, finalKey, { signal } = {}) {
    const outputPath = this.resolve(finalKey);
    const hash = crypto.createHash("sha256");
    let bytes = 0n;
    const resolvePart = (storedName) => this.resolveUploadPart(sessionId, storedName);

    async function* concatenate() {
      for (const part of parts) {
        const input = fs.createReadStream(resolvePart(part.storedName));
        try {
          for await (const chunk of input) {
            hash.update(chunk);
            bytes += BigInt(chunk.length);
            yield chunk;
          }
        } catch (error) {
          error.uploadPartNumber = part.partNumber;
          error.uploadPartStoredName = part.storedName;
          throw error;
        } finally {
          input.destroy();
        }
      }
    }

    const output = this.createAssemblyOutputStream(outputPath);
    let created = false;
    output.once("open", () => {
      created = true;
    });

    try {
      await pipeline(concatenate, output, { signal });
      return { size: bytes, checksum: hash.digest("hex") };
    } catch (error) {
      await whenClosed(output); // an open that was still in flight when the pipeline failed has now resolved
      if (created) await fs.promises.unlink(outputPath).catch(() => {});
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

function createStorageFromEnvironment(env = process.env) {
  const backend = (env.STORAGE_BACKEND || "local").toLowerCase();
  if (backend === "local") {
    return new LocalStorageAdapter(env.LOCAL_STORAGE_ROOT);
  }
  if (backend !== "s3") throw new Error("STORAGE_BACKEND must be local or s3");
  if (!env.S3_BUCKET || !env.S3_REGION) {
    throw new Error("S3_BUCKET and S3_REGION are mandatory when STORAGE_BACKEND=s3");
  }
  const { S3StorageAdapter } = require("./s3-storage");
  if (env.S3_FORCE_PATH_STYLE && !["true", "false"].includes(env.S3_FORCE_PATH_STYLE)) {
    throw new Error("S3_FORCE_PATH_STYLE must be true or false");
  }
  return new S3StorageAdapter({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    prefix: env.S3_OBJECT_PREFIX ?? "vaultbox",
    sse: env.S3_SERVER_SIDE_ENCRYPTION ?? "AES256",
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true"
  });
}

const storage = createStorageFromEnvironment();

module.exports = {
  LocalStorageAdapter,
  createStorageFromEnvironment,
  storage
};
