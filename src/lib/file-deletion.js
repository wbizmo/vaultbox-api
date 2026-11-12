const prisma = require("./prisma");

/*
 * Durable physical deletion of file bytes (issue #54).
 *
 * Logical deletion (File -> DELETED, quota refunded, FileDeletion row inserted) is one statement in
 * src/lib/file-delete.js, so it happens exactly once. Removing the bytes is a separate, retryable job:
 * a worker claims due rows under a lease (FOR UPDATE SKIP LOCKED), asks the storage adapter to delete,
 * and marks the row DONE -- or reschedules it with exponential backoff, and parks it as DEAD after too many
 * attempts. A missing object counts as success. Nothing here touches File or quota, so retries,
 * duplicate workers and restarts can never refund twice or resurrect a file.
 */

const DEFAULTS = {
  batchSize: 25,
  leaseMs: 2 * 60 * 1000,
  maxAttempts: 8,
  baseBackoffMs: 30 * 1000,
  maxBackoffMs: 60 * 60 * 1000
};

/** Exponential backoff with +/-20% jitter, capped. `attempts` counts the attempt that just failed. */
function backoffMs(attempts, { baseBackoffMs, maxBackoffMs } = DEFAULTS, random = Math.random) {
  const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(exponential * (0.8 + 0.4 * random()));
}

function errorSummary(error) {
  const text = `${error?.code ? `${error.code}: ` : ""}${error?.message || String(error)}`;
  return text.slice(0, 500);
}

/**
 * Claim up to `limit` due rows (optionally one specific file). Claiming bumps `attempts` and sets the lease,
 * so a worker that dies mid-delete simply lets the lease lapse and another worker (or the next sweep) retries.
 */
async function claimFileDeletions({ limit = DEFAULTS.batchSize, leaseMs = DEFAULTS.leaseMs, fileId = null, userId = null } = {}, client = prisma) {
  return client.$queryRaw`
    UPDATE "FileDeletion"
    SET "attempts" = "attempts" + 1,
        "lockedUntil" = NOW() + (${leaseMs} * INTERVAL '1 millisecond')
    WHERE "id" IN (
      SELECT "id" FROM "FileDeletion"
      WHERE "status" = 'PENDING'::"FileDeletionStatus"
        AND "nextAttemptAt" <= NOW()
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= NOW())
        AND (${fileId}::text IS NULL OR "fileId" = ${fileId})
        AND (${userId}::text IS NULL OR "userId" = ${userId})
      ORDER BY "nextAttemptAt", "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "fileId", "userId", "storedName", "size", "attempts"
  `;
}

/*
 * Settling is fenced on the attempt number this worker claimed: if its lease lapsed and another worker has
 * claimed the row since (attempts moved on), the late worker's outcome is ignored instead of overwriting
 * the newer claim. Deleting is idempotent, so the newer worker simply finishes the job.
 */
async function finishOne(storage, row, options, client) {
  try {
    // true = removed now, false = already gone: both are a finished cleanup.
    await storage.deleteFile({ id: row.fileId, storedName: row.storedName });
  } catch (error) {
    const dead = row.attempts >= options.maxAttempts;
    const delay = backoffMs(row.attempts, options);
    await client.$executeRaw`
      UPDATE "FileDeletion"
      SET "status" = ${dead ? "DEAD" : "PENDING"}::"FileDeletionStatus",
          "nextAttemptAt" = NOW() + (${delay} * INTERVAL '1 millisecond'),
          "lockedUntil" = NULL,
          "lastError" = ${errorSummary(error)}
      WHERE "id" = ${row.id} AND "status" = 'PENDING'::"FileDeletionStatus"
        AND "attempts" = ${row.attempts}
    `;
    return dead ? "dead" : "retry";
  }
  await client.$executeRaw`
    UPDATE "FileDeletion"
    SET "status" = 'DONE'::"FileDeletionStatus", "completedAt" = NOW(), "lockedUntil" = NULL, "lastError" = NULL
    WHERE "id" = ${row.id} AND "status" = 'PENDING'::"FileDeletionStatus"
      AND "attempts" = ${row.attempts}
  `;
  return "done";
}

/**
 * A job whose worker keeps dying never reaches the failure path, so attempts alone would not stop it. Once a
 * row has used all its attempts and its last lease has lapsed, park it as DEAD for an operator instead of
 * retrying a possible poison object forever. Live leases are left alone.
 */
