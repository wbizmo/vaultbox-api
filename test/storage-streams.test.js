const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");

const { LocalStorageAdapter } = require("../src/lib/storage");

/*
 * Issue #56: assembling an upload must settle promptly -- and release every file descriptor and the
 * partial output -- whatever happens to the output stream (error before/while backpressured, closed
 * without an error, abort), while keeping exact byte counts, SHA-256 and part order. The original
 * hand-written write/drain loop waited forever when the writer was destroyed while it awaited "drain".
 */

const fdCount = () => fs.readdirSync("/proc/self/fd").length;
const linuxOnly = { skip: process.platform !== "linux" && "needs /proc/self/fd" };
const settled = (promise, ms = 3000) => Promise.race([
  promise.then((value) => ({ value }), (error) => ({ error })),
  new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms))
]);

/** Adapter whose final-object writer is supplied by the test. */
class InjectedWriterAdapter extends LocalStorageAdapter {
  constructor(root, makeWriter) {
    super(root);
    this.makeWriter = makeWriter;
  }

  createAssemblyOutputStream(outputPath) {
    return this.makeWriter ? this.makeWriter(outputPath) : super.createAssemblyOutputStream(outputPath);
  }
}

async function fixture(t, { partSizes, makeWriter } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbox-streams-"));
  const adapter = new InjectedWriterAdapter(root, makeWriter);
  await adapter.ready();
  const sessionId = `s${crypto.randomUUID().replace(/-/g, "")}`;
  await adapter.prepareUploadSession(sessionId);
  const parts = [];
  const buffers = [];
  for (const [index, size] of (partSizes || [1000, 200_000, 1]).entries()) {
    const bytes = crypto.randomBytes(size);
    const storedName = `part-${index}`;
    fs.writeFileSync(adapter.resolveUploadPart(sessionId, storedName), bytes);
    parts.push({ partNumber: index, storedName });
    buffers.push(bytes);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { adapter, sessionId, parts, buffers, root, finalKey: "final-object" };
}

/** A writer that fails or stalls on demand. highWaterMark is tiny so the pipeline is always backpressured. */
const writerThat = (behavior, highWaterMark = 16) => () => new Writable({
  highWaterMark,
  write(_chunk, _encoding, callback) {
    behavior(this, callback);
  }
});

test("assembles exact bytes, size and SHA-256 in the given part order across chunk boundaries", async (t) => {
  const f = await fixture(t, { partSizes: [70_000, 3, 200_000, 65_536, 1] });
  const result = await f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey);
  const expected = Buffer.concat(f.buffers);
  assert.equal(result.size, BigInt(expected.length));
  assert.equal(result.checksum, crypto.createHash("sha256").update(expected).digest("hex"));
  assert.equal(Buffer.compare(fs.readFileSync(f.adapter.resolve(f.finalKey)), expected), 0);

  // Order comes from the argument, not from the part files' names.
  const reversed = [...f.parts].reverse();
  await f.adapter.assembleUploadParts(f.sessionId, reversed, "reversed-object");
  assert.equal(
    Buffer.compare(fs.readFileSync(f.adapter.resolve("reversed-object")), Buffer.concat([...f.buffers].reverse())),
    0
  );
});

test("a writer that errors while the pipeline is backpressured rejects promptly and removes the partial output", linuxOnly, async (t) => {
  const f = await fixture(t, {
    makeWriter: writerThat((writer) => setTimeout(() => writer.destroy(new Error("disk full")), 20)) // never calls back
  });
  const before = fdCount();
  const outcome = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.ok(!outcome.hung, "assembly must settle");
  assert.equal(outcome.error?.message, "disk full");
  assert.ok(!fs.existsSync(f.adapter.resolve(f.finalKey)), "partial output removed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fdCount() <= before, `descriptors released (${before} -> ${fdCount()})`);
});

test("a write callback error settles with that error", async (t) => {
  const f = await fixture(t, { makeWriter: writerThat((_writer, callback) => callback(new Error("EIO on write"))) });
  const outcome = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.ok(!outcome.hung);
  assert.equal(outcome.error?.message, "EIO on write");
  assert.ok(!fs.existsSync(f.adapter.resolve(f.finalKey)));
});

test("a writer destroyed without an error (the original hang) rejects as a premature close", linuxOnly, async (t) => {
  const f = await fixture(t, { makeWriter: writerThat((writer) => setTimeout(() => writer.destroy(), 20)) });
  const before = fdCount();
  const outcome = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.ok(!outcome.hung, "assembly must not wait forever for a drain that can no longer happen");
  assert.equal(outcome.error?.code, "ERR_STREAM_PREMATURE_CLOSE");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fdCount() <= before);
});

