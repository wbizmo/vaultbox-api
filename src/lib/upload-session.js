const crypto = require("node:crypto");
const prisma = require("./prisma");
const { releaseUploadReservation } = require("./quota");
const { retryOnConflict } = require("./db-retry");
const { AppError } = require("./errors");
const { releaseTemporary } = require("./temporary-storage");

/*
 * Lock acquisition order (documented invariant, see docs/UPLOADS.md):
 *
 *   1. "User" row (quota owner)   -- always first, via lockUserForUpdate()
 *   2. "UploadSession" row        -- always second
 *
 * Every transaction that touches both (completion commit, abort, expiry,
 * stale-completion recovery) takes them in this order, so no cycle can form.
 */
async function lockUserForUpdate(tx, userId) {
  const rows = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Account-state fence for transactions that create NEW usage (quota reservations, sessions, files,
 * folders, plan changes). Locks the user row (same position in the lock order as lockUserForUpdate)
 * and throws 403 ACCOUNT_NOT_ACTIVE unless the account is ACTIVE *now*. Because suspension updates the
 * same row, it either commits before this lock (the transaction is rejected) or waits until this
 * transaction ends (the transaction is entirely before the suspension). Returns false for an unknown user.
 *
 * Cleanup (abort, expiry, stale recovery, reservation release) deliberately uses lockUserForUpdate,
 * which never looks at the status: a suspended account must still be able to give resources back.
 */
async function lockActiveUserForUpdate(tx, userId) {
  const rows = await tx.$queryRaw`SELECT "status"::text AS "status" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  if (rows.length === 0) return false;
  assertActiveStatus(rows[0].status);
  return true;
}

/**
 * Shared-lock variant for creations that do not touch the quota counters (parts, folders, tokens):
 * concurrent creations by one account do not block each other (and cannot deadlock by upgrading a
 * foreign-key share lock), but a suspension -- an UPDATE of this row -- still cannot interleave.
 */
async function lockActiveUserShared(tx, userId, expectedAuthVersion = undefined) {
  const rows = await tx.$queryRaw`SELECT "status"::text AS "status", "authVersion" AS "authVersion" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
  if (rows.length === 0) return false;
  assertActiveStatus(rows[0].status);
  // A request authenticated before a session revocation (logout everywhere) commits must not create a
  // credential afterwards: the revocation's UPDATE of the User row waits for this lock, so the version
  // read here is the one the revocation either already bumped or has yet to bump.
  if (expectedAuthVersion !== undefined && Number(rows[0].authVersion) !== expectedAuthVersion) {
    throw new AppError(401, "SESSION_REVOKED", "Session is no longer valid; please sign in again");
  }
  return true;
}

function assertActiveStatus(status) {
  if (status !== "ACTIVE") {
    throw new AppError(403, "ACCOUNT_NOT_ACTIVE", `Account is ${String(status).toLowerCase()}`);
  }
}

const CHECKSUM_RE = /^[a-f0-9]{64}$/i;

function partGeometry(session, partNumber) {
  if (!Number.isInteger(partNumber) || partNumber < 0 || partNumber >= session.partCount) {
    const error = new Error("Invalid upload part number");
    error.code = "INVALID_UPLOAD_PART";
    throw error;
  }

  const start = BigInt(partNumber) * BigInt(session.chunkSize);
  const remaining = BigInt(session.expectedSize) - start;
  const size = remaining < BigInt(session.chunkSize) ? remaining : BigInt(session.chunkSize);
  return { start, end: start + size - 1n, size };
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || ""));
  if (!match) {
    const error = new Error("Content-Range must be 'bytes start-end/total'");
    error.code = "INVALID_CONTENT_RANGE";
    throw error;
  }
  const start = BigInt(match[1]);
  const end = BigInt(match[2]);
  const total = BigInt(match[3]);
  if (end < start) {
    const error = new Error("Content-Range end precedes start");
    error.code = "INVALID_CONTENT_RANGE";
    throw error;
  }
  return { start, end, total };
}

function validatePartRange(session, partNumber, header) {
  const expected = partGeometry(session, partNumber);
  const actual = parseContentRange(header);
  if (
    actual.start !== expected.start ||
    actual.end !== expected.end ||
    actual.total !== BigInt(session.expectedSize)
  ) {
    const error = new Error("Content-Range does not match this upload part");
    error.code = "INVALID_CONTENT_RANGE";
    throw error;
  }
  return expected;
}

