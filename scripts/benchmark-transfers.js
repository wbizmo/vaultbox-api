"use strict";

// This opt-in must precede the shared Prisma singleton's first import.
if (require.main === module) process.env.VAULTBOX_BENCHMARK_QUERY_COUNT = "true";
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");

const SIZES = [1, 4, 16, 32];
const UPLOAD_BYTES = Number(process.env.BENCHMARK_FILE_BYTES || 256 * 1024);
const CHUNK_BYTES = Number(process.env.BENCHMARK_CHUNK_BYTES || 64 * 1024);
let executedQueries = 0;
if (require.main === module) prisma.$on("query", () => { executedQueries += 1; });
const MAX_RSS_MB = Number(process.env.BENCHMARK_MAX_RSS_MB || 1024);
const TIMEOUT_MS = 20000;

const config = {
  nodeEnv: "test", isProduction: false, corsOrigins: [],
  jwtSecret: "vaultbox-performance-test-only-secret-2026",
  jwtExpiresIn: "1h",
  maxUploadBytes: 1024 * 1024,
  uploadChunkBytes: CHUNK_BYTES, uploadSessionExpiresMinutes: 60,
  uploadMaxParts: 10000, uploadSuggestedParallelParts: 4,
  downloadTokenExpiresMinutes: 15, downloadMaxRanges: 8,
  downloadSuggestedPartBytes: CHUNK_BYTES
};

function multipart(data) {
  const boundary = "----vaultbox-benchmark-" + crypto.randomUUID();
  return {
    body: Buffer.concat([
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"benchmark.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n"),
      data,
      Buffer.from("\r\n--" + boundary + "--\r\n")
    ]),
    type: "multipart/form-data; boundary=" + boundary
  };
}

function percentile(numbers, p) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] * 1000) / 1000;
}

function round(n) { return Math.round(n * 1000) / 1000; }

async function request(base, method, route, authorization, { headers = {}, body, binary = false } = {}) {
  const response = await fetch(base + route, {
    method, headers: { ...(authorization ? { authorization } : {}), ...headers },
    ...(body === undefined ? {} : { body }),
    signal: globalThis.AbortSignal.timeout(TIMEOUT_MS)
  });
  const payload = binary ? Buffer.from(await response.arrayBuffer()) : await response.text();
  if (!response.ok) throw new Error(method + " " + route.split("?")[0] +
    " returned " + response.status + ": " + String(payload).slice(0, 220));
  return binary ? payload : payload ? JSON.parse(payload) : {};
}

async function stage(profile, name, tasks, transferredBytes = 0) {
  const begin = performance.now();
  const cpuStart = process.cpuUsage();
  const queryStart = executedQueries;
  let peakRSS = process.memoryUsage().rss;
  const meter = setInterval(() => {
    peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
  }, 20);
  meter.unref();
  const durations = [];
  const settled = await Promise.allSettled(tasks.map(async (task) => {
    const started = performance.now();
    const result = await task();
    durations.push(performance.now() - started);
    return result;
  }));
  clearInterval(meter);
  const failures = settled.filter((result) => result.status === "rejected");
  const elapsed = performance.now() - begin;
  const cpu = process.cpuUsage(cpuStart);
  const result = {
    durationMs: round(elapsed),
    requests: tasks.length,
    failures: failures.length,
    requestsPerSecond: round(tasks.length * 1000 / elapsed),
    transferredMiBPerSecond: round(transferredBytes / 1048576 * 1000 / elapsed),
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99)
    },
    peakRSSMB: round(peakRSS / 1048576),
    cpuMs: round((cpu.user + cpu.system) / 1000),
    postgresQueryCount: Math.max(0, executedQueries - queryStart)
  };
  profile[name] = result;
  if (failures.length) {
    throw new Error(name + " failed " + failures.length + " requests: " +
      String(failures[0].reason?.message || failures[0].reason).slice(0, 300));
  }
  if (result.peakRSSMB > MAX_RSS_MB) {
    throw new Error(name + " exceeded RSS budget of " + MAX_RSS_MB + " MiB");
  }
  return settled.map(({ value }) => value);
}

