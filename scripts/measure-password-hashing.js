/*
 * Measures what password hashing does to the event loop, to justify the worker-pool design (issue #49):
 *   node scripts/measure-password-hashing.js
 * Reports, for a cost-12 comparison: single latency, and event-loop delay under concurrent bursts when run
 * in-process, in 2 worker threads (what the API does), and with crypto.scrypt (assessed, not adopted: it would
 * need a hash-format migration). Results are not asserted anywhere; they are evidence for docs/DEPLOYMENT.md.
 */
const bcrypt = require("bcryptjs");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const crypto = require("node:crypto");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

if (!isMainThread) {
  parentPort.on("message", async ({ id, password, hash }) => parentPort.postMessage({ id, ok: await bcrypt.compare(password, hash) }));
  return;
}

async function lagDuring(label, burst) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = process.hrtime.bigint();
  await burst();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  h.disable();
  console.log(`${label.padEnd(46)} total ${ms.toFixed(0).padStart(6)} ms | loop delay p50 ${(h.percentile(50) / 1e6).toFixed(1).padStart(6)} p99 ${(h.percentile(99) / 1e6).toFixed(1).padStart(6)} max ${(h.max / 1e6).toFixed(1).padStart(6)} ms`);
}

(async () => {
  const hash12 = await bcrypt.hash("Correct-Horse-1234", 12);
  let t = process.hrtime.bigint(); await bcrypt.compare("wrong-Password-1", hash12);
  console.log("single bcryptjs cost-12 compare:", (Number(process.hrtime.bigint() - t) / 1e6).toFixed(0), "ms");
  for (const n of [1, 8, 32]) {
    await lagDuring(`in-process bcryptjs x${n} concurrent`, () => Promise.all(Array.from({ length: n }, () => bcrypt.compare("wrong-Password-1", hash12))));
  }
  const salt = crypto.randomBytes(16);
  await lagDuring("crypto.scrypt (threadpool) x8 [N=2^15 r=8]", () => Promise.all(Array.from({ length: 8 }, () => new Promise((res, rej) => crypto.scrypt("wrong-Password-1", salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k))))));
  const pool = Array.from({ length: 2 }, () => new Worker(__filename));
  let id = 0; const pending = new Map();
  for (const w of pool) w.on("message", ({ id: i }) => { pending.get(i)(); pending.delete(i); });
  const viaWorker = (k) => new Promise((res) => { const i = ++id; pending.set(i, res); pool[k % pool.length].postMessage({ id: i, password: "wrong-Password-1", hash: hash12 }); });
  for (const n of [8, 32]) await lagDuring(`bcryptjs in 2 worker threads x${n} concurrent`, () => Promise.all(Array.from({ length: n }, (_, k) => viaWorker(k))));
  await Promise.all(pool.map((w) => w.terminate()));
})();