async function deadLetterExhaustedFileDeletions(maxAttempts = DEFAULTS.maxAttempts, client = prisma) {
  return client.$executeRaw`
    UPDATE "FileDeletion"
    SET "status" = 'DEAD'::"FileDeletionStatus",
        "lockedUntil" = NULL,
        "lastError" = COALESCE("lastError", 'worker lost on its final attempt')
    WHERE "status" = 'PENDING'::"FileDeletionStatus"
      AND "attempts" >= ${maxAttempts}
      AND "lockedUntil" IS NOT NULL
      AND "lockedUntil" <= NOW()
  `;
}

/** One sweep: claim due rows and try to remove their bytes. Never throws for a single bad object. */
async function processFileDeletions(storage, overrides = {}, client = prisma) {
  const options = { ...DEFAULTS, ...overrides };
  // Housekeeping must never stop the real work: if it fails, log and carry on claiming jobs.
  await deadLetterExhaustedFileDeletions(options.maxAttempts, client).catch((error) => {
    options.log?.warn({ err: error }, "File deletion dead-letter reaper failed");
  });
  const rows = await claimFileDeletions({ limit: options.batchSize, leaseMs: options.leaseMs, fileId: options.fileId || null, userId: options.userId || null }, client);
  const outcome = { claimed: rows.length, done: 0, retry: 0, dead: 0 };
  // Every claimed row holds a lease from the moment it was claimed, so start them all at once (the batch is
  // bounded): a slow storage call must not run the clock down on the rows queued behind it.
  const results = await Promise.all(rows.map((row) => finishOne(storage, row, options, client).catch((error) => {
    // The job-state update itself failed (database trouble): the row stays claimed until its lease lapses
    // and is retried then. Record why, and carry on with the rest of the batch.
    options.log?.warn({ err: error, fileId: row.fileId }, "File deletion job state update failed");
    return "retry";
  })));
  for (const result of results) outcome[result] += 1;
  return outcome;
}

/** Try one file's cleanup right away (the DELETE request path); anything left over stays queued. */
async function removeFileBytesNow(storage, fileId, overrides = {}, client = prisma) {
  const outcome = await processFileDeletions(storage, { ...overrides, fileId, batchSize: 1 }, client);
  return outcome.done === 1;
}

/** Operator view: how many deletions are waiting or stuck and for how long. */
async function fileDeletionStats(client = prisma) {
  const rows = await client.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE "status" = 'PENDING')::int AS "pending",
      COUNT(*) FILTER (WHERE "status" = 'DEAD')::int AS "dead",
      COUNT(*) FILTER (WHERE "status" = 'PENDING' AND "attempts" > 0)::int AS "retrying",
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN("createdAt") FILTER (WHERE "status" = 'PENDING'))), 0)::int AS "oldestPendingAgeSeconds",
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN("createdAt") FILTER (WHERE "status" = 'DEAD'))), 0)::int AS "oldestDeadAgeSeconds",
      COALESCE(SUM("size") FILTER (WHERE "status" IN ('PENDING', 'DEAD')), 0)::text AS "unreclaimedBytes"
    FROM "FileDeletion"
  `;
  return rows[0];
}

/** Put dead-lettered rows back in the queue (operator action after fixing the underlying storage problem). */
async function requeueDeadFileDeletions(client = prisma) {
  return client.$executeRaw`
    UPDATE "FileDeletion"
    SET "status" = 'PENDING'::"FileDeletionStatus", "attempts" = 0, "nextAttemptAt" = NOW(), "lockedUntil" = NULL
    WHERE "status" = 'DEAD'::"FileDeletionStatus"
  `;
}

/** Finished rows are kept briefly for inspection, then pruned (bounded batch, safe on every replica). */
async function pruneFinishedFileDeletions({ olderThanDays = 7, limit = 500 } = {}, client = prisma) {
  return client.$executeRaw`
    DELETE FROM "FileDeletion"
    WHERE "id" IN (
      SELECT "id" FROM "FileDeletion"
      WHERE "status" = 'DONE'::"FileDeletionStatus"
        AND "completedAt" < NOW() - (${olderThanDays} * INTERVAL '1 day')
      LIMIT ${limit}
    )
  `;
}

module.exports = {
  DEFAULTS,
  backoffMs,
  claimFileDeletions,
  deadLetterExhaustedFileDeletions,
  processFileDeletions,
  removeFileBytesNow,
  fileDeletionStats,
  requeueDeadFileDeletions,
  pruneFinishedFileDeletions
};