function validateChecksum(value, required = false) {
  if (!value && !required) return null;
  if (!CHECKSUM_RE.test(String(value || ""))) {
    const error = new Error("Checksum must be a 64-character SHA-256 hex digest");
    error.code = "INVALID_CHECKSUM";
    throw error;
  }
  return String(value).toLowerCase();
}

function missingPartNumbers(partCount, parts) {
  const uploaded = new Set(parts.map((part) => part.partNumber));
  const missing = [];
  for (let partNumber = 0; partNumber < partCount; partNumber += 1) {
    if (!uploaded.has(partNumber)) missing.push(partNumber);
  }
  return missing;
}

function assertCompleteParts(session, parts) {
  const missing = missingPartNumbers(session.partCount, parts);
  if (missing.length) {
    const error = new Error(`Missing upload parts: ${missing.slice(0, 20).join(",")}`);
    error.code = "MISSING_UPLOAD_PARTS";
    error.missing = missing;
    throw error;
  }

  for (let partNumber = 0; partNumber < parts.length; partNumber += 1) {
    const part = parts[partNumber];
    const expected = partGeometry(session, partNumber);
    if (
      part.partNumber !== partNumber ||
      BigInt(part.offset) !== expected.start ||
      BigInt(part.size) !== expected.size ||
      !CHECKSUM_RE.test(part.checksum)
    ) {
      const error = new Error(`Upload part ${partNumber} metadata is inconsistent`);
      error.code = "INVALID_UPLOAD_PART";
      throw error;
    }
  }
}

async function releaseSession(session, targetStatus, client = prisma, { audit = null } = {}) {
  return retryOnConflict(() => client.$transaction(async (tx) => {
    await lockUserForUpdate(tx, session.userId);
    const transitioned = await tx.uploadSession.updateMany({
      where: {
        id: session.id,
        userId: session.userId,
        status: session.status
      },
      data: { status: targetStatus, completionToken: null, completionLeaseUntil: null }
    });
    if (transitioned.count !== 1) return false;
    await releaseUploadReservation(session.userId, session.expectedSize, tx);
    if (audit) await audit(tx);
    return true;
  }));
}

/**
 * Insert an uploaded part only while the session is still open for writes.
 *
 * The session row is locked FOR SHARE for the (short) duration of the insert transaction;
 * the bytes were streamed before it began, so no lock is held across the network body.
 * Claiming completion, aborting and expiring all UPDATE the session row, which conflicts with
 * FOR SHARE: they wait for in-flight inserts to commit, and any insert that begins after they
 * commit observes the closed status and is rejected. A part therefore either commits before the
 * session closes (and is in the frozen set completion reads) or is rejected -- never visible late.
 * Only the session row is locked (no User row), so the User -> UploadSession order is respected.
 *
 * Returns { part } on success or { closed: <reason> } when the session no longer accepts parts.
 */
async function insertPartIfOpen(session, data, client = prisma) {
  return client.$transaction(async (tx) => {
    // Owner first (User before UploadSession, like every other path), shared: parts of one account do
    // not block each other, but a suspension cannot interleave.
    await lockActiveUserShared(tx, session.userId);
    const rows = await tx.$queryRaw`
      SELECT "status"::text AS "status", "expiresAt" AS "expiresAt"
      FROM "UploadSession"
      WHERE "id" = ${session.id} AND "userId" = ${session.userId}
      FOR SHARE
    `;
    const current = rows[0];
    if (!current) return { closed: "MISSING" };
    if (current.status !== "UPLOADING") return { closed: current.status };
    if (new Date(current.expiresAt) <= new Date()) return { closed: "EXPIRED" };
    const part = await tx.uploadPart.create({ data: { ...data, sessionId: session.id } });
    return { part };
  });
}

/**
 * Claim the exclusive right to complete a session. Returns the fencing token, or
 * null when another completer holds it, the session left UPLOADING, or it expired.
 */
async function claimCompletion(session, leaseMs, client = prisma) {
  const token = crypto.randomUUID();
  const claimed = await client.uploadSession.updateMany({
    where: {
      id: session.id,
      userId: session.userId,
      status: "UPLOADING",
      expiresAt: { gt: new Date() }
    },
    data: {
      status: "COMPLETING",
      completionToken: token,
      completionLeaseUntil: new Date(Date.now() + leaseMs),
      completionGeneration: { increment: 1 }
    }
  });
  return claimed.count === 1 ? token : null;
}

/** Extend the lease; false means the lease was lost (recovered, aborted, or superseded). */
async function renewCompletionLease(sessionId, token, leaseMs, client = prisma) {
  const renewed = await client.uploadSession.updateMany({
    where: { id: sessionId, status: "COMPLETING", completionToken: token },
    data: { completionLeaseUntil: new Date(Date.now() + leaseMs) }
  });
  return renewed.count === 1;
}

