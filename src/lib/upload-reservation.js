const prisma = require("./prisma");
const {
  reservePendingUploadQuota,
  releaseUploadReservation,
  commitUploadReservation
} = require("./quota");
const { lockUserForUpdate } = require("./upload-session");
const { retryOnConflict } = require("./db-retry");

/*
 * Durable one-shot upload reservations.
 *
 * Invariant: every byte in "User"."reservedUploadBytes" that came from a one-shot upload has an
 * UploadReservation row that owns it, and that row leaves PENDING exactly once -- to COMMITTED
 * (bytes converted into storageUsed with the File) or RELEASED (bytes returned) -- by a
 * compare-and-set. Quota is only adjusted by the actor whose compare-and-set succeeded, so
 * duplicate, concurrent or late commit/release attempts cannot double-adjust counters.
 *
 * Lock order matches upload sessions: "User" row first, then the reservation row.
 */

/** Create the reservation and reserve quota in ONE transaction. Returns { id } or null if it does not fit. */
async function createReservation(userId, bytes, leaseMs, client = prisma) {
  return retryOnConflict(() => client.$transaction(async (tx) => {
    if (!(await lockUserForUpdate(tx, userId))) return null;
    const quota = await reservePendingUploadQuota(userId, bytes, tx);
    if (!quota) return null;
    const row = await tx.uploadReservation.create({
      data: { userId, bytes, leaseUntil: new Date(Date.now() + leaseMs) },
      select: { id: true }
    });
    return { id: row.id, quota };
  }));
}

/** Extend the lease while the upload is alive; false means it is no longer PENDING. */
async function renewReservation(id, leaseMs, client = prisma) {
  const renewed = await client.uploadReservation.updateMany({
    where: { id, state: "PENDING" },
    data: { leaseUntil: new Date(Date.now() + leaseMs) }
  });
  return renewed.count === 1;
}

function startReservationHeartbeat(id, leaseMs, client = prisma) {
  const state = { lost: false };
  const timer = setInterval(async () => {
    try {
      if (!(await renewReservation(id, leaseMs, client))) state.lost = true;
    } catch {
      // Transient errors must not fail a healthy upload; the fenced commit is the arbiter.
    }
  }, Math.max(250, Math.floor(leaseMs / 3)));
  timer.unref();
  return { state, stop: () => clearInterval(timer) };
}

/**
 * Inside the caller's transaction: convert the reservation into committed storage. Returns the
 * quota row, or null when the reservation is no longer PENDING (already released/committed).
 * The caller must have locked the user row already.
 */
async function commitReservation(tx, id, userId, bytes) {
  const claimed = await tx.uploadReservation.updateMany({
    where: { id, userId, state: "PENDING" },
    data: { state: "COMMITTED" }
  });
  if (claimed.count !== 1) return null;
  const quota = await commitUploadReservation(userId, bytes, tx);
  if (!quota) {
    const error = new Error("Reserved upload quota is no longer valid");
    error.code = "UPLOAD_RESERVATION_INVALID";
    throw error;
  }
  return quota;
}

async function linkReservationFile(tx, id, fileId) {
  await tx.uploadReservation.update({ where: { id }, data: { fileId } });
}

/**
 * Release exactly once; returns true only for the caller whose transition applied.
 * Route cleanup releases unconditionally. The sweeper passes `lapsedBefore` so the
 * compare-and-set also requires the lease to still be lapsed: a heartbeat that renews
 * between the sweeper's read and this write wins and the live upload is left alone.
 */
async function releaseReservation(id, client = prisma, { lapsedBefore = null } = {}) {
  return retryOnConflict(() => client.$transaction(async (tx) => {
    const row = await tx.uploadReservation.findUnique({ where: { id } });
    if (!row || row.state !== "PENDING") return false;
    await lockUserForUpdate(tx, row.userId);
    const released = await tx.uploadReservation.updateMany({
      where: {
        id,
        state: "PENDING",
        ...(lapsedBefore ? { leaseUntil: { lt: lapsedBefore } } : {})
      },
      data: { state: "RELEASED" }
    });
    if (released.count !== 1) return false;
    await releaseUploadReservation(row.userId, row.bytes, tx);
    return true;
  }));
}

/**
 * Release PENDING reservations whose lease lapsed (crashed or stalled worker). Safe to run on
 * every instance concurrently: each release is a compare-and-set.
 */
async function reconcileExpiredReservations(client = prisma, { limit = 100 } = {}) {
  const cutoff = new Date();
  const lapsed = await client.uploadReservation.findMany({
    where: { state: "PENDING", leaseUntil: { lt: cutoff } },
    orderBy: { leaseUntil: "asc" },
    take: limit,
    select: { id: true }
  });
  let released = 0;
  for (const { id } of lapsed) {
    if (await releaseReservation(id, client, { lapsedBefore: cutoff }).catch(() => false)) released += 1;
  }
  return released;
}

module.exports = {
  createReservation,
  renewReservation,
  startReservationHeartbeat,
  commitReservation,
  linkReservationFile,
  releaseReservation,
  reconcileExpiredReservations
};
