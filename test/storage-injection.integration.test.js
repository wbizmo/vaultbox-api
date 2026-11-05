const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter, storage: defaultStorage } = require("../src/lib/storage");
const { createDownloadToken } = require("../src/lib/download-token");
const { MemoryStorageAdapter } = require("../scripts/memory-storage-adapter");

/*
 * Issue #56: every upload and download path goes through the adapter injected into the app (not a
 * module-global one); a client that disconnects mid-download releases its stream and file descriptor;
 * and shutdown cancels an in-flight assembly, cleaning up and leaving the upload session retryable.
 */

const config = {
  nodeEnv: "test",
  isProduction: false,
  corsOrigins: [],
  jwtSecret: "storage-injection-secret-long-enough-for-tests",
  jwtExpiresIn: "1h",
  maxUploadBytes: 64 * 1024 * 1024,
  uploadChunkBytes: 4,
  uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000,
  uploadSuggestedParallelParts: 4,
  uploadCompletionLeaseSeconds: 30,
  uploadReservationLeaseSeconds: 30,
  downloadTokenExpiresMinutes: 10,
  downloadSuggestedPartBytes: 1024,
  downloadMaxRanges: 4
};
const fdCount = () => fs.readdirSync("/proc/self/fd").length;
const linuxOnly = { skip: process.platform !== "linux" && "needs /proc/self/fd" };
const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

