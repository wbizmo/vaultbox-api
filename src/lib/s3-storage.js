"use strict";

const { Writable, PassThrough, Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");
const {
  S3Client, HeadBucketCommand, HeadObjectCommand, PutObjectCommand,
  GetObjectCommand, ListObjectsV2Command,
  DeleteObjectCommand, DeleteObjectsCommand
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;
const SAFE_SESSION = /^[A-Za-z0-9_-]+$/;

function isMissing(error) {
  return error?.name === "NoSuchKey" ||
    error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;
}

function translateMissing(error) {
  if (!isMissing(error)) return error;
  const e = new Error("Stored object not found");
  e.code = "ENOENT";
  e.cause = error;
  return e;
}

function makePrefix(prefix) {
  if (prefix == null || prefix === "") return "";
  if (!/^[A-Za-z0-9._/-]{1,160}$/.test(prefix) || prefix.includes("..") || prefix.includes("//") || prefix.startsWith("/")) {
    throw new Error("Invalid S3 object prefix");
  }
  return prefix.replace(/\/+$/, "") + "/";
}

/**
 * A real Node Writable that only resolves its final() after the remote Put/MPU has
 * completed. A premature downstream failure cancels the MPU. A streaming failure
 * must never be mistaken for success merely because the last local buffer flushed.
 */
class S3UploadWritable extends Writable {
  constructor(client, params, { partSize = 5 * 1024 * 1024, queueSize = 2, assertAvailable } = {}) {
    super({ highWaterMark: 64 * 1024 });
    this.client = client;
    this.params = params;
    this.partSize = partSize;
    this.queueSize = queueSize;
    this.assertAvailable = assertAvailable;
    this.body = new PassThrough({ highWaterMark: 64 * 1024 });
    this.remote = null;
    this.completion = null;
    this.pendingDrain = null;
  }

  async _construct(callback) {
    try {
      // Fail before writing any bytes when the destination already exists.
      // S3 conditional writes remain required for the concurrent-create race.
      if (this.assertAvailable) await this.assertAvailable();
      this.remote = new Upload({
        client: this.client,
        params: { ...this.params, Body: this.body },
        queueSize: this.queueSize,
        partSize: this.partSize,
        leavePartsOnError: false
      });
      this.completion = this.remote.done();
      this.completion.catch((error) => {
        if (!this.destroyed) this.destroy(error);
      });
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _write(chunk, encoding, callback) {
    if (this.destroyed) return callback(new Error("S3 writer closed"));
    if (this.body.write(chunk)) return callback();
    const onDrain = () => {
      this.body.off("error", onError);
      this.pendingDrain = null;
      callback();
    };
    const onError = (error) => {
      this.body.off("drain", onDrain);
      this.pendingDrain = null;
      callback(error);
    };
    this.pendingDrain = { onDrain, onError };
    this.body.once("drain", onDrain);
    this.body.once("error", onError);
  }

  _final(callback) {
    this.body.end();
    this.completion.then(() => callback(), (error) => callback(error));
  }

  _destroy(error, callback) {
    if (this.pendingDrain) {
      this.body.off("drain", this.pendingDrain.onDrain);
      this.body.off("error", this.pendingDrain.onError);
      this.pendingDrain = null;
    }
    if (!this.body.destroyed) this.body.destroy();
    // Abort only incomplete transfers; a completed S3 object is preserved.
    if (!this.writableFinished && this.remote) {
      Promise.resolve(this.remote.abort()).catch(() => {});
    }
    callback(error);
  }
}

class S3StorageAdapter {
  constructor({ bucket, region, endpoint, forcePathStyle = false, prefix = "vaultbox", sse = "AES256", client, verifyConditionalWrites = true } = {}) {
    if (!bucket || typeof bucket !== "string") throw new Error("S3_BUCKET must be configured");
    if (!region || typeof region !== "string") throw new Error("S3_REGION must be configured");
    this.bucket = bucket;
    this.prefix = makePrefix(prefix);
    this.sse = sse || undefined;
    this.verifyConditionalWrites = verifyConditionalWrites;
    this.client = client || new S3Client({ region, ...(endpoint ? { endpoint } : {}), forcePathStyle });
  }

  objectKey(key) {
    if (typeof key !== "string" || !SAFE_KEY.test(key)) throw new Error("Invalid storage key");
    return this.prefix + "objects/" + key;
  }

  // Old local installations may have nested, spaced or otherwise non-UUID
  // storedName values. Never pass those names through the strict new-upload
  // key API or interpolate them into arbitrary S3 prefixes. A deterministic
  // one-way mapping retains the DB storedName without renaming user files.
  objectKeyForFile(file) {
    const name = file?.storedName;
    if (typeof name !== "string" || !name || name.includes("\\0")) {
      throw new Error("Stored file key is missing or invalid");
    }
    if (SAFE_KEY.test(name)) return this.objectKey(name);
    // Multiple legacy File rows may share a local path. Bind the remote key to
    // the immutable DB File ID too, so deleting one tenant's migrated object
    // never deletes another tenant's object.
    if (typeof file.id !== "string" || !file.id) {
      throw new Error("Legacy storage key requires a File ID");
    }
    return this.prefix + "objects/legacy/" +
      crypto.createHash("sha256").update(file.id + "\0" + name, "utf8").digest("hex");
  }

  partKey(sessionId, storedName) {
    if (!SAFE_SESSION.test(String(sessionId))) throw new Error("Invalid upload session id");
    if (!SAFE_KEY.test(String(storedName))) throw new Error("Invalid upload part key");
    return this.prefix + "parts/" + sessionId + "/" + storedName;
  }

  uploadParams(key) {
    return {
      Bucket: this.bucket,
      Key: key,
      ...(this.sse ? { ServerSideEncryption: this.sse } : {}),
      IfNoneMatch: "*"
    };
  }

  async ready() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    if (!this.verifyConditionalWrites) return;

    // Fail closed for S3-compatible providers that silently ignore If-None-Match.
    // A conditional Put must reject overwrite, or concurrent object creation is unsafe.
    const Key = this.prefix + ".probes/" + crypto.randomUUID();
    try {
      await this.client.send(new PutObjectCommand({
        ...this.uploadParams(Key), Body: "vaultbox-write-once"
      }));
      let rejected = false;
      try {
        await this.client.send(new PutObjectCommand({
          ...this.uploadParams(Key), Body: "unexpected-overwrite"
        }));
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 412 || error.name === "PreconditionFailed") {
          rejected = true;
        } else {
          throw error;
        }
      }
      if (!rejected) {
        throw new Error("S3 provider ignored If-None-Match: *; refusing unsafe object storage");
      }
    } finally {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })).catch(() => {});
    }
  }

  writerForKey(key) {
    return new S3UploadWritable(this.client, this.uploadParams(key), {
      assertAvailable: async () => {
        if (await this.existsKey(key)) {
          const error = new Error("Storage destination already exists");
          error.code = "EEXIST";
          throw error;
        }
      }
    });
  }

  createWriteStream(key) {
    return this.writerForKey(this.objectKey(key));
  }

  createWriteStreamForFile(file) {
    return this.writerForKey(this.objectKeyForFile(file));
  }

  createUploadPartWriteStream(sessionId, storedName) {
    return this.writerForKey(this.partKey(sessionId, storedName));
  }

  async prepareUploadSession(sessionId) {
    this.partKey(sessionId, "validate");
  }

  async openReadStream(key, options = {}) {
    const range = options.start !== undefined || options.end !== undefined
      ? "bytes=" + (options.start ?? 0) + "-" + (options.end ?? "")
      : undefined;
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        ...(range ? { Range: range } : {})
      }), ...(options.signal ? [{ abortSignal: options.signal }] : []));
      if (!response.Body) throw new Error("S3 response body is missing");
      if (typeof response.Body.pipe === "function") return response.Body;
      return Readable.from(response.Body);
    } catch (error) {
      throw translateMissing(error);
    }
  }

  async openReadStreamForFile(file, options = {}) {
    if (!file?.storedName) throw new Error("Stored file key is missing");
    return this.openReadStream(this.objectKeyForFile(file), options);
  }

  async exists(key) {
    return this.existsKey(this.objectKey(key));
  }

  async existsFile(file) {
    if (!file?.storedName) return false;
    return this.existsKey(this.objectKeyForFile(file));
  }

  async existsUploadPart(sessionId, storedName) {
    return this.existsKey(this.partKey(sessionId, storedName));
  }

  async existsKey(key) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  // HEAD is the only provider call required to age-check a claimed object.
  // No bucket-wide inventory permissions are needed to reconcile FILE/ASSEMBLY.
  async objectLastModified(key) {
    try {
      const response = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket, Key: this.objectKey(key)
      }));
      if (!response.LastModified) throw new Error("S3 object LastModified unavailable; refusing orphan deletion");
      const value = new Date(response.LastModified);
      if (!Number.isFinite(value.getTime())) throw new Error("Invalid S3 object LastModified");
      return value;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async stat(key) {
    const response = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket, Key: this.objectKey(key)
    }));
    return { size: Number(response.ContentLength) };
  }

  async delete(key) { return this.deleteKey(this.objectKey(key)); }
  async deleteFile(file) { return this.deleteKey(this.objectKeyForFile(file)); }
  async deleteUploadPart(sessionId, storedName) {
    return this.deleteKey(this.partKey(sessionId, storedName));
  }

  async deleteKey(key) {
    // DeleteObject is idempotent; a missing object is a successful cleanup.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    return true;
  }

  async deleteUploadSessionChunks(sessionId) {
    this.partKey(sessionId, "validate");
    const prefix = this.prefix + "parts/" + sessionId + "/";
    let token;
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000,
        ...(token ? { ContinuationToken: token } : {})
      }));
      const objects = (response.Contents || []).map(({ Key }) => ({ Key }));
      if (objects.length) {
        const deleted = await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects, Quiet: true }
        }));
        if (deleted.Errors?.length) throw new Error("S3 chunk cleanup failed for " + deleted.Errors.length + " objects");
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
  }

  async assembleUploadParts(sessionId, parts, finalKey, { signal } = {}) {
    const self = this;
    const hash = crypto.createHash("sha256");
    let bytes = 0n;
    const concatenate = async function* () {
      for (const part of parts) {
        let input;
        try {
          input = await self.openReadStream(self.partKey(sessionId, part.storedName), { signal });
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
          input?.destroy?.();
        }
      }
    };
    const output = this.createWriteStream(finalKey);
    try {
      await pipeline(concatenate(), output, { signal });
      return { size: bytes, checksum: hash.digest("hex") };
    } catch (error) {
      output.destroy();
      // createWriteStream uses IfNoneMatch: *, so we never delete an existing
      // destination belonging to another operation after an ownership conflict.
      // S3 MPU cancellation is handled in the writer.
      throw error;
    }
  }
}

module.exports = { S3StorageAdapter, S3UploadWritable, isMissing };
