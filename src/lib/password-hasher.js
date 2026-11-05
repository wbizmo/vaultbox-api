const path = require("node:path");
const { Worker } = require("node:worker_threads");

/*
 * Password hashing/verification off the main thread, with an explicit budget (issue #49).
 *
 *  - `concurrency` worker threads run bcryptjs (so the event loop stays responsive: measured ~5-10 ms of loop
 *    delay under a 32-way burst, versus ~3.2 s when the same burst runs in-process);
 *  - at most `maxQueue` requests wait for a worker, each for at most `maxWaitMs`; beyond that the caller is
 *    refused immediately with PASSWORD_VERIFICATION_BUSY (routes answer 503 + Retry-After) instead of piling up
 *    unbounded CPU work -- an attacker's burst is shed, it does not stall everyone;
 *  - workers are created lazily, referenced only while a task is in flight (an idle pool never keeps a process
 *    alive), replaced if one dies, and terminated by close().
 * The stored hash format is unchanged (bcrypt), so there is no migration.
 */

const BCRYPT_ROUNDS = 12;
// A valid bcrypt hash at the production cost, of a password nobody knows. Unknown accounts are compared against
// it so they cost the same as a real comparison.
const DUMMY_HASH = "$2b$12$FbWF9Ghi20Ox4cuXUK/EEOH.IqnyWFsh9AO28OYfJlnKAnLdw3nCO";

function busyError(reason) {
  const error = new Error("Password verification is busy");
  error.code = "PASSWORD_VERIFICATION_BUSY";
  error.reason = reason;
  error.retryAfterSeconds = 2;
  return error;
}

function createPasswordHasher({
  concurrency = 2,
  maxQueue = 64,
  maxWaitMs = 5000,
  rounds = BCRYPT_ROUNDS,
  workerPath = path.join(__dirname, "password-worker.js")
} = {}) {
  const size = Math.max(1, Math.floor(concurrency));
  const limit = Math.max(0, Math.floor(maxQueue));
  const workers = []; // { worker, task }
  const queue = [];
  let nextId = 0;
  let closed = false;
  const stats = { started: 0, completed: 0, rejectedQueueFull: 0, rejectedWaitTimeout: 0, workerFailures: 0 };

  function spawn() {
    const slot = { worker: new Worker(workerPath), task: null };
    slot.worker.unref();
    slot.worker.on("message", (message) => {
      const task = slot.task;
      if (!task || task.id !== message.id) return;
      slot.task = null;
      slot.worker.unref();
      stats.completed += 1;
      if (message.ok) task.resolve(message.value);
      else task.reject(new Error("Password hashing failed"));
      pump();
    });
    const lost = () => {
      const index = workers.indexOf(slot);
      if (index >= 0) workers.splice(index, 1);
      if (slot.task) {
        stats.workerFailures += 1;
        const { task } = slot;
        slot.task = null;
        task.reject(busyError("worker-lost"));
      }
      if (!closed) pump();
    };
    slot.worker.on("error", lost);
    slot.worker.on("exit", lost);
    workers.push(slot);
    return slot;
  }

  function idleSlot() {
    return workers.find((slot) => !slot.task) || (workers.length < size ? spawn() : null);
  }

  function pump() {
    while (!closed && queue.length > 0) {
      const slot = idleSlot();
      if (!slot) return;
      const task = queue.shift();
      clearTimeout(task.timer);
      slot.task = task;
      slot.worker.ref(); // an in-flight task must keep the process alive until it answers
      stats.started += 1;
      slot.worker.postMessage(task.payload);
    }
  }

  function submit(payload) {
    if (closed) return Promise.reject(busyError("closed"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const task = { id, payload: { ...payload, id }, resolve, reject, timer: null };
      const slot = idleSlot();
      if (!slot && queue.length >= limit) {
        stats.rejectedQueueFull += 1;
        reject(busyError("queue-full"));
        return;
      }
      queue.push(task);
      if (!slot) {
        task.timer = setTimeout(() => {
          const index = queue.indexOf(task);
          if (index >= 0) queue.splice(index, 1);
          stats.rejectedWaitTimeout += 1;
          reject(busyError("wait-timeout"));
        }, maxWaitMs);
      }
      pump();
    });
  }

  return {
    rounds,
    compare: (password, hash) => submit({ op: "compare", password, hash }),
    hash: (password) => submit({ op: "hash", password, rounds }),
    /** Counters and gauges only; no identities. */
    stats: () => ({
      concurrency: size,
      maxQueue: limit,
      active: workers.filter((slot) => slot.task).length,
      queued: queue.length,
      ...stats
    }),
    async close() {
      closed = true;
      for (const task of queue.splice(0)) {
        clearTimeout(task.timer);
        task.reject(busyError("closed"));
      }
      await Promise.all(workers.splice(0).map(async (slot) => {
        if (slot.task) slot.task.reject(busyError("closed"));
        slot.task = null;
        await slot.worker.terminate().catch(() => {});
      }));
    }
  };
}

module.exports = { createPasswordHasher, BCRYPT_ROUNDS, DUMMY_HASH, busyError };
