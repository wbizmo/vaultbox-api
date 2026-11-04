const crypto = require("node:crypto");
const prisma = require("./prisma");
const { releaseUploadReservation } = require("./quota");
const { retryOnConflict } = require("./db-retry");

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

async function releaseSession(session, targetStatus, client = prisma) {
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
  if (expired) await storage.deleteUploadSessionChunks(session.id).catch(() => {});
  return expired;
}

async function cleanupUploadSessions(storage, client = prisma) {
  const now = new Date();
  const candidates = await client.uploadSession.findMany({
    where: {
      OR: [
        { status: "UPLOADING", expiresAt: { lte: now } },
        // Only completers that stopped heartbeating are recovered; a long but
        // healthy assembly keeps renewing its lease and is never reclaimed.
        staleCompletionWhere(now)
      ]
    },
    take: 100
  });

  for (const session of candidates) {
    if (session.status === "COMPLETING") {
      const outcome = await recoverStaleCompletion(session, client).catch(() => null);
      if (outcome === "EXPIRED") await storage.deleteUploadSessionChunks(session.id).catch(() => {});
      continue;
    }
    const released = await releaseSession(session, "EXPIRED", client).catch(() => false);
    if (released) await storage.deleteUploadSessionChunks(session.id).catch(() => {});
  }

  const terminal = await client.uploadSession.findMany({
    where: {
      status: { in: ["COMPLETED", "ABORTED", "EXPIRED"] },
      updatedAt: { lte: new Date(Date.now() - 60 * 1000) }
    },
    select: { id: true },
    take: 100
  });
  await Promise.all(terminal.map((session) => storage.deleteUploadSessionChunks(session.id).catch(() => {})));

  return candidates.length;
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
  releaseSession,
  insertPartIfOpen,
  claimCompletion,
  renewCompletionLease,
  relinquishCompletion,
  startLeaseHeartbeat,
  recoverStaleCompletion,
  isStaleCompletion,
  expireIfNeeded,
  cleanupUploadSessions
};