/** Give the session back to UPLOADING, only if this token still owns it. */
async function relinquishCompletion(sessionId, token, client = prisma) {
  const reverted = await client.uploadSession.updateMany({
    where: { id: sessionId, status: "COMPLETING", completionToken: token },
    data: { status: "UPLOADING", completionToken: null, completionLeaseUntil: null }
  });
  return reverted.count === 1;
}

/**
 * Start a heartbeat that renews the lease every third of its duration. The
 * returned handle reports whether the lease is still believed to be held.
 */
function startLeaseHeartbeat(sessionId, token, leaseMs, client = prisma) {
  const state = { lost: false };
  const timer = setInterval(async () => {
    try {
      if (!(await renewCompletionLease(sessionId, token, leaseMs, client))) state.lost = true;
    } catch {
      // A transient database error must not abort a healthy completion; the
      // next tick retries and the final fenced commit is the real arbiter.
    }
  }, Math.max(250, Math.floor(leaseMs / 3)));
  timer.unref();
  return { state, stop: () => clearInterval(timer) };
}

// COMPLETING rows with no lease predate this feature (claimed before the migration, or by a
// previous-build instance during a rolling deploy); they fall back to the old age rule.
const LEGACY_COMPLETING_STALE_MS = 30 * 60 * 1000;

function staleCompletionWhere(now = new Date()) {
  return {
    status: "COMPLETING",
    OR: [
      { completionLeaseUntil: { lt: now } },
      { completionLeaseUntil: null, updatedAt: { lte: new Date(now.getTime() - LEGACY_COMPLETING_STALE_MS) } }
    ]
  };
}

function isStaleCompletion(session, now = new Date()) {
  if (session.status !== "COMPLETING") return false;
  if (session.completionLeaseUntil) return session.completionLeaseUntil < now;
  return session.updatedAt <= new Date(now.getTime() - LEGACY_COMPLETING_STALE_MS);
}

/**
 * Recover sessions whose completer stopped heartbeating (crashed or stalled).
 * Under the same lock order: a still-valid session returns to UPLOADING so the
 * client can retry; one past its expiry is expired and its reservation released once.
 * The token is cleared, so a zombie completer's fenced commit can no longer succeed.
 */
async function recoverStaleCompletion(session, client = prisma) {
  return retryOnConflict(() => client.$transaction(async (tx) => {
    await lockUserForUpdate(tx, session.userId);
    const now = new Date();
    const stale = await tx.uploadSession.findFirst({
      where: { id: session.id, ...staleCompletionWhere(now) }
    });
    if (!stale) return null;

    // Compare-and-set on exactly what was observed. The heartbeat does not take the
    // User lock, so it can renew between the read above and the writes below; a
    // renewal changes completionLeaseUntil/token and makes these updates match nothing.
    const stillStale = { id: stale.id, completionToken: stale.completionToken, ...staleCompletionWhere(now) };
    const cleared = { completionToken: null, completionLeaseUntil: null };

    if (stale.expiresAt > now) {
      const reverted = await tx.uploadSession.updateMany({
        where: stillStale,
        data: { status: "UPLOADING", ...cleared }
      });
      return reverted.count === 1 ? "UPLOADING" : null;
    }
    const expired = await tx.uploadSession.updateMany({
      where: stillStale,
      data: { status: "EXPIRED", ...cleared }
    });
    if (expired.count !== 1) return null;
    await releaseUploadReservation(stale.userId, stale.expectedSize, tx);
    return "EXPIRED";
  }));
}

async function expireIfNeeded(session, storage, client = prisma) {
  if (session.status !== "UPLOADING" || session.expiresAt > new Date()) return false;
  const expired = await releaseSession(session, "EXPIRED", client);
  if (expired) {
    try {
      await storage.deleteUploadSessionChunks(session.id);
      await client.uploadSession.updateMany({
        where: { id: session.id, status: "EXPIRED" },
        data: { chunksCleanedAt: new Date() }
      });
      await releaseTemporary("session:" + session.id, null, client);
    } catch {
      // Session is closed; the leased cleanup worker retries physical bytes.
    }
  }
  return expired;
}


const CLEANUP_DEFAULTS = Object.freeze({
  batchSize: 100, concurrency: 4, leaseSeconds: 120, deleteTimeoutMs: 30000
});

