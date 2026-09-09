const prisma = require("./prisma");
const { releaseUploadReservation } = require("./quota");

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
  return client.$transaction(async (tx) => {
    const transitioned = await tx.uploadSession.updateMany({
      where: {
        id: session.id,
        userId: session.userId,
        status: session.status
      },
      data: { status: targetStatus }
    });
    if (transitioned.count !== 1) return false;
    await releaseUploadReservation(session.userId, session.expectedSize, tx);
    return true;
  });
}

async function expireIfNeeded(session, storage, client = prisma) {
  if (session.status !== "UPLOADING" || session.expiresAt > new Date()) return false;
  const expired = await releaseSession(session, "EXPIRED", client);
  if (expired) await storage.deleteUploadSessionChunks(session.id).catch(() => {});
  return expired;
}

async function cleanupUploadSessions(storage, client = prisma) {
  const now = new Date();
  const staleCompleting = new Date(Date.now() - 30 * 60 * 1000);
  const candidates = await client.uploadSession.findMany({
    where: {
      OR: [
        { status: "UPLOADING", expiresAt: { lte: now } },
        { status: "COMPLETING", updatedAt: { lte: staleCompleting } }
      ]
    },
    take: 100
  });

  for (const session of candidates) {
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
  releaseSession,
  expireIfNeeded,
  cleanupUploadSessions
};
