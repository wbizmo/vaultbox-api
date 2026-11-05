const crypto = require("crypto");
const { clientIp } = require("../lib/client-ip");
const { recordAudit } = require("../lib/audit");
const { pipeline } = require("stream/promises");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { HashingTransform } = require("../lib/hash-stream");
const {
  reservePendingUploadQuota,
  commitUploadReservation
} = require("../lib/quota");
const {
  validatePartRange,
  validateChecksum,
  missingPartNumbers,
  assertCompleteParts,
  lockActiveUserForUpdate,
  insertPartIfOpen,
  releaseSession,
  claimCompletion,
  relinquishCompletion,
  startLeaseHeartbeat,
  recoverStaleCompletion,
  isStaleCompletion,
  expireIfNeeded,
  cleanupUploadSessions
} = require("../lib/upload-session");
const { retryOnConflict } = require("../lib/db-retry");
const { throttlePreHandler } = require("../lib/throttle");

const createThrottle = throttlePreHandler(
  "upload-session-create",
  { limit: 30, windowSeconds: 60 },
  (request) => request.user?.id || clientIp(request)
);
const partThrottle = throttlePreHandler(
  "upload-session-part",
  { limit: 240, windowSeconds: 60 },
  (request) => request.user?.id || clientIp(request)
);

function closedSessionReply(reply, status) {
  if (status === "EXPIRED") return reply.code(410).send({ message: "Upload session has expired" });
  return reply.code(409).send({
    message: `Upload session is ${String(status || "closed").toLowerCase()} and no longer accepts parts`
  });
}

function leaseLostError() {
  const error = new Error("Upload completion lease was lost");
  error.code = "UPLOAD_COMPLETION_LEASE_LOST";
  return error;
}

function serializePart(part) {
  return {
    partNumber: part.partNumber,
    offset: part.offset.toString(),
    size: part.size.toString(),
    checksum: part.checksum,
    createdAt: part.createdAt
  };
}

function serializeSession(session, parts = session.parts || []) {
  return {
    id: session.id,
    status: session.status,
    originalName: session.originalName,
    mimeType: session.mimeType,
    expectedSize: session.expectedSize.toString(),
    expectedChecksum: session.expectedChecksum,
    chunkSize: session.chunkSize,
    partCount: session.partCount,
    uploadedParts: parts.map(serializePart),
    missingParts: missingPartNumbers(session.partCount, parts),
    expiresAt: session.expiresAt,
    fileId: session.fileId,
    completedAt: session.completedAt
  };
}

async function loadOwnedSession(userId, sessionId, includeParts = false) {
  return prisma.uploadSession.findFirst({
    where: { id: sessionId, userId },
    ...(includeParts ? { include: { parts: { orderBy: { partNumber: "asc" } } } } : {})
  });
}

async function completedResponse(userId, session) {
  if (!session.fileId) return null;
  const file = await prisma.file.findFirst({
    where: { id: session.fileId, userId, status: "ACTIVE" }
  });
  if (!file) return null;
  return {
    message: "Upload already completed",
    sessionId: session.id,
    file: {
      id: file.id,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size.toString(),
      checksum: file.checksum,
      createdAt: file.createdAt
    }
  };
}