function cleanupSettings(env = process.env) {
  const v = {
    batchSize: Number(env.VAULTBOX_UPLOAD_CLEANUP_BATCH_SIZE ?? CLEANUP_DEFAULTS.batchSize),
    concurrency: Number(env.VAULTBOX_UPLOAD_CLEANUP_CONCURRENCY ?? CLEANUP_DEFAULTS.concurrency),
    leaseSeconds: Number(env.VAULTBOX_UPLOAD_CLEANUP_LEASE_SECONDS ?? CLEANUP_DEFAULTS.leaseSeconds),
    deleteTimeoutMs: Number(env.VAULTBOX_UPLOAD_CLEANUP_DELETE_TIMEOUT_MS ?? CLEANUP_DEFAULTS.deleteTimeoutMs)
  };
  for (const [key, min, max] of [
    ["batchSize", 1, 250], ["concurrency", 1, 16],
    ["leaseSeconds", 30, 600], ["deleteTimeoutMs", 1000, 120000]
  ]) {
    if (!Number.isSafeInteger(v[key]) || v[key] < min || v[key] > max) {
      throw new Error("Invalid upload cleanup setting " + key);
    }
  }
  return v;
}

let lastCleanupStats = null;
function getUploadCleanupStats() { return lastCleanupStats && { ...lastCleanupStats }; }

async function claimCleanupCandidates(client, kind, settings, now = new Date()) {
  if (!["expired", "terminal"].includes(kind)) throw new Error("Invalid cleanup kind");
  const leaseUntil = new Date(now.getTime() + settings.leaseSeconds * 1000);
  const token = crypto.randomUUID();
  const staleCutoff = new Date(now.getTime() - LEGACY_COMPLETING_STALE_MS);
  const terminalCutoff = new Date(now.getTime() - 60000);
  const where = kind === "expired"
    ? `(("status" = 'UPLOADING'::"UploadSessionStatus" AND "expiresAt" <= $1)
      OR ("status" = 'COMPLETING'::"UploadSessionStatus"
       AND (("completionLeaseUntil" IS NOT NULL AND "completionLeaseUntil" <= $1)
         OR ("completionLeaseUntil" IS NULL AND "updatedAt" <= $2))))`
    : `("status" IN ('COMPLETED'::"UploadSessionStatus",
      'ABORTED'::"UploadSessionStatus", 'EXPIRED'::"UploadSessionStatus")
      AND "chunksCleanedAt" IS NULL AND ("updatedAt" <= $2 OR "cleanupAttempts" > 0))`;
  const result = await client.$queryRawUnsafe(`
    WITH candidates AS (
      SELECT "id" FROM "UploadSession"
      WHERE ("cleanupLeaseUntil" IS NULL OR "cleanupLeaseUntil" <= $1)
        AND ${where}
      ORDER BY ${kind === "expired" ? '"expiresAt"' : '"updatedAt"'}, "id"
      LIMIT $3 FOR UPDATE SKIP LOCKED
    )
    UPDATE "UploadSession" s
    SET "cleanupToken" = $4, "cleanupLeaseUntil" = $5
    FROM candidates c WHERE s."id" = c."id"
    RETURNING s.*
  `, now, kind === "expired" ? staleCutoff : terminalCutoff,
    settings.batchSize, token, leaseUntil);
  return { candidates: result, token };
}

async function finishCleanupClaim(client, sessionId, token, { completed = false, failure = null } = {}) {
  if (completed) {
    return client.uploadSession.updateMany({
      where: { id: sessionId, cleanupToken: token },
      data: {
        cleanupToken: null, cleanupLeaseUntil: null, cleanupAttempts: 0,
        cleanupLastError: null, chunksCleanedAt: new Date()
      }
    });
  }
  if (!failure) {
    return client.uploadSession.updateMany({
      where: { id: sessionId, cleanupToken: token },
      data: { cleanupToken: null, cleanupLeaseUntil: null }
    });
  }
  const observed = await client.uploadSession.findFirst({
    where: { id: sessionId, cleanupToken: token },
    select: { cleanupAttempts: true }
  });
  if (!observed) return { count: 0 };
  const attempts = Math.min(observed.cleanupAttempts + 1, 16);
  const delay = Math.min(3600, 10 * Math.pow(2, Math.min(8, attempts - 1)));
  return client.uploadSession.updateMany({
    where: { id: sessionId, cleanupToken: token },
    data: {
      cleanupToken: null, cleanupAttempts: attempts,
      cleanupLeaseUntil: new Date(Date.now() + delay * 1000),
      cleanupLastError: failure
    }
  });
}

async function deleteChunksWithTimeout(storage, sessionId, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      storage.deleteUploadSessionChunks(sessionId),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("STORAGE_CLEANUP_TIMEOUT")), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runBounded(items, concurrency, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  }));
}

