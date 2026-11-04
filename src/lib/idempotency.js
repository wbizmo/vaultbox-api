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
 */

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
  client = prisma
}) {
  const requestFingerprint = fingerprint(payload);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(lockTimeoutMs))}ms'`);

      // Claim, or take over an EXPIRED record. A live unexpired record conflicts and returns no row;
      // a concurrent uncommitted claim makes this statement wait for its outcome.
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
    if (isLockTimeout(error)) {
      const inProgress = new Error("An identical request is still in progress");
      inProgress.code = "IDEMPOTENCY_IN_PROGRESS";
      throw inProgress;
    }
    throw error;
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
  fingerprint,
  validateIdempotencyKey,
  runIdempotent,
  pruneExpiredIdempotencyKeys
};
