"use strict";

const crypto = require("node:crypto");
const prisma = require("./prisma");

const DEFAULTS = Object.freeze({
  globalBytes: "8796093022208", // 8 TiB, configurable per deployment
  userBytes: "1099511627776", // 1 TiB
  globalClaims: 1024, userClaims: 64
});

function positiveInt(value, name, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new Error(name + " must be a positive integer <= " + max);
  }
  return n;
}
function positiveBytes(value, name) {
  const raw = String(value);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(name + " must be a positive number of bytes");
  const n = BigInt(raw);
  if (n > 9223372036854775807n) throw new Error(name + " exceeds PostgreSQL bigint");
  return n;
}
function tempLimits(env = process.env) {
  const globalBytes = positiveBytes(env.VAULTBOX_TEMP_GLOBAL_BYTES ?? DEFAULTS.globalBytes, "VAULTBOX_TEMP_GLOBAL_BYTES");
  const userBytes = positiveBytes(env.VAULTBOX_TEMP_USER_BYTES ?? DEFAULTS.userBytes, "VAULTBOX_TEMP_USER_BYTES");
  if (userBytes > globalBytes) throw new Error("Temporary per-user budget cannot exceed global budget");
  return {
    globalBytes, userBytes,
    globalClaims: positiveInt(env.VAULTBOX_TEMP_GLOBAL_CLAIMS ?? DEFAULTS.globalClaims,
      "VAULTBOX_TEMP_GLOBAL_CLAIMS", 100000),
    userClaims: positiveInt(env.VAULTBOX_TEMP_USER_CLAIMS ?? DEFAULTS.userClaims,
      "VAULTBOX_TEMP_USER_CLAIMS", 10000)
  };
}
function tempBudgetError() {
  const error = new Error("Temporary storage capacity or concurrency budget exceeded");
  error.code = "TEMP_STORAGE_BUDGET_EXCEEDED";
  return error;
}

// Must be called INSIDE an existing transaction. A single global advisory
// transaction lock makes cross-user and cross-process sum/count admission serial.
async function claimTemporary({ userId, objectKey, kind, bytes, leaseMs = 120000, limits = tempLimits() }, tx) {
  if (!tx) throw new Error("Temporary claim requires a database transaction");
  if (!/^(file|session|assembly):[A-Za-z0-9._-]+$/.test(objectKey)) throw new Error("Invalid temporary object key");
  if (!["FILE", "SESSION", "ASSEMBLY"].includes(kind)) throw new Error("Invalid temporary object kind");
  if (typeof bytes !== "bigint" || bytes < 0n || bytes > 9223372036854775807n) throw new Error("Invalid temporary bytes");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error("Invalid temporary lease");
  await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(826514203)::text");
  const [totals] = await tx.$queryRawUnsafe(
    'SELECT COALESCE(SUM("bytes"), 0)::bigint AS "bytes", ' +
    'COUNT(*) FILTER (WHERE NOT ("kind" = \'ASSEMBLY\' AND "bytes" = 0))::integer AS "claims", ' +
    'COALESCE(SUM("bytes") FILTER (WHERE "userId" = $1), 0)::bigint AS "userBytes", ' +
    'COUNT(*) FILTER (WHERE "userId" = $1 AND NOT ("kind" = \'ASSEMBLY\' AND "bytes" = 0))::integer ' +
    'AS "userClaims" FROM "TemporaryObject"',
    userId
  );
  // The parent SESSION claim already accounts for its bytes and admission.
  // A zero-byte ASSEMBLY marker only fences its output during completion.
  const admissionSlots = kind === "ASSEMBLY" && bytes === 0n ? 0 : 1;
  if (totals.bytes + bytes > limits.globalBytes ||
    totals.userBytes + bytes > limits.userBytes ||
    totals.claims + admissionSlots > limits.globalClaims ||
    totals.userClaims + admissionSlots > limits.userClaims) throw tempBudgetError();
  const token = crypto.randomUUID();
  return tx.temporaryObject.create({
    data: {
      userId, objectKey, kind, bytes, state: "ACTIVE", token,
      leaseUntil: new Date(Date.now() + leaseMs)
    },
    select: { id: true, token: true, objectKey: true }
  });
}

async function ensurePhysicalHeadroom(storage, bytes, env = process.env) {
  if (!storage || typeof storage.root !== "string") return;
  if (!Number.isSafeInteger(Number(bytes)) || bytes < 0n) throw new Error("Invalid physical reservation");
  const reserve = positiveBytes(env.VAULTBOX_TEMP_MIN_FREE_BYTES ?? "67108864", "VAULTBOX_TEMP_MIN_FREE_BYTES");
  const fs = require("node:fs/promises");
  const info = await fs.statfs(storage.root);
  const available = BigInt(info.bavail) * BigInt(info.bsize);
  if (available < bytes + reserve) throw tempBudgetError();
}

async function reserveTemporary(args, client = prisma) {
  return client.$transaction((tx) => claimTemporary(args, tx));
}

async function renewTemporary(objectKey, token, leaseMs = 120000, client = prisma) {
  const changed = await client.temporaryObject.updateMany({
    where: { objectKey, token, state: "ACTIVE" },
    data: { leaseUntil: new Date(Date.now() + leaseMs) }
  });
  return changed.count === 1;
}

function startTempHeartbeat(objectKey, token, leaseMs = 120000, client = prisma) {
  const state = { lost: false };
  const timer = setInterval(async () => {
    try {
      if (!await renewTemporary(objectKey, token, leaseMs, client)) state.lost = true;
    } catch {
      state.lost = true;
    }
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  timer.unref();
  return { state, stop: () => clearInterval(timer) };
}

async function assertTemporaryOwned(tx, objectKey, token) {
  // Lock the claim THROUGH the File + quota commit, not just read it. Without
  // this row fence, a stale reaper can CAS ACTIVE→REAPING after our ownership
  // lookup but before the File reference commits, then delete the just-published
  // bytes. The reaper's UPDATE now waits for our transaction and rechecks.
  const rows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "TemporaryObject" ' +
    'WHERE "objectKey"=$1 AND "token"=$2 AND "state"=\'ACTIVE\' ' +
    'AND "leaseUntil" > NOW() FOR UPDATE',
    objectKey, token
  );
  if (rows.length !== 1) {
    const error = new Error("Temporary object claim expired or was revoked");
    error.code = "TEMP_CLAIM_LOST";
    throw error;
  }
}
async function releaseTemporary(objectKey, token = null, client = prisma) {
  return client.temporaryObject.deleteMany({
    where: { objectKey, ...(token ? { token } : {}) }
  });
}
async function tempStats(client = prisma) {
  const [row] = await client.$queryRawUnsafe(
    'SELECT COALESCE(SUM("bytes"), 0)::bigint AS "reservedBytes", ' +
    'COUNT(*)::integer AS "objects", ' +
    'COUNT(*) FILTER (WHERE "leaseUntil" <= CURRENT_TIMESTAMP)::integer AS "staleClaims" ' +
    'FROM "TemporaryObject"'
  );
  return { reservedBytes: row.reservedBytes.toString(), objects: row.objects, staleClaims: row.staleClaims };
}

module.exports = {
  tempLimits, ensurePhysicalHeadroom, reserveTemporary, claimTemporary, renewTemporary,
  startTempHeartbeat, assertTemporaryOwned, releaseTemporary, tempStats
};
