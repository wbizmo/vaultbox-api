/*
 * Worker-thread side of the password hasher (see password-hasher.js). bcryptjs is pure JavaScript: a cost-12
 * comparison keeps one thread busy for ~300 ms, so running it on the main thread starves every other request
 * (measured: 8 concurrent comparisons delay the event loop by ~0.8 s, 32 by ~3.2 s). Here it only occupies this
 * worker. One task at a time; the plaintext password exists only inside this message.
 */
const { parentPort } = require("node:worker_threads");
const bcrypt = require("bcryptjs");

parentPort.on("message", async (task) => {
  try {
    if (task.op === "compare") {
      // A stored value that is not a valid bcrypt hash is simply "no match": an error here would make an
      // account with a damaged hash distinguishable from every other failure.
      let matches = false;
      try {
        matches = await bcrypt.compare(task.password, task.hash);
      } catch {
        matches = false;
      }
      parentPort.postMessage({ id: task.id, ok: true, value: matches });
    } else if (task.op === "hash") {
      parentPort.postMessage({ id: task.id, ok: true, value: await bcrypt.hash(task.password, task.rounds) });
    } else {
      parentPort.postMessage({ id: task.id, ok: false, error: "unknown task" });
    }
  } catch {
    // Never echo the underlying error: it could carry input.
    parentPort.postMessage({ id: task.id, ok: false, error: "hashing failed" });
  }
});
