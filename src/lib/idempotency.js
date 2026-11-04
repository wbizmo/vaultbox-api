const crypto = require("node:crypto");
const prisma = require("./prisma");

/*
 * Durable, actor-scoped idempotency (PostgreSQL is the only authority).
 *
 * A request is identified by (userId, operation, key). The claim of that identity and the business
 * mutation commit in ONE transaction:
 *
 *   INSERT claim (unique on userId, operation, key)  -> mutate -> store the response -> COMMIT
 *
 * Consequences:
 *  - Different users can reuse the same key without ever interfering (the user is part of the identity).
 *  - There is no "pending" record to expire, so a slow earlier request can never overwrite a newer
 *    claim: it either owns the uncommitted claim row (concurrent duplicates wait on it) or it is a
 *    committed row to replay. A request that fails rolls back its claim and can simply be retried.
 *  - If the mutation committed but the HTTP response (or anything after) was lost, the retry finds
 *    the committed row and replays the ORIGINAL result.
 *  - Redis is not involved, so Redis outages, restarts and per-instance fallbacks cannot cause
 *    duplicate execution across replicas.
 *
 * A concurrent identical request waits for the first to commit and replays its result; if the wait
 * exceeds the lock timeout the caller receives IDEMPOTENCY_IN_PROGRESS (HTTP 409 + Retry-After).
 *
 * Waiting is deliberately narrow:
 *  - Same-key requests are serialised by a transaction-scoped advisory lock taken FIRST, and the lock
 *    timeout applies only to that wait. It is cleared afterwards, so a timeout can only mean "an
 *    identical request is still running" -- never a wait on the User row that the claim's and the
 *    folder's foreign-key checks may take behind unrelated quota transactions.
 *  - A bounded in-process gate limits how many idempotent transactions may hold a pooled connection
 *    at once; further callers queue in memory (no connection held) and replay as soon as they run.
 *  - A committed, unexpired record is replayed by a plain read without opening a transaction.
 */

/** Bounded concurrency gate: waiters queue in memory and hold no database connection. */
function createGate({ concurrency = 3, maxQueue = 256 } = {}) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < concurrency && queue.length > 0) {
      const waiter = queue.shift();
      clearTimeout(waiter.timer);
      active += 1;
      waiter.resolve(() => {
        active -= 1;
        next();
      });
    }
  };
  return {
    get active() { return active; },
    get queued() { return queue.length; },
    acquire(timeoutMs) {
      if (active < concurrency && queue.length === 0) {
        active += 1;
        return Promise.resolve(() => {
          active -= 1;
          next();
        });
      }
      if (queue.length >= maxQueue) return Promise.reject(inProgressError());
      return new Promise((resolve, reject) => {
        const waiter = { resolve };
        waiter.timer = setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(inProgressError());
        }, timeoutMs);
        waiter.timer.unref?.();
        queue.push(waiter);
      });
    }
  };
}

function inProgressError() {
  const error = new Error("An identical request is still in progress");
  error.code = "IDEMPOTENCY_IN_PROGRESS";
  return error;
}

const MAX_CONCURRENT = Math.max(1, Number.parseInt(process.env.IDEMPOTENCY_MAX_CONCURRENT || "", 10) || 3);
const gate = createGate({ concurrency: MAX_CONCURRENT });

const KEY_PATTERN = /^[A-Za-z0-9._:~-]{1,128}$/;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_SQLSTATE = "55P03";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonicalize(value[name])]));
  }
  return value ?? null;
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** Returns null for an absent key, the trimmed key when valid; throws IDEMPOTENCY_KEY_INVALID otherwise. */
function validateIdempotencyKey(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Array.isArray(raw) ? raw.join(",") : String(raw).trim();
  if (!KEY_PATTERN.test(value)) {
    const error = new Error("Idempotency-Key must be 1-128 characters of letters, digits and . _ : ~ -");
    error.code = "IDEMPOTENCY_KEY_INVALID";
    throw error;
  }
  return value;
}

function isLockTimeout(error) {
  return error?.meta?.code === LOCK_TIMEOUT_SQLSTATE
    || error?.code === LOCK_TIMEOUT_SQLSTATE
    || /lock timeout|canceling statement due to lock timeout/i.test(String(error?.message || ""));
}