test("aborting mid-assembly stops it, removes the partial output and frees descriptors", linuxOnly, async (t) => {
  const controller = new AbortController();
  let writes = 0;
  const f = await fixture(t, {
    partSizes: [4 * 1024 * 1024],
    makeWriter: writerThat((_writer, callback) => {
      writes += 1;
      if (writes === 2) controller.abort();
      setTimeout(callback, 2);
    }, 64 * 1024)
  });
  const before = fdCount();
  const outcome = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey, { signal: controller.signal }));
  assert.ok(!outcome.hung);
  assert.equal(outcome.error?.name, "AbortError");
  assert.ok(writes < 64, "stopped early instead of finishing the 4 MiB");
  assert.ok(!fs.existsSync(f.adapter.resolve(f.finalKey)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fdCount() <= before);

  const already = new AbortController();
  already.abort();
  const early = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey, { signal: already.signal }));
  assert.equal(early.error?.name, "AbortError", "an already-aborted signal refuses to start");
});

test("a missing or unreadable part rejects with its identity and removes the partial output", async (t) => {
  const f = await fixture(t);
  fs.rmSync(f.adapter.resolveUploadPart(f.sessionId, "part-1"));
  const missing = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.equal(missing.error?.code, "ENOENT");
  assert.equal(missing.error?.uploadPartNumber, 1);
  assert.equal(missing.error?.uploadPartStoredName, "part-1");
  assert.ok(!fs.existsSync(f.adapter.resolve(f.finalKey)));

  fs.mkdirSync(f.adapter.resolveUploadPart(f.sessionId, "part-1")); // reading a directory fails with EISDIR
  const unreadable = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.equal(unreadable.error?.code, "EISDIR");
  assert.equal(unreadable.error?.uploadPartNumber, 1);
  assert.ok(!fs.existsSync(f.adapter.resolve(f.finalKey)));
});

test("a slow writer is never outrun: buffered output stays within the stream's high-water mark", async (t) => {
  let peak = 0;
  const f = await fixture(t, {
    partSizes: [3 * 1024 * 1024],
    makeWriter: writerThat((writer, callback) => {
      peak = Math.max(peak, writer.writableLength);
      setTimeout(callback, 0);
    }, 64 * 1024)
  });
  await f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey);
  assert.ok(peak <= 64 * 1024 + 64 * 1024, `peak buffered ${peak} bytes stays bounded for a 3 MiB object`);
});

test("assembly refuses to touch an object that already exists (and keeps it)", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.adapter.resolve(f.finalKey), "someone else's object");
  const outcome = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.equal(outcome.error?.code, "EEXIST");
  assert.equal(fs.readFileSync(f.adapter.resolve(f.finalKey), "utf8"), "someone else's object");
});

test("an upstream error that masks the open error never deletes an object that already existed", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.adapter.resolve(f.finalKey), "someone else's object");
  fs.rmSync(f.adapter.resolveUploadPart(f.sessionId, "part-0")); // the first part is missing: ENOENT races EEXIST
  const outcome = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.ok(["ENOENT", "EEXIST"].includes(outcome.error?.code), `settled with ${outcome.error?.code}`);
  assert.equal(fs.readFileSync(f.adapter.resolve(f.finalKey), "utf8"), "someone else's object");

  // The same race with the object absent: it is ours, so it is removed.
  fs.rmSync(f.adapter.resolve(f.finalKey));
  const ours = await settled(f.adapter.assembleUploadParts(f.sessionId, f.parts, f.finalKey));
  assert.equal(ours.error?.code, "ENOENT");
  assert.ok(!fs.existsSync(f.adapter.resolve(f.finalKey)));
});

test("many concurrent failing assemblies neither hang nor leak descriptors or output files", linuxOnly, async (t) => {
  const kinds = [
    writerThat((writer) => setTimeout(() => writer.destroy(new Error("boom")), 5)),
    writerThat((writer) => setTimeout(() => writer.destroy(), 5)),
    writerThat((_writer, callback) => callback(new Error("EIO")))
  ];
  const f = await fixture(t, { partSizes: [300_000, 300_000] });
  const before = fdCount();
  const runs = [];
  for (let i = 0; i < 90; i += 1) {
    const adapter = new InjectedWriterAdapter(f.root, kinds[i % kinds.length]);
    runs.push(settled(adapter.assembleUploadParts(f.sessionId, f.parts, `out-${i}`)));
  }
  const outcomes = await Promise.all(runs);
  assert.ok(outcomes.every((o) => o.error && !o.hung), "every run settled with an error");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(fdCount() <= before + 1, `descriptors released (${before} -> ${fdCount()})`);
  const leftovers = fs.readdirSync(f.root).filter((name) => name.startsWith("out-"));
  assert.deepEqual(leftovers, [], "no partial outputs remain");
});