async function uploadRoutes(app) {
  const storage = app.vaultboxStorage;
  const config = app.vaultboxConfig;

  app.addHook("onReady", async () => {
    await cleanupUploadSessions(storage).catch((error) => {
      app.log.warn({ err: error }, "Initial resumable-upload cleanup failed");
    });
  });

  const cleanupTimer = setInterval(() => {
    cleanupUploadSessions(storage).catch((error) => {
      app.log.warn({ err: error }, "Resumable-upload cleanup failed");
    });
  }, 5 * 60 * 1000);
  cleanupTimer.unref();
  app.addHook("onClose", async () => clearInterval(cleanupTimer));

  app.post("/upload-sessions", {
    preHandler: [requireAuth, createThrottle],
    schema: {
      tags: ["Files"],
      summary: "Create a resumable upload session and reserve quota",
      security: [{ bearerAuth: [] }],
      body: {
        type: "object",
        additionalProperties: false,
        required: ["originalName", "mimeType", "expectedSize"],
        properties: {
          originalName: { type: "string", minLength: 1, maxLength: 255 },
          mimeType: { type: "string", minLength: 1, maxLength: 255 },
          expectedSize: { type: "integer", minimum: 1, maximum: config.maxUploadBytes },
          checksum: { type: "string", minLength: 64, maxLength: 64 }
        }
      }
    }
  }, async (request, reply) => {
    const expectedSize = BigInt(request.body.expectedSize);
    let expectedChecksum;
    try {
      expectedChecksum = validateChecksum(request.body.checksum);
    } catch (error) {
      return reply.code(400).send({ message: error.message });
    }

    const chunkSize = Math.min(config.uploadChunkBytes, request.body.expectedSize);
    const partCount = Math.ceil(request.body.expectedSize / chunkSize);
    if (partCount > config.uploadMaxParts) {
      return reply.code(413).send({ message: "Upload requires too many parts" });
    }

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { planId: true }
    });
    if (!user?.planId) return reply.code(403).send({ message: "No active storage plan found" });

    const sessionId = crypto.randomUUID();
    await storage.prepareUploadSession(sessionId);

    let session;
    try {
      session = await prisma.$transaction(async (tx) => {
        await lockActiveUserForUpdate(tx, request.user.id);
        const reservation = await reservePendingUploadQuota(request.user.id, expectedSize, tx);
        if (!reservation) {
          const error = new Error("Storage quota exceeded");
          error.code = "STORAGE_QUOTA_EXCEEDED";
          throw error;
        }

        const created = await tx.uploadSession.create({
          data: {
            id: sessionId,
            userId: request.user.id,
            originalName: request.body.originalName.trim().slice(0, 255),
            mimeType: request.body.mimeType.trim().slice(0, 255),
            expectedSize,
            expectedChecksum,
            chunkSize,
            partCount,
            expiresAt: new Date(Date.now() + config.uploadSessionExpiresMinutes * 60 * 1000)
          }
        });
        await recordAudit(tx, {
          action: "UPLOAD_SESSION_CREATED",
          details: `${created.id}:${created.expectedSize}`,
          userId: request.user.id,
          ip: clientIp(request)
        });
        return created;
      });
    } catch (error) {
      await storage.deleteUploadSessionChunks(sessionId).catch(() => {});
      if (error.code === "STORAGE_QUOTA_EXCEEDED") {
        return reply.code(413).send({ message: "Storage quota exceeded" });
      }
      throw error;
    }

    return reply.code(201).send({
      message: "Upload session created",
      session: serializeSession(session),
      upload: {
        partUrl: `/upload-sessions/${session.id}/parts/{partNumber}`,
        requiredRangeHeader: "Content-Range: bytes start-end/total",
        optionalChecksumHeader: "x-chunk-sha256",
        suggestedParallelParts: config.uploadSuggestedParallelParts
      }
    });
  });

  app.get("/upload-sessions/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Inspect resumable upload progress",
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    let session = await loadOwnedSession(request.user.id, request.params.id, true);
    if (!session) return reply.code(404).send({ message: "Upload session not found" });

    if (await expireIfNeeded(session, storage)) {
      session = await loadOwnedSession(request.user.id, request.params.id, true);
    }

    return { session: serializeSession(session, session.parts) };
  });

  app.put("/upload-sessions/:id/parts/:partNumber", {
    preHandler: [requireAuth, partThrottle],
    schema: {
      tags: ["Files"],
      summary: "Upload or retry one resumable upload part",
      security: [{ bearerAuth: [] }],
      consumes: ["multipart/form-data"],
      params: {
        type: "object",
        required: ["id", "partNumber"],
        properties: {
          id: { type: "string" },
          partNumber: { type: "integer", minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const session = await loadOwnedSession(request.user.id, request.params.id);
    if (!session) return reply.code(404).send({ message: "Upload session not found" });
    if (await expireIfNeeded(session, storage)) {
      return reply.code(410).send({ message: "Upload session has expired" });
    }
    if (session.status !== "UPLOADING") {
      return reply.code(409).send({ message: `Upload session is ${session.status.toLowerCase()}` });
    }

    const partNumber = Number(request.params.partNumber);
    let expected;
    let declaredChecksum;
    try {
      expected = validatePartRange(session, partNumber, request.headers["content-range"]);
      declaredChecksum = validateChecksum(request.headers["x-chunk-sha256"]);
    } catch (error) {
      return reply.code(400).send({ message: error.message });
    }

    let existing = await prisma.uploadPart.findFirst({
      where: {
        sessionId: session.id,
        partNumber,
        session: { userId: request.user.id }
      }
    });
    if (existing && !(await storage.existsUploadPart(session.id, existing.storedName))) {
      // Repair only while the session is open for writes and only this exact row/object pair;
      // a COMPLETING session's part set is frozen.
      const repaired = await prisma.uploadPart.deleteMany({
        where: {
          id: existing.id,
          storedName: existing.storedName,
          session: { userId: request.user.id, status: "UPLOADING" }
        }
      });
      if (repaired.count !== 1) {
        return reply.code(409).send({ message: "Upload session is no longer accepting parts" });
      }
      existing = null;
    }
    if (existing) {
      if (!declaredChecksum) {
        return reply.code(409).send({
          message: "Part already exists; supply its x-chunk-sha256 checksum to replay idempotently",
          part: serializePart(existing)
        });
      }
      if (
        existing.checksum !== declaredChecksum ||
        BigInt(existing.offset) !== expected.start ||
        BigInt(existing.size) !== expected.size
      ) {
        return reply.code(409).send({ message: "Part number already contains different bytes" });
      }
      reply.header("Idempotent-Replay", "true");
      return { message: "Upload part already stored", part: serializePart(existing) };
    }

    const data = await request.file({ limits: { fileSize: Number(expected.size), files: 1 } });
    if (!data) return reply.code(400).send({ message: "No upload part provided" });

    const storedName = crypto.randomUUID();
    const hasher = new HashingTransform("sha256");
    try {
      await pipeline(data.file, hasher, storage.createUploadPartWriteStream(session.id, storedName));
    } catch (error) {
      await storage.deleteUploadPart(session.id, storedName).catch(() => false);
      if (error.code === "ENOENT") {
        // The session's chunk directory vanished: it was aborted, expired or completed while
        // this body was streaming. That is a conflict, not a server error.
        const latest = await loadOwnedSession(request.user.id, session.id);
        if (!latest || latest.status !== "UPLOADING") return closedSessionReply(reply, latest?.status);
      }
      throw error;
    }

    const measuredSize = hasher.bytes;
    const checksum = hasher.digest();
    if (data.file.truncated || measuredSize !== expected.size) {
      await storage.deleteUploadPart(session.id, storedName).catch(() => false);
      return reply.code(data.file.truncated ? 413 : 400).send({
        message: "Upload part size does not match Content-Range"
      });
    }
    if (declaredChecksum && checksum !== declaredChecksum) {
      await storage.deleteUploadPart(session.id, storedName).catch(() => false);
      return reply.code(422).send({ message: "Upload part checksum mismatch" });
    }

    let part;
    try {
      const inserted = await insertPartIfOpen(session, {
        partNumber,
        offset: expected.start,
        size: measuredSize,
        checksum,
        storedName
      });
      if (inserted.closed) {
        // Admitted while UPLOADING but the session closed before the part could commit.
        await storage.deleteUploadPart(session.id, storedName).catch(() => false);
        return closedSessionReply(reply, inserted.closed);
      }
      part = inserted.part;
    } catch (error) {
      await storage.deleteUploadPart(session.id, storedName).catch(() => false);
      if (error.code !== "P2002") throw error;

      const winner = await prisma.uploadPart.findFirst({
        where: {
          sessionId: session.id,
          partNumber,
          session: { userId: request.user.id }
        }
      });
      if (
        winner &&
        winner.checksum === checksum &&
        BigInt(winner.offset) === expected.start &&
        BigInt(winner.size) === expected.size
      ) {
        reply.header("Idempotent-Replay", "true");
        return { message: "Upload part already stored", part: serializePart(winner) };
      }
      return reply.code(409).send({ message: "Part number was concurrently filled with different bytes" });
    }

    return reply.code(201).send({ message: "Upload part stored", part: serializePart(part) });
  });

  app.post("/upload-sessions/:id/complete", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Assemble and atomically commit a resumable upload",
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    let session = await loadOwnedSession(request.user.id, request.params.id, true);
    if (!session) return reply.code(404).send({ message: "Upload session not found" });
    if (session.status === "COMPLETED") {
      const response = await completedResponse(request.user.id, session);
      return response || reply.code(409).send({ message: "Completed upload file is unavailable" });
    }
    if (isStaleCompletion(session)) {
      // The previous completer stopped heartbeating: recover it now rather than
      // making the client wait for the periodic cleanup.
      const outcome = await recoverStaleCompletion(session);
      if (outcome === "EXPIRED") {
        await storage.deleteUploadSessionChunks(session.id).catch(() => {});
        return reply.code(410).send({ message: "Upload session has expired" });
      }
      session = await loadOwnedSession(request.user.id, session.id, true);
    }
    if (await expireIfNeeded(session, storage)) {
      return reply.code(410).send({ message: "Upload session has expired" });
    }
    if (session.status !== "UPLOADING") {
      return reply.code(409).send({ message: `Upload session is ${session.status.toLowerCase()}` });
    }

    try {
      assertCompleteParts(session, session.parts);
    } catch (error) {
      return reply.code(409).send({ message: error.message, missingParts: error.missing || [] });
    }

    const leaseMs = (config.uploadCompletionLeaseSeconds || 120) * 1000;
    const token = await claimCompletion(session, leaseMs);
    if (!token) {
      session = await loadOwnedSession(request.user.id, session.id);
      if (session?.status === "COMPLETED") {
        const response = await completedResponse(request.user.id, session);
        return response || reply.code(409).send({ message: "Completed upload file is unavailable" });
      }
      return reply.code(409).send({ message: "Upload completion is already in progress" });
    }

    // Claiming locked the session row exclusively, so no part can commit from here on: this
    // read is the frozen part set that gets assembled (the pre-claim read may be stale).
    const frozenParts = await prisma.uploadPart.findMany({
      where: { sessionId: session.id },
      orderBy: { partNumber: "asc" }
    });
    session = { ...session, parts: frozenParts };
    try {
      assertCompleteParts(session, frozenParts);
    } catch (error) {
      await relinquishCompletion(session.id, token).catch(() => false);
      return reply.code(409).send({ message: error.message, missingParts: error.missing || [] });
    }

    // From here this request owns `token`. Every state change below is fenced on it,
    // so a stalled or recovered ("zombie") completer can never publish a file.
    const heartbeat = startLeaseHeartbeat(session.id, token, leaseMs);
    const giveBack = () => relinquishCompletion(session.id, token).catch(() => false);
    const storedName = crypto.randomUUID();
    let assembled;
    try {
      assembled = await storage.assembleUploadParts(session.id, session.parts, storedName, { signal: app.vaultboxShutdownSignal });
    } catch (error) {
      heartbeat.stop();
      await giveBack();
      if (error.name === "AbortError") {
        // Shutdown began mid-assembly: the partial object is gone and the session is retryable.
        reply.header("Retry-After", "5");
        return reply.code(503).send({ message: "Server is shutting down; retry completing the upload" });
      }
      if (error.code === "ENOENT" && Number.isInteger(error.uploadPartNumber)) {
        // Delete only the exact row whose object is missing (a concurrent re-upload creates a
        // different storedName and must not be removed).
        await prisma.uploadPart.deleteMany({
          where: {
            sessionId: session.id,
            partNumber: error.uploadPartNumber,
            ...(error.uploadPartStoredName ? { storedName: error.uploadPartStoredName } : {}),
            session: { userId: request.user.id }
          }
        });
        return reply.code(409).send({
          message: `Stored bytes for upload part ${error.uploadPartNumber} are missing; re-upload that part`
        });
      }
      throw error;
    }

    if (assembled.size !== BigInt(session.expectedSize)) {
      heartbeat.stop();
      await storage.delete(storedName).catch(() => false);
      await giveBack();
      return reply.code(422).send({ message: "Assembled upload size mismatch" });
    }
    if (session.expectedChecksum && assembled.checksum !== session.expectedChecksum) {
      heartbeat.stop();
      await storage.delete(storedName).catch(() => false);
      await giveBack();
      return reply.code(422).send({ message: "Final upload checksum mismatch" });
    }

    let committed;
    try {
      committed = await retryOnConflict(() => prisma.$transaction(async (tx) => {
        // Lock order: User first, UploadSession second (see lib/upload-session.js).
        await lockActiveUserForUpdate(tx, request.user.id);
        const owned = await tx.uploadSession.findFirst({
          where: { id: session.id, userId: request.user.id, status: "COMPLETING", completionToken: token },
          select: { id: true }
        });
        if (!owned) throw leaseLostError();

        const quota = await commitUploadReservation(request.user.id, session.expectedSize, tx);
        if (!quota) {
          const error = new Error("Reserved upload quota is no longer valid");
          error.code = "UPLOAD_RESERVATION_INVALID";
          throw error;
        }

        const file = await tx.file.create({
          data: {
            originalName: session.originalName,
            storedName,
            mimeType: session.mimeType,
            size: assembled.size,
            path: storedName,
            checksum: assembled.checksum,
            userId: request.user.id
          }
        });
        const completed = await tx.uploadSession.updateMany({
          where: {
            id: session.id,
            userId: request.user.id,
            status: "COMPLETING",
            completionToken: token,
            fileId: null
          },
          data: {
            status: "COMPLETED",
            fileId: file.id,
            completedAt: new Date(),
            completionToken: null,
            completionLeaseUntil: null
          }
        });
        if (completed.count !== 1) throw leaseLostError();
        await recordAudit(tx, {
          action: "UPLOAD_SESSION_COMPLETED",
          details: `${session.id}:${file.id}:${assembled.size}`,
          userId: request.user.id,
          ip: clientIp(request)
        });
        return { file, quota };
      }));
    } catch (error) {
      heartbeat.stop();
      await storage.delete(storedName).catch(() => false);
      if (error.code === "UPLOAD_COMPLETION_LEASE_LOST") {
        // Someone else now owns (or has finished) this session; touch nothing of theirs.
        return reply.code(409).send({ message: "Upload completion lease was lost; retry completion" });
      }
      await giveBack();
      throw error;
    }
    heartbeat.stop();

    await storage.deleteUploadSessionChunks(session.id).catch((error) => {
      request.log.warn({ err: error, sessionId: session.id }, "Upload committed but chunk cleanup failed");
    });
    return {
      message: "Upload completed",
      sessionId: session.id,
      file: {
        id: committed.file.id,
        originalName: committed.file.originalName,
        mimeType: committed.file.mimeType,
        size: committed.file.size.toString(),
        checksum: committed.file.checksum,
        createdAt: committed.file.createdAt
      },
      quota: {
        storageUsed: committed.quota.storageUsed.toString(),
        storageLimit: committed.quota.storageLimit.toString(),
        reservedUploadBytes: committed.quota.reservedUploadBytes.toString()
      }
    };
  });

  app.delete("/upload-sessions/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Abort a resumable upload and release its reservation",
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const session = await loadOwnedSession(request.user.id, request.params.id);
    if (!session) return reply.code(404).send({ message: "Upload session not found" });
    if (session.status === "COMPLETED") {
      return reply.code(409).send({ message: "Completed uploads cannot be aborted" });
    }
    if (session.status === "ABORTED" || session.status === "EXPIRED") {
      await storage.deleteUploadSessionChunks(session.id).catch(() => {});
      return { message: `Upload session is already ${session.status.toLowerCase()}` };
    }
    if (session.status !== "UPLOADING") {
      return reply.code(409).send({ message: "Upload completion is in progress" });
    }

    // The audit event is written in the transaction that performs the abort (only the caller whose
    // compare-and-set succeeded writes it), so it can neither be missing nor duplicated.
    const aborted = await releaseSession(session, "ABORTED", prisma, {
      audit: (tx) => recordAudit(tx, {
        action: "UPLOAD_SESSION_ABORTED",
        details: session.id,
        userId: request.user.id,
        ip: clientIp(request)
      })
    });
    if (!aborted) return reply.code(409).send({ message: "Upload session state changed concurrently" });
    await storage.deleteUploadSessionChunks(session.id).catch(() => {});
    return { message: "Upload session aborted" };
  });
}

module.exports = uploadRoutes;