async function profile(base, app, planId, concurrency, mode, userIds) {
  const holders = mode === "resumable" && concurrency >= 30 ? 2 : 1;
  const users = [];
  for (let i = 0; i < holders; i++) {
    const tag = crypto.randomUUID();
    const user = await prisma.user.create({
      data: { name: "benchmark", email: "benchmark-" + tag + "@example.invalid",
        password: "not-used", planId }
    });
    userIds.push(user.id);
    users.push({ authorization: "Bearer " + app.jwt.sign({ id: user.id }) });
  }
  const auth = (i) => users[i % users.length].authorization;
  const result = { concurrency, mode, fileBytes: UPLOAD_BYTES, chunkBytes: CHUNK_BYTES };
  const data = Buffer.alloc(UPLOAD_BYTES, 0x7c);
  const oneShot = mode === "one-shot";

  const uploads = await stage(result, oneShot ? "oneShotUpload" : "resumableInitiation",
    Array.from({ length: concurrency }, (_, i) => async () => {
      if (oneShot) {
        const form = multipart(data);
        const response = await request(base, "POST", "/files/upload", auth(i), {
          headers: { "content-type": form.type, "x-upload-size": String(data.length) },
          body: form.body
        });
        return response.file.id;
      }
      const response = await request(base, "POST", "/upload-sessions", auth(i), {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ originalName: "perf.bin", mimeType: "application/octet-stream",
          expectedSize: data.length })
      });
      return response.session.id;
    }), oneShot ? concurrency * data.length : 0);

  let fileIds = uploads;
  if (!oneShot) {
    const parts = await stage(result, "resumablePartPut",
      uploads.flatMap((sessionId, i) =>
        Array.from({ length: data.length / CHUNK_BYTES }, (_, partNumber) => async () => {
          const begin = partNumber * CHUNK_BYTES;
          const part = data.subarray(begin, begin + CHUNK_BYTES);
          const form = multipart(part);
          await request(base, "PUT", "/upload-sessions/" + sessionId + "/parts/" + partNumber, auth(i), {
            headers: {
              "content-type": form.type,
              "content-range": "bytes " + begin + "-" + (begin + part.length - 1) + "/" + data.length
            }, body: form.body
          });
          return sessionId;
        })), concurrency * data.length);
    if (parts.length !== concurrency * (data.length / CHUNK_BYTES)) throw new Error("Part count mismatch");
    const completed = await stage(result, "resumableComplete",
      uploads.map((sessionId, i) => async () => {
        const response = await request(base, "POST", "/upload-sessions/" + sessionId + "/complete", auth(i));
        return response.file.id;
      }));
    fileIds = completed;
  }

  await stage(result, "authenticatedList",
    fileIds.map((_, i) => async () => request(base, "GET", "/files?pagination=cursor&limit=10", auth(i))));
  const downloadTokens = await stage(result, "downloadToken",
    fileIds.map((fileId, i) => async () => {
      const token = await request(base, "POST", "/files/" + fileId + "/download-token", auth(i));
      return token.token;
    }));
  await stage(result, "rangedDownload",
    downloadTokens.map((token) => async () => {
      const body = await request(base, "GET", "/download/" + token, null, {
        binary: true, headers: { range: "bytes=0-4095" }
      });
      if (body.length !== 4096) throw new Error("Wrong range body length");
    }), concurrency * CHUNK_BYTES);
  await stage(result, "fileDelete",
    fileIds.map((fileId, i) => async () => request(base, "DELETE", "/files/" + fileId, auth(i))));
  return result;
}

async function main() {
  if (!Number.isSafeInteger(MAX_RSS_MB) || MAX_RSS_MB < 128) throw new Error("Invalid RSS limit");
  if (!Number.isSafeInteger(UPLOAD_BYTES) || UPLOAD_BYTES < CHUNK_BYTES ||
      UPLOAD_BYTES > config.maxUploadBytes || !Number.isSafeInteger(CHUNK_BYTES) ||
      CHUNK_BYTES <= 0 || UPLOAD_BYTES % CHUNK_BYTES !== 0) {
    throw new Error("Benchmark file/chunk sizes must be safe integers, divisible, and within max upload bytes");
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vaultbox-transfer-bench-"));
  const storage = new LocalStorageAdapter(root);
  const app = buildApp({ config, storage, logger: false, rateLimitMax: 10000 });
  const plan = await prisma.plan.create({
    data: { name: "benchmark-" + crypto.randomUUID(), priceMonthly: 0, storageLimit: 5_000_000_000n }
  });
  const userIds = [];
  const profiles = [];
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    await request(address, "GET", "/health", null); // explicit warm-up
    for (const concurrency of SIZES) {
      for (const mode of ["one-shot", "resumable"]) {
        profiles.push(await profile(address, app, plan.id, concurrency, mode, userIds));
      }
    }
    console.log(JSON.stringify({
      benchmark: "network-transfer-and-db",
      generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch,
        storage: "local", postgres: "configured", redis: "configured",
        mode: "warmed-local-HTTP", maxRSSMB: MAX_RSS_MB },
      profiles, failures: profiles.reduce((acc, p) =>
        acc + Object.values(p).filter((v) => v && typeof v === "object" && v.failures).length, 0)
    }, null, 2));
  } finally {
    await app.close().catch(() => {});
    if (userIds.length) {
      const where = { userId: { in: userIds } };
      await prisma.downloadToken.deleteMany({ where });
      await prisma.uploadSession.deleteMany({ where });
      await prisma.uploadReservation.deleteMany({ where });
      await prisma.fileDeletion.deleteMany({ where });
      await prisma.auditLog.deleteMany({ where });
      await prisma.file.deleteMany({ where });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.plan.delete({ where: { id: plan.id } });
    await fs.rm(root, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

if (require.main === module) main().catch((error) => {
  console.error("Transfer benchmark failed:", error.message);
  process.exitCode = 1;
});

module.exports = { percentile };