async function cleanupUploadSessions(storage, client = prisma, overrides = {}) {
  const settings = { ...cleanupSettings(), ...overrides };
  const started = Date.now();
  const stats = {
    claimed: 0, expired: 0, recovered: 0, terminal: 0,
    failures: 0, retried: 0, pendingBacklog: 0, terminalBacklog: 0,
    retryBacklog: 0, oldestPendingAt: null, oldestTerminalAt: null, durationMs: 0
  };

  const expired = await claimCleanupCandidates(client, "expired", settings);
  stats.claimed = expired.candidates.length;
  await runBounded(expired.candidates, settings.concurrency, async (session) => {
    try {
      let transitioned;
      if (session.status === "COMPLETING") {
        const status = await recoverStaleCompletion(session, client);
        transitioned = status === "EXPIRED";
        if (status === "UPLOADING") stats.recovered++;
      } else {
        transitioned = await releaseSession(session, "EXPIRED", client);
      }
      if (!transitioned) {
        await finishCleanupClaim(client, session.id, expired.token);
        return;
      }
      stats.expired++;
      await deleteChunksWithTimeout(storage, session.id, settings.deleteTimeoutMs);
      await finishCleanupClaim(client, session.id, expired.token, { completed: true });
      await releaseTemporary("session:" + session.id, null, client);
    } catch {
      stats.failures++;
      stats.retried++;
      await finishCleanupClaim(client, session.id, expired.token, {
        failure: "SESSION_TRANSITION_OR_STORAGE_FAILED"
      });
    }
  });

  const terminal = await claimCleanupCandidates(client, "terminal", settings);
  await runBounded(terminal.candidates, settings.concurrency, async (session) => {
    try {
      await deleteChunksWithTimeout(storage, session.id, settings.deleteTimeoutMs);
      await finishCleanupClaim(client, session.id, terminal.token, { completed: true });
      await releaseTemporary("session:" + session.id, null, client);
      stats.terminal++;
    } catch {
      stats.failures++;
      stats.retried++;
      await finishCleanupClaim(client, session.id, terminal.token, {
        failure: "STORAGE_CHUNKS_DELETE_FAILED"
      });
    }
  });

  // Keep prior bounded reservation and idempotency cleanup behavior. Failures
  // here do not unwind successfully transitioned upload sessions.
  await require("./upload-reservation").reconcileExpiredReservations(client).catch(() => 0);
  await require("./idempotency").pruneExpiredIdempotencyKeys(client).catch(() => 0);

  const now = new Date();
  const expiredWhere = { status: "UPLOADING", expiresAt: { lte: now } };
  const terminalWhere = {
    status: { in: ["COMPLETED", "ABORTED", "EXPIRED"] },
    chunksCleanedAt: null, updatedAt: { lte: new Date(now.getTime() - 60000) }
  };
  const [pendingBacklog, terminalBacklog, retries, pendingAge, terminalAge] = await Promise.all([
    client.uploadSession.count({ where: expiredWhere }),
    client.uploadSession.count({ where: terminalWhere }),
    client.uploadSession.count({
      where: { cleanupAttempts: { gt: 0 }, chunksCleanedAt: null }
    }),
    client.uploadSession.aggregate({ where: expiredWhere, _min: { expiresAt: true } }),
    client.uploadSession.aggregate({ where: terminalWhere, _min: { updatedAt: true } })
  ]);
  stats.pendingBacklog = pendingBacklog;
  stats.terminalBacklog = terminalBacklog;
  stats.retryBacklog = retries;
  stats.oldestPendingAt = pendingAge._min.expiresAt?.toISOString() ?? null;
  stats.oldestTerminalAt = terminalAge._min.updatedAt?.toISOString() ?? null;
  stats.durationMs = Date.now() - started;
  lastCleanupStats = stats;
  return stats.claimed;
}

module.exports = {
  CHECKSUM_RE,
  partGeometry,
  parseContentRange,
  validatePartRange,
  validateChecksum,
  missingPartNumbers,
  assertCompleteParts,
  lockUserForUpdate,
  lockActiveUserForUpdate,
  lockActiveUserShared,
  releaseSession,
  insertPartIfOpen,
  claimCompletion,
  renewCompletionLease,
  relinquishCompletion,
  startLeaseHeartbeat,
  recoverStaleCompletion,
  isStaleCompletion,
  expireIfNeeded,
  cleanupUploadSessions,
  cleanupSettings,
  claimCleanupCandidates,
  getUploadCleanupStats
};
