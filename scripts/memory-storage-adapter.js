/*
 * Test support (not production code): an in-memory implementation of the storage adapter interface the
 * routes use (see src/lib/storage.js). It exists to prove that every upload and download path goes
 * through the adapter injected into the app (`app.vaultboxStorage`) and to run the same contract suite
 * against more than one implementation.
 */
const crypto = require("node:crypto");
const { Readable, Writable } = require("node:stream");

function enoent(what) {
  const error = new Error(`ENOENT: no such ${what}`);
  error.code = "ENOENT";
  return error;
}

class MemoryStorageAdapter {
  constructor() {
    this.files = new Map();
    this.parts = new Map();
    this.sessions = new Set();
    this.openStreams = new Set();
  }

  async ready() {}

  partKey(sessionId, storedName) {
    return `${sessionId}/${storedName}`;
  }

  writer(map, key) {
    const chunks = [];
    return new Writable({
      // Like fs.createWriteStream(path, { flags: "wx" }): an existing key surfaces as an asynchronous
      // stream error, never as a synchronous throw.
      construct(callback) {
        if (map.has(key)) {
          const error = new Error("EEXIST: file already exists");
          error.code = "EEXIST";
          callback(error);
          return;
        }
        callback();
      },
      write(chunk, _enc, callback) {
        chunks.push(chunk);
        callback();
      },
      final(callback) {
        map.set(key, Buffer.concat(chunks));
        callback();
      }
    });
  }

  reader(buffer, { start = 0, end = buffer.length - 1 } = {}) {
    const slice = buffer.subarray(start, Math.min(end, buffer.length - 1) + 1);
    const stream = Readable.from((function* chunks() {
      for (let offset = 0; offset < slice.length; offset += 16 * 1024) {
        yield slice.subarray(offset, offset + 16 * 1024);
      }
    })());
    this.openStreams.add(stream);
    stream.once("close", () => this.openStreams.delete(stream));
    return stream;
  }

  createWriteStream(key) {
    return this.writer(this.files, key);
  }

  createReadStream(key, options) {
    if (!this.files.has(key)) throw enoent("file");
    return this.reader(this.files.get(key), options);
  }

  async openReadStreamForFile(file, options) {
    if (!this.files.has(file.storedName)) throw enoent("file");
    return this.reader(this.files.get(file.storedName), options);
  }

  async prepareUploadSession(sessionId) {
    this.sessions.add(sessionId);
  }

  createUploadPartWriteStream(sessionId, storedName) {
    return this.writer(this.parts, this.partKey(sessionId, storedName));
  }

  async existsUploadPart(sessionId, storedName) {
    return this.parts.has(this.partKey(sessionId, storedName));
  }

  async deleteUploadPart(sessionId, storedName) {
    return this.parts.delete(this.partKey(sessionId, storedName));
  }

  async deleteUploadSessionChunks(sessionId) {
    for (const key of [...this.parts.keys()]) {
      if (key.startsWith(`${sessionId}/`)) this.parts.delete(key);
    }
    this.sessions.delete(sessionId);
  }

  async assembleUploadParts(sessionId, parts, finalKey, { signal } = {}) {
    signal?.throwIfAborted();
    const pieces = [];
    for (const part of parts) {
      const buffer = this.parts.get(this.partKey(sessionId, part.storedName));
      if (!buffer) {
        const error = enoent("upload part");
        error.uploadPartNumber = part.partNumber;
        error.uploadPartStoredName = part.storedName;
        throw error;
      }
      pieces.push(buffer);
    }
    const whole = Buffer.concat(pieces);
    if (this.files.has(finalKey)) {
      const error = new Error("EEXIST: file already exists");
      error.code = "EEXIST";
      throw error;
    }
    this.files.set(finalKey, whole);
    return { size: BigInt(whole.length), checksum: crypto.createHash("sha256").update(whole).digest("hex") };
  }

  async stat(key) {
    if (!this.files.has(key)) throw enoent("file");
    return { size: this.files.get(key).length };
  }

  async exists(key) {
    return this.files.has(key);
  }

  async existsFile(file) {
    return this.files.has(file.storedName);
  }

  async delete(key) {
    return this.files.delete(key);
  }

  async deleteFile(file) {
    return this.files.delete(file.storedName);
  }
}

module.exports = { MemoryStorageAdapter };
