/*
 * Test support: a stand-in for lib/password-worker.js whose timing and failures the tests control.
 * (Lives in scripts/ because every file under test/ is executed as a test.)
 *   - answers every task after TEST_WORKER_DELAY_MS (default 300);
 *   - a password of exactly "crash" kills this worker thread, to prove the pool recovers.
 */
const { parentPort } = require("node:worker_threads");

const delay = Number(process.env.TEST_WORKER_DELAY_MS || 300);

parentPort.on("message", (task) => {
  if (task.password === "crash") process.exit(1);
  setTimeout(() => {
    parentPort.postMessage({ id: task.id, ok: true, value: task.op === "compare" ? true : "$2b$04$stub" });
  }, delay);
});
