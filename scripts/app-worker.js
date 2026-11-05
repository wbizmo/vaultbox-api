/*
 * Test support: runs the real application in its own process on an ephemeral port, so tests can
 * exercise two independent instances (separate process, separate connection pool) against one database.
 * Sends { port } to the parent over IPC once listening.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const { LocalStorageAdapter } = require("../src/lib/storage");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbox-app-worker-"));
const app = buildApp({
  logger: false,
  storage: new LocalStorageAdapter(root),
  config: {
    nodeEnv: "test",
    isProduction: false,
    corsOrigins: [],
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: "1h",
    maxUploadBytes: 1024 * 1024,
    uploadChunkBytes: 1024,
    uploadSessionExpiresMinutes: 60,
    uploadMaxParts: 10000,
    uploadSuggestedParallelParts: 4,
    uploadCompletionLeaseSeconds: 30,
    uploadReservationLeaseSeconds: 30,
    idempotencyLockTimeoutMs: Number(process.env.WORKER_IDEMPOTENCY_LOCK_TIMEOUT_MS) || 5000,
    downloadTokenExpiresMinutes: 10,
    downloadSuggestedPartBytes: 1024,
    downloadMaxRanges: 4
  }
});

app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
  process.send({ port: app.server.address().port });
});
