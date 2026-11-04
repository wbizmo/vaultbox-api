/*
 * Test support: runs the real application in its own process and hangs forever at a chosen phase
 * of a one-shot upload so a test can SIGKILL it there (an abrupt crash that runs no cleanup).
 *
 *   PHASE = reservation-tx | before-stream | mid-stream | after-bytes | in-commit-tx
 *
 * Messages to the parent: { port } once listening, { reached: PHASE } when the phase is hit.
 */
const { Writable } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const buildApp = require("../src/app");
const prisma = require("../src/lib/prisma");
const { LocalStorageAdapter } = require("../src/lib/storage");

const phase = process.env.PHASE;
const hang = () => new Promise(() => {});
const reached = () => process.send({ reached: phase });

class CrashStorage extends LocalStorageAdapter {
  createWriteStream(key) {
    if (phase === "before-stream") {
      reached();
      return new Writable({ write() {} });
    }
    const real = super.createWriteStream(key);
    if (phase === "mid-stream") {
      let first = true;
      return new Writable({
        write(chunk, encoding, callback) {
          real.write(chunk, encoding, () => {
            if (first) {
              first = false;
              reached();
              return; // never acknowledge the chunk: the upload is stuck mid-stream
            }
            callback();
          });
        }
      });
    }
    if (phase === "after-bytes") {
      return new Writable({
        write(chunk, encoding, callback) {
          real.write(chunk, encoding, callback);
        },
        final() {
          real.end(() => reached()); // every byte is on disk; never finish the pipeline
        }
      });
    }
    return real;
  }
}

// The application writes through transaction clients, so interpose on $transaction.
const hangingModels = {
  "reservation-tx": ["uploadReservation", "create"], // inside the reservation tx, after the quota increment
  "in-commit-tx": ["file", "create"] // inside the commit tx, after the reservation CAS and quota conversion
};
if (hangingModels[phase]) {
  const [modelName, method] = hangingModels[phase];
  const original = prisma.$transaction.bind(prisma);
  prisma.$transaction = (fn, options) => {
    if (typeof fn !== "function") return original(fn, options);
    return original((tx) => fn(new Proxy(tx, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== modelName) return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(value, {
          get(model, name) {
            const member = Reflect.get(model, name);
            if (name !== method) return typeof member === "function" ? member.bind(model) : member;
            return async () => {
              reached();
              return hang();
            };
          }
        });
      }
    })), options);
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vaultbox-crash-worker-"));
const app = buildApp({
  logger: false,
  storage: new CrashStorage(root),
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
    downloadTokenExpiresMinutes: 10,
    downloadSuggestedPartBytes: 1024,
    downloadMaxRanges: 4
  }
});

app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
  process.send({ port: app.server.address().port });
});