/**
 * Run `execute(tx)` at most once for (userId, operation, key).
 *
 * `execute` receives the transaction client and must return { status, body } (JSON-serialisable);
 * everything it writes commits atomically with the idempotency record.
 *
 * Resolves to { replayed: boolean, status, body } or { mismatch: true } when the key was already
 * used by this user for this operation with a different payload.
 */
async function runIdempotent({
  userId,
  operation,
  key,
  payload,
  execute,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  client = prisma,
  gate: activeGate = gate
}) {
  const requestFingerprint = fingerprint(payload);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const timeoutMs = Math.max(1, Math.floor(lockTimeoutMs));

  // Fast path: a committed, unexpired record is replayed by a plain read (no transaction, no gate).
  const known = await client.idempotencyKey.findUnique({
    where: { userId_operation_key: { userId, operation, key } }
  });
  if (known && known.expiresAt > new Date() && known.status !== null) {
    if (known.fingerprint !== requestFingerprint) return { mismatch: true };
    return { replayed: true, status: known.status, body: known.response };
  }

  const release = await activeGate.acquire(timeoutMs);
  try {
    return await client.$transaction(async (tx) => {
      // 1. Serialise identical requests. ONLY this wait is bounded by the lock timeout.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}|${operation}|${key}`}, 0))`;
      // 2. Everything after runs without the timeout, like any other write in the system.
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");

      // Claim, or take over an EXPIRED record. The advisory lock guarantees no identical request is
      // mid-flight, so a conflict here is always against a committed record.
      const claimed = await tx.$queryRaw`
        INSERT INTO "IdempotencyKey" ("id", "userId", "operation", "key", "fingerprint", "expiresAt")
        VALUES (${crypto.randomUUID()}, ${userId}, ${operation}, ${key}, ${requestFingerprint}, ${expiresAt})
        ON CONFLICT ("userId", "operation", "key") DO UPDATE
          SET "fingerprint" = EXCLUDED."fingerprint",
              "status" = NULL,
              "response" = NULL,
              "createdAt" = NOW(),
              "expiresAt" = EXCLUDED."expiresAt"
          WHERE "IdempotencyKey"."expiresAt" < NOW()
        RETURNING "id"
      `;

      if (claimed.length === 0) {
        const existing = await tx.idempotencyKey.findUnique({
          where: { userId_operation_key: { userId, operation, key } }
        });
        if (!existing) {
          // Deleted between the conflict and the read (pruned); retry as a fresh request.
          const retryable = new Error("Idempotency record vanished; retry");
          retryable.code = "P2034";
          throw retryable;
        }
        if (existing.fingerprint !== requestFingerprint) return { mismatch: true };
        return { replayed: true, status: existing.status, body: existing.response };
      }

      const outcome = await execute(tx);
      const body = JSON.parse(JSON.stringify(outcome.body ?? null));
      await tx.idempotencyKey.update({
        where: { id: claimed[0].id },
        data: { status: outcome.status, response: body }
      });
      return { replayed: false, status: outcome.status, body };
    }, { maxWait: 15000, timeout: 30000 });
  } catch (error) {
    // The timeout is only ever armed around the advisory-lock wait, so this really means
    // "an identical request is still running".
    if (isLockTimeout(error)) throw inProgressError();
    throw error;
  } finally {
    release();
  }
}

/** Delete records that expired more than `graceSeconds` ago, in a bounded batch. */
async function pruneExpiredIdempotencyKeys(client = prisma, { limit = 500, graceSeconds = 3600 } = {}) {
  const cutoff = new Date(Date.now() - graceSeconds * 1000);
  return client.$executeRaw`
    DELETE FROM "IdempotencyKey"
    WHERE "id" IN (
      SELECT "id" FROM "IdempotencyKey" WHERE "expiresAt" < ${cutoff} ORDER BY "expiresAt" LIMIT ${limit}
    )
  `;
}

module.exports = {
  KEY_PATTERN,
  createGate,
  MAX_CONCURRENT,
  fingerprint,
  validateIdempotencyKey,
  runIdempotent,
  pruneExpiredIdempotencyKeys
};
