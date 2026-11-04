const crypto = require("node:crypto");

// Postgres: 40P01 deadlock_detected, 40001 serialization_failure. Prisma: P2034 write conflict/deadlock.
const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);

function isRetryableConflict(error) {
  if (!error) return false;
  if (error.code === "P2034") return true;
  if (RETRYABLE_SQLSTATES.has(error.code) || RETRYABLE_SQLSTATES.has(error.meta?.code)) return true;
  return /deadlock detected|could not serialize access/i.test(String(error.message || ""));
}

/**
 * Run an idempotent unit of work, retrying a bounded number of times with
 * jittered exponential backoff when PostgreSQL reports a deadlock or
 * serialization failure. `fn` must be safe to re-run from the start.
 */
async function retryOnConflict(fn, { attempts = 4, baseDelayMs = 20, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!isRetryableConflict(error) || attempt === attempts - 1) throw error;
      lastError = error;
      const jitter = crypto.randomInt(0, baseDelayMs);
      await sleep(baseDelayMs * 2 ** attempt + jitter);
    }
  }
  throw lastError;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { retryOnConflict, isRetryableConflict };
