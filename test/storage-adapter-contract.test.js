const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const { LocalStorageAdapter } = require("../src/lib/storage");
const { MemoryStorageAdapter } = require("./../scripts/memory-storage-adapter");

/*
 * Issue #56: one behavioral contract for the storage adapter interface the routes depend on, executed
 * against every implementation (the local-disk adapter and an in-memory one), so alternate providers
 * and failure-injection adapters can be trusted to behave the same way for range reads, missing objects,
 * upload-part lifecycle and assembly.
 */

const BYTES = crypto.randomBytes(200_000);
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const writeObject = (adapter, key, bytes) => pipeline(Readable.from([bytes]), adapter.createWriteStream(key));

const implementations = {
  local: () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbox-contract-"));
    return { adapter: new LocalStorageAdapter(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  },
  memory: () => ({ adapter: new MemoryStorageAdapter(), cleanup: () => {} })
};

for (const [name, create] of Object.entries(implementations)) {
  test(`[${name}] objects: write once, read ranges, detect missing, delete`, async (t) => {
    const { adapter, cleanup } = create();
    t.after(cleanup);
    await adapter.ready();
    const file = { storedName: "object-1" };

    assert.equal(await adapter.existsFile(file), false);
    await assert.rejects(adapter.openReadStreamForFile(file), { code: "ENOENT" });

    await writeObject(adapter, file.storedName, BYTES);
    assert.equal(await adapter.existsFile(file), true);
    assert.equal(await adapter.exists(file.storedName), true);

    // Whole object, inclusive ranges, a single byte, the tail, and an end beyond EOF (clamped).
    assert.equal(Buffer.compare(await collect(await adapter.openReadStreamForFile(file)), BYTES), 0);
    assert.equal(Buffer.compare(await collect(await adapter.openReadStreamForFile(file, { start: 10, end: 99 })), BYTES.subarray(10, 100)), 0);
    assert.equal(Buffer.compare(await collect(await adapter.openReadStreamForFile(file, { start: 5, end: 5 })), BYTES.subarray(5, 6)), 0);
    assert.equal(Buffer.compare(await collect(await adapter.openReadStreamForFile(file, { start: BYTES.length - 3, end: BYTES.length - 1 })), BYTES.subarray(-3)), 0);
    assert.equal(Buffer.compare(await collect(await adapter.openReadStreamForFile(file, { start: 150_000, end: 10_000_000 })), BYTES.subarray(150_000)), 0);

    // An existing key is never overwritten.
    await assert.rejects(writeObject(adapter, file.storedName, Buffer.from("other")), { code: "EEXIST" });
    assert.equal(Buffer.compare(await collect(await adapter.openReadStreamForFile(file)), BYTES), 0);

    assert.equal(await adapter.deleteFile(file), true);
    assert.equal(await adapter.deleteFile(file), false, "deleting a missing object is a quiet false");
    assert.equal(await adapter.existsFile(file), false);
  });

  test(`[${name}] upload parts: lifecycle, ordered assembly with exact size and SHA-256, cleanup`, async (t) => {
    const { adapter, cleanup } = create();
    t.after(cleanup);
    await adapter.ready();
    const sessionId = "session_1";
    await adapter.prepareUploadSession(sessionId);

    const slices = [BYTES.subarray(0, 70_000), BYTES.subarray(70_000, 70_001), BYTES.subarray(70_001)];
    const parts = [];
    for (const [index, slice] of slices.entries()) {
      const storedName = `p${index}`;
      assert.equal(await adapter.existsUploadPart(sessionId, storedName), false);
      await pipeline(Readable.from([slice]), adapter.createUploadPartWriteStream(sessionId, storedName));
      assert.equal(await adapter.existsUploadPart(sessionId, storedName), true);
      parts.push({ partNumber: index, storedName });
    }

    const assembled = await adapter.assembleUploadParts(sessionId, parts, "assembled-1");
    assert.equal(assembled.size, BigInt(BYTES.length));
    assert.equal(assembled.checksum, sha256(BYTES));
    assert.equal(Buffer.compare(await collect(await adapter.openReadStreamForFile({ storedName: "assembled-1" })), BYTES), 0);

    // A missing part is reported by number and stored name, and leaves no assembled object behind.
    assert.equal(await adapter.deleteUploadPart(sessionId, "p1"), true);
    assert.equal(await adapter.deleteUploadPart(sessionId, "p1"), false);
    await assert.rejects(adapter.assembleUploadParts(sessionId, parts, "assembled-2"), (error) => {
      assert.equal(error.code, "ENOENT");
      assert.equal(error.uploadPartNumber, 1);
      assert.equal(error.uploadPartStoredName, "p1");
      return true;
    });
    assert.equal(await adapter.exists("assembled-2"), false);

    // An already-aborted signal refuses to start and leaves nothing behind.
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(adapter.assembleUploadParts(sessionId, parts, "assembled-3", { signal: aborted.signal }), { name: "AbortError" });
    assert.equal(await adapter.exists("assembled-3"), false);

    await adapter.deleteUploadSessionChunks(sessionId);
    assert.equal(await adapter.existsUploadPart(sessionId, "p0"), false);
    await adapter.deleteUploadSessionChunks(sessionId); // idempotent
  });

  test(`[${name}] keys that could escape the store or the session are refused`, async (t) => {
    const { adapter, cleanup } = create();
    t.after(cleanup);
    await adapter.ready();
    if (name === "memory") return; // path safety is a property of disk-backed adapters
    assert.throws(() => adapter.resolve("../outside"), /Invalid storage key/);
    assert.throws(() => adapter.resolveUploadSession("../x"), /Invalid upload session id/);
    assert.throws(() => adapter.resolveUploadPart("s", "../x"), /Invalid upload part key/);
  });
}