function multipart(bytes, filename = "part.bin") {
  const boundary = `----vaultbox${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function fixture(t, storage) {
  const plan = await prisma.plan.create({
    data: { name: `inj-${crypto.randomUUID()}`, priceMonthly: 0, storageLimit: 100_000_000n }
  });
  const user = await prisma.user.create({
    data: { name: "Inj", email: `inj-${crypto.randomUUID()}@example.com`, password: "x", planId: plan.id }
  });
  const app = buildApp({ config, storage, logger: false });
  await app.ready();
  const headers = { authorization: `Bearer ${app.jwt.sign({ id: user.id })}` };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };

  t.after(async () => {
    await close();
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.downloadToken.deleteMany({ where: { userId: user.id } });
    await prisma.uploadPart.deleteMany({ where: { session: { userId: user.id } } });
    await prisma.uploadSession.deleteMany({ where: { userId: user.id } });
    await prisma.uploadReservation.deleteMany({ where: { userId: user.id } });
    await prisma.file.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
  });

  async function resumableSession(bytes) {
    const created = await app.inject({
      method: "POST",
      url: "/upload-sessions",
      headers,
      payload: { originalName: "inj.bin", mimeType: "application/octet-stream", expectedSize: bytes.length }
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().session.id;
    for (let part = 0; part * 4 < bytes.length; part += 1) {
      const slice = bytes.subarray(part * 4, Math.min(bytes.length, part * 4 + 4));
      const body = multipart(slice);
      const res = await app.inject({
        method: "PUT",
        url: `/upload-sessions/${id}/parts/${part}`,
        headers: {
          ...headers,
          "content-type": body.contentType,
          "content-range": `bytes ${part * 4}-${part * 4 + slice.length - 1}/${bytes.length}`
        },
        payload: body.payload
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    return id;
  }
  const complete = (id) => app.inject({ method: "POST", url: `/upload-sessions/${id}/complete`, headers });
  const download = async (fileId, extra = {}) => {
    const issued = await app.inject({ method: "POST", url: `/files/${fileId}/download-token`, headers });
    assert.equal(issued.statusCode, 200, issued.body);
    return app.inject({ method: "GET", url: issued.json().downloadUrl, ...extra });
  };
  return { app, user, headers, resumableSession, complete, download, close };
}

test("upload (one-shot and resumable) and download all run through the injected adapter", async (t) => {
  const memory = new MemoryStorageAdapter();
  const f = await fixture(t, memory);

  // One-shot upload.
  const oneShotBytes = crypto.randomBytes(5000);
  const body = multipart(oneShotBytes, "one-shot.bin");
  const uploaded = await f.app.inject({
    method: "POST",
    url: "/files/upload",
    headers: { ...f.headers, "content-type": body.contentType },
    payload: body.payload
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const oneShot = await prisma.file.findFirst({ where: { userId: f.user.id, originalName: "one-shot.bin" } });
  assert.equal(Buffer.compare(memory.files.get(oneShot.storedName), oneShotBytes), 0, "bytes landed in the injected adapter");

  // Resumable upload, assembled by the adapter.
  const resumableBytes = Buffer.from("0123456789abcdefghij");
  const id = await f.resumableSession(resumableBytes);
  const completed = await f.complete(id);
  assert.equal(completed.statusCode, 200, completed.body);
  const resumable = await prisma.file.findFirst({ where: { userId: f.user.id, originalName: "inj.bin" } });
  assert.equal(Buffer.compare(memory.files.get(resumable.storedName), resumableBytes), 0);
  assert.equal(memory.parts.size, 0, "part objects were cleaned up through the adapter");

  // Downloads, whole and ranged, read from the injected adapter.
  const whole = await f.download(oneShot.id);
  assert.equal(whole.statusCode, 200);
  assert.equal(Buffer.compare(whole.rawPayload, oneShotBytes), 0);
  const ranged = await f.download(resumable.id, { headers: { range: "bytes=4-9" } });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.rawPayload.toString(), "456789");

  // Nothing touched the process-wide default store.
  for (const storedName of [oneShot.storedName, resumable.storedName]) {
    assert.equal(await defaultStorage.exists(storedName), false, "the default adapter was never used");
  }
});

test("a client that disconnects mid-download releases the stream and its file descriptor", linuxOnly, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vaultbox-disconnect-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const opened = [];
  class TrackingStorage extends LocalStorageAdapter {
    async openReadStreamForFile(file, options) {
      const stream = await super.openReadStreamForFile(file, options);
      opened.push(stream);
      return stream;
    }
  }
  const storage = new TrackingStorage(root);
  const f = await fixture(t, storage);

  const big = crypto.randomBytes(24 * 1024 * 1024);
  const storedName = crypto.randomUUID();
  await fsp.writeFile(path.join(root, storedName), big);
  const file = await prisma.file.create({
    data: {
      originalName: "big.bin", storedName, mimeType: "application/octet-stream", size: BigInt(big.length),
      path: storedName, checksum: crypto.createHash("sha256").update(big).digest("hex"), userId: f.user.id
    }
  });
  const token = createDownloadToken();
  await prisma.downloadToken.create({
    data: { token: token.hash, fileId: file.id, userId: f.user.id, expiresAt: new Date(Date.now() + 60_000) }
  });

  await f.app.listen({ port: 0, host: "127.0.0.1" });
  const port = f.app.server.address().port;
  const baseline = fdCount();

  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: `/download/${token.raw}` }, (res) => {
        res.once("data", () => {
          res.pause();
          res.destroy(); // client goes away after the first chunk, with most of the file unsent
          resolve();
        });
      });
      req.on("error", () => {});
      setTimeout(() => reject(new Error("no data received")), 5000).unref?.();
    });
  }

  const allClosed = await waitFor(() => opened.length === 5 && opened.every((stream) => stream.destroyed));
  assert.ok(allClosed, "every abandoned read stream was destroyed");
  const released = await waitFor(() => fdCount() <= baseline);
  assert.ok(released, `file descriptors returned to baseline (${baseline} -> ${fdCount()})`);
});

test("shutdown cancels an in-flight assembly: 503 + Retry-After, no object left, upload retryable", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vaultbox-shutdown-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let entered;
  const writing = new Promise((resolve) => { entered = resolve; });
  class StallingStorage extends LocalStorageAdapter {
    createAssemblyOutputStream(outputPath) {
      const real = super.createAssemblyOutputStream(outputPath);
      return new Writable({
        highWaterMark: 4,
        construct(callback) {
          real.once("open", () => {
            this.emit("open"); // the adapter contract: a writer that creates the file announces it
            callback();
          });
          real.once("error", callback);
        },
        write() {
          entered(); // the callback is never invoked: the disk "stalls" until the assembly is cancelled
        },
        destroy(error, callback) {
          real.destroy();
          callback(error);
        }
      });
    }
  }
  const f = await fixture(t, new StallingStorage(root));
  const id = await f.resumableSession(Buffer.from("abcdefghijkl"));

  const pending = f.complete(id);
  await writing; // assembly is mid-write
  const closing = f.close(); // preClose aborts the shutdown signal
  const response = await pending;
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.headers["retry-after"], "5");
  await closing;

  const session = await prisma.uploadSession.findUnique({ where: { id } });
  assert.equal(session.status, "UPLOADING", "completion was given back so the client can retry");
  const objects = (await fsp.readdir(root)).filter((name) => name !== ".chunks");
  assert.deepEqual(objects, [], "the partial object was removed");
  assert.equal(await prisma.file.count({ where: { userId: f.user.id } }), 0);
});
