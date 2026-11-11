"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const prisma = require("./prisma");
const { LocalStorageAdapter } = require("./storage");
const { tempStats } = require("./temporary-storage");

function reconciliationSettings(env = process.env) {
  const graceMs = Number(env.VAULTBOX_ORPHAN_GRACE_MS ?? 3600000);
  const batchSize = Number(env.VAULTBOX_RECONCILE_BATCH_SIZE ?? 100);
  if (!Number.isSafeInteger(graceMs) || graceMs < 60000 || graceMs > 7 * 86400000) {
    throw new Error("VAULTBOX_ORPHAN_GRACE_MS must be 60000..604800000");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("VAULTBOX_RECONCILE_BATCH_SIZE must be 1..500");
  }
  return { graceMs, batchSize };
}

let recentReport = null;
function getReconciliationReport() { return recentReport && { ...recentReport }; }

async function objectAgeIsSafe(storage, claim, cutoff) {
  if (claim.kind === "SESSION") {
    try {
      const stat = await fs.stat(storage.resolveUploadSession(claim.objectKey.slice(8)));
      return stat.mtime <= cutoff;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  }
  const prefix = claim.kind === "ASSEMBLY" ? "assembly:" : "file:";
  try {
    const stat = await fs.lstat(storage.resolve(claim.objectKey.slice(prefix.length)));
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return stat.mtime <= cutoff;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function hasDurableReference(claim, client) {
  if (claim.kind === "SESSION") {
    const sessionId = claim.objectKey.slice(8);
    const session = await client.uploadSession.findUnique({
      where: { id: sessionId },
      select: { status: true, chunksCleanedAt: true }
    });
    return !!session && (
      session.status === "UPLOADING" || session.status === "COMPLETING" ||
      session.chunksCleanedAt === null
    );
  }
  const prefix = claim.kind === "ASSEMBLY" ? "assembly:" : "file:";
  const storedName = claim.objectKey.slice(prefix.length);
  const file = await client.file.findFirst({
    where: { storedName }, select: { id: true }
  });
  return !!file;
}

async function recheckAndSweepClaim(storage, claim, cutoff, client, stats) {
  if (await hasDurableReference(claim, client)) {
    if (claim.kind !== "SESSION") {
      // Published object is no longer temporary; preserve bytes, drop stale claim.
      await client.temporaryObject.deleteMany({
        where: { id: claim.id, token: claim.token, state: { in: ["ACTIVE", "REAPING"] } }
      });
    }
    stats.protected++;
    return;
  }
  if (!(await objectAgeIsSafe(storage, claim, cutoff))) {
    stats.protected++;
    return;
  }
  // An active writer heartbeat races this state transition. The CAS prevents
  // deleting its object while it owns an unexpired claim; commit checks ACTIVE.
  const reapToken = crypto.randomUUID();
  const marked = await client.temporaryObject.updateMany({
    where: {
      id: claim.id, token: claim.token, state: claim.state,
      leaseUntil: { lte: cutoff }
    },
    data: {
      state: "REAPING", token: reapToken,
      // A crashed cleaner's claim can be reclaimed after this lease AND the
      // configured grace. Token fencing prevents late cleaners from deleting
      // another cleaner's newly claimed object.
      leaseUntil: new Date(Date.now() + 60000)
    }
  });
  if (marked.count !== 1) return;
  try {
    // A file may have been committed between our first look and the CAS.
    // Never delete it, even if the old claim was stale.
    if (await hasDurableReference(claim, client)) {
      await client.temporaryObject.deleteMany({ where: { id: claim.id, state: "REAPING", token: reapToken } });
      stats.protected++;
      return;
    }
    if (!(await objectAgeIsSafe(storage, claim, cutoff))) {
      await client.temporaryObject.updateMany({
        where: { id: claim.id, state: "REAPING", token: reapToken },
        data: { state: "ACTIVE", leaseUntil: new Date(Date.now() + 60000) }
      });
      stats.protected++;
      return;
    }
    if (claim.kind === "SESSION") {
      await storage.deleteUploadSessionChunks(claim.objectKey.slice(8));
    } else {
      const prefix = claim.kind === "ASSEMBLY" ? "assembly:" : "file:";
      await storage.delete(claim.objectKey.slice(prefix.length));
    }
    await client.temporaryObject.deleteMany({
      where: { id: claim.id, state: "REAPING", token: reapToken }
    });
    stats.reaped++;
  } catch {
    stats.errors++;
    // Do not drop the ledger record when physical deletion failed.
    await client.temporaryObject.updateMany({
      where: { id: claim.id, state: "REAPING", token: reapToken },
      data: { state: "ACTIVE", leaseUntil: new Date(Date.now() + 300000) }
    }).catch(() => null);
  }
}

// Bounded, conservative scanner: legacy unclaimed objects are reported but
// NEVER deleted because a process from before the ledger might still write.
// Retain one directory cursor per adapter between sweeps; opening the directory
// from the beginning every five minutes would starve names after batchSize.
const localScanCursors = new WeakMap();
async function scanUnclaimedLocal(storage, client, stats, cutoff, limit) {
  let cursorPromise = localScanCursors.get(storage);
  if (!cursorPromise) {
    cursorPromise = fs.opendir(storage.root).then((dir) => ({ dir, busy: false }));
    localScanCursors.set(storage, cursorPromise);
  }
  let state;
  try {
    state = await cursorPromise;
  } catch (error) {
    localScanCursors.delete(storage);
    throw error;
  }
  if (state.busy) return; // a slow concurrent sweep must not consume the cursor twice
  state.busy = true;
  let exhausted = false;
  try {
    for (let seen = 0; seen < limit; seen++) {
      const entry = await state.dir.read();
      if (!entry) {
        exhausted = true;
        break;
      }
      if (!entry.isFile() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
      let stat;
      try {
        stat = await fs.lstat(storage.resolve(entry.name));
      } catch (error) {
        if (error.code === "ENOENT") continue; // another cleanup already removed it
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtime > cutoff) continue;
      const [file, claimed] = await Promise.all([
        client.file.findFirst({ where: { storedName: entry.name }, select: { id: true } }),
        client.temporaryObject.findFirst({
          where: { objectKey: { in: ["file:" + entry.name, "assembly:" + entry.name] } },
          select: { id: true }
        })
      ]);
      if (!file && !claimed) stats.unclaimedLegacyObjects++;
    }
  } catch (error) {
    exhausted = true; // restart safely from beginning if the handle is invalid
    throw error;
  } finally {
    state.busy = false;
    if (exhausted) {
      localScanCursors.delete(storage);
      await state.dir.close().catch(() => null);
    }
  }
}

// Non-destructive missing-object probe, reporting discrepancies without
// dropping File rows or refunding quota based on a transient storage outage.
let lastProbedFileId = null;
async function probeCommittedFiles(storage, client, stats, limit) {
  let files = await client.file.findMany({
    where: {
      status: "ACTIVE",
      ...(lastProbedFileId ? { id: { gt: lastProbedFileId } } : {})
    },
    select: { id: true, storedName: true },
    orderBy: { id: "asc" }, take: limit
  });
  if (!files.length && lastProbedFileId) {
    lastProbedFileId = null;
    files = await client.file.findMany({
      where: { status: "ACTIVE" }, select: { id: true, storedName: true },
      orderBy: { id: "asc" }, take: limit
    });
  }
  if (files.length) lastProbedFileId = files[files.length - 1].id;
  for (const file of files) {
    try {
      if (!(await storage.existsFile(file))) stats.missingCommittedObjects++;
    } catch {
      stats.errors++;
    }
  }
}

async function reconcileStorage(storage, client = prisma, settings = {}) {
  const config = { ...reconciliationSettings(), ...settings };
  const started = Date.now();
  const stats = {
    supported: storage instanceof LocalStorageAdapter,
    claimsExamined: 0, reaped: 0, protected: 0, errors: 0,
    unclaimedLegacyObjects: 0, missingCommittedObjects: 0,
    durationMs: 0, temporary: null
  };
  if (!stats.supported) {
    stats.reason = "External object inventory needs provider-specific integration; no provider configured";
    recentReport = stats;
    return stats;
  }
  const cutoff = new Date(Date.now() - config.graceMs);
  const claims = await client.temporaryObject.findMany({
    where: { state: { in: ["ACTIVE", "REAPING"] }, leaseUntil: { lte: cutoff } },
    orderBy: [{ leaseUntil: "asc" }, { id: "asc" }],
    take: config.batchSize
  });
  stats.claimsExamined = claims.length;
  for (const claim of claims) {
    await recheckAndSweepClaim(storage, claim, cutoff, client, stats);
  }
  await scanUnclaimedLocal(storage, client, stats, cutoff, config.batchSize);
  await probeCommittedFiles(storage, client, stats, Math.min(config.batchSize, 100));
  stats.temporary = await tempStats(client);
  stats.durationMs = Date.now() - started;
  recentReport = stats;
  return stats;
}

module.exports = { reconciliationSettings, reconcileStorage, getReconciliationReport };
