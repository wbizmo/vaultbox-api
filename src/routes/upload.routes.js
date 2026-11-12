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
  cleanupUploadSessions,
  getUploadCleanupStats
} = require("../lib/upload-session");
const { retryOnConflict } = require("../lib/db-retry");
const { pruneMetadata } = require("../lib/metadata-retention");
const { assertOwnedFolderLocked } = require("../lib/folder-ownership");
const { claimTemporary, reserveTemporary, startTempHeartbeat,
  releaseTemporary, assertTemporaryOwned, ensurePhysicalHeadroom } = require("../lib/temporary-storage");
const { reconcileStorage } = require("../lib/storage-reconciliation");
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

function serializeSessionBase(session) {
  return {
    id: session.id,
    status: session.status,
    originalName: session.originalName,
    mimeType: session.mimeType,
    expectedSize: session.expectedSize.toString(),
    expectedChecksum: session.expectedChecksum,
    folderId: session.folderId ?? null,
    chunkSize: session.chunkSize,
    partCount: session.partCount,
    expiresAt: session.expiresAt,
    fileId: session.fileId,
    completedAt: session.completedAt
  };
}

function serializeSession(session, parts = session.parts || []) {
  return {
    ...serializeSessionBase(session),
    uploadedParts: parts.map(serializePart),
    missingParts: missingPartNumbers(session.partCount, parts)
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

  async function sweepUploadAndMetadata() {
    try {
      await cleanupUploadSessions(storage);
      const stats = getUploadCleanupStats();
      if (stats?.failures > 0) {
        app.log.warn({ cleanup: stats }, "Upload cleanup backlog has failures");
      } else if (stats?.claimed > 0 || stats?.terminal > 0 ||
        stats?.pendingBacklog > 0 || stats?.terminalBacklog > 0) {
        app.log.info({ cleanup: stats }, "Upload cleanup sweep progress");
      }
    } catch (error) {
      app.log.warn({ err: error }, "Resumable-upload cleanup failed");
    }
    try {
      const counts = await pruneMetadata();
      if (counts.total > 0) app.log.info({ counts }, "Transfer metadata pruned");
    } catch (error) {
      app.log.warn({ err: error }, "Transfer metadata pruning failed");
    }
    try {
      const report = await reconcileStorage(storage);
      if (report.errors || report.missingCommittedObjects || report.unclaimedLegacyObjects) {
        app.log.warn({ report }, "Storage reconciliation discrepancies require review");
      } else if (report.reaped) {
        app.log.info({ report }, "Stale temporary storage reconciled");
      }
    } catch (error) {
      app.log.warn({ err: error }, "Storage reconciliation failed");
    }
  }

  app.addHook("onReady", sweepUploadAndMetadata);
  const cleanupTimer = setInterval(sweepUploadAndMetadata, 5 * 60 * 1000);
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
          checksum: { type: "string", minLength: 64, maxLength: 64 },
          folderId: { type: "string", minLength: 1, maxLength: 255, description: "Optional owned target folder" }
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
    try {
      await ensurePhysicalHeadroom(storage, expectedSize * 2n);
    } catch (error) {
      if (error.code === "TEMP_STORAGE_BUDGET_EXCEEDED") {
        return reply.code(507).send({ message: "Not enough physical space for upload assembly" });
      }
      throw error;
    }
    await storage.prepareUploadSession(sessionId);

    let session;
    try {
      session = await prisma.$transaction(async (tx) => {
        await lockActiveUserForUpdate(tx, request.user.id);
        await assertOwnedFolderLocked(tx, request.user.id, request.body.folderId);
        // Parts and the assembled output may coexist: reserve 2x expected bytes.
        await claimTemporary({
          userId: request.user.id, objectKey: "session:" + sessionId,
          kind: "SESSION", bytes: expectedSize * 2n,
          leaseMs: (config.uploadSessionExpiresMinutes + 5) * 60000
        }, tx);
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
            folderId: request.body.folderId || null,
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
      if (error.code === "TEMP_STORAGE_BUDGET_EXCEEDED") {
        return reply.code(507).send({ message: "Temporary upload storage is at capacity" });
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
      summary: "Inspect resumable upload progress, optionally as a bounded page or summary",
      description: "Default view=legacy preserves uploadedParts and missingParts arrays. view=summary returns counts without a manifest; view=page returns up to 100 uploaded parts with an exclusive afterPart cursor. Completion validates the authoritative full manifest regardless of this response.",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          view: { type: "string", enum: ["legacy", "summary", "page"] },
          afterPart: { type: "integer", minimum: -1, maximum: 10000 },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      }
    }
  }, async (request, reply) => {
    const view = request.query.view || "legacy";
    let session = await loadOwnedSession(request.user.id, request.params.id, view === "legacy");
    if (!session) return reply.code(404).send({ message: "Upload session not found" });

    if (await expireIfNeeded(session, storage)) {
      session = await loadOwnedSession(request.user.id, request.params.id, view === "legacy");
    }
    if (!session) return reply.code(404).send({ message: "Upload session not found" });
    if (view === "legacy") return { session: serializeSession(session, session.parts) };

    const afterPart = request.query.afterPart ?? -1;
    const limit = request.query.limit ?? 100;

    // One repeatable-read snapshot keeps the session status, counts and page mutually consistent.
    // The indexed (sessionId, partNumber) keyset bounds SQL rows and response size at 101.
    const progress = await prisma.$transaction(async (tx) => {
      const current = await tx.uploadSession.findFirst({
        where: { id: request.params.id, userId: request.user.id }
      });
      if (!current) return null;
      const uploadedCount = await tx.uploadPart.count({ where: { sessionId: current.id } });
      const base = {
        ...serializeSessionBase(current),
        uploadedCount,
        missingCount: Math.max(0, current.partCount - uploadedCount)
      };
      if (view === "summary") return base;

      const rows = await tx.uploadPart.findMany({
        where: { sessionId: current.id, partNumber: { gt: afterPart } },
        orderBy: { partNumber: "asc" },
        take: limit + 1
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        ...base,
        uploadedParts: page.map(serializePart),
        partsPage: {
          afterPart,
          limit,
          hasMore,
          nextAfterPart: hasMore ? page[page.length - 1].partNumber : null
        }
      };
    }, { isolationLevel: "RepeatableRead" });
    if (!progress) return reply.code(404).send({ message: "Upload session not found" });
    return { session: progress };
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
      if (error.code === "ENOSPC" || error.code === "EDQUOT") {
        return reply.code(507).send({ message: "Temporary upload storage is full; retry this part" });
      }
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
    try {
      await ensurePhysicalHeadroom(storage, BigInt(session.expectedSize));
    } catch (error) {
      heartbeat.stop();
      await giveBack();
      if (error.code === "TEMP_STORAGE_BUDGET_EXCEEDED") {
        return reply.code(507).send({ message: "Not enough physical space to assemble upload" });
      }
      throw error;
    }
    const storedName = crypto.randomUUID();
    const assemblyKey = "assembly:" + storedName;
    let assemblyClaim;
    try {
      assemblyClaim = await reserveTemporary({
        userId: request.user.id, objectKey: assemblyKey, kind: "ASSEMBLY",
        // Accounted for by the session's existing 2x reservation.
        bytes: 0n, leaseMs: Math.max(120000, leaseMs)
      });
    } catch (error) {
      heartbeat.stop();
      await giveBack();
      if (error.code === "TEMP_STORAGE_BUDGET_EXCEEDED") {
        return reply.code(507).send({ message: "Concurrent temporary object limit reached" });
      }
      throw error;
    }
    const assemblyHeartbeat = startTempHeartbeat(assemblyKey, assemblyClaim.token, Math.max(120000, leaseMs));
    const deleteAbandonedAssembly = async () => {
      assemblyHeartbeat.stop();
      const removed = await storage.delete(storedName).then(() => true).catch(() => false);
      if (removed) await releaseTemporary(assemblyKey, assemblyClaim.token).catch(() => null);
    };
    let assembled;
    try {
      assembled = await storage.assembleUploadParts(session.id, session.parts, storedName, { signal: app.vaultboxShutdownSignal });
    } catch (error) {
      heartbeat.stop();
      await deleteAbandonedAssembly();
      await giveBack();
      if (error.code === "ENOSPC" || error.code === "EDQUOT") {
        return reply.code(507).send({ message: "Assembly storage is full; upload remains retryable" });
      }
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
      await deleteAbandonedAssembly();
      await giveBack();
      return reply.code(422).send({ message: "Assembled upload size mismatch" });
    }
    if (session.expectedChecksum && assembled.checksum !== session.expectedChecksum) {
      heartbeat.stop();
      await deleteAbandonedAssembly();
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
          select: { id: true, folderId: true }
        });
        if (!owned) throw leaseLostError();
        await assertOwnedFolderLocked(tx, request.user.id, owned.folderId);
        await assertTemporaryOwned(tx, assemblyKey, assemblyClaim.token);

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
            folderId: owned.folderId,
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
      if (error.code === "TEMP_CLAIM_LOST") {
        // A reconciler owns this stale object now; do not unlink bytes from
        // under its lease. Yield completion so the client can retry safely.
        assemblyHeartbeat.stop();
        await giveBack();
        return reply.code(409).send({ message: "Assembly ownership expired; retry upload completion" });
      }
      await deleteAbandonedAssembly();
      if (error.code === "UPLOAD_COMPLETION_LEASE_LOST") {
        // Someone else now owns (or has finished) this session; touch nothing of theirs.
        return reply.code(409).send({ message: "Upload completion lease was lost; retry completion" });
      }
      await giveBack();
      throw error;
    }
    heartbeat.stop();
    assemblyHeartbeat.stop();
    // File row and bytes committed: this object is now durable, not temporary.
    await releaseTemporary(assemblyKey, assemblyClaim.token).catch((error) =>
      request.log.warn({ err: error }, "Assembly ledger cleanup delayed")
    );

    try {
      await storage.deleteUploadSessionChunks(session.id);
      await prisma.uploadSession.updateMany({
        where: { id: session.id, status: "COMPLETED" },
        data: { chunksCleanedAt: new Date() }
      });
      await releaseTemporary("session:" + session.id);
    } catch (error) {
      request.log.warn({ err: error, sessionId: session.id }, "Upload committed but chunk cleanup failed");
    }
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

  async function cleanupTerminalSession(session) {
    try {
      await storage.deleteUploadSessionChunks(session.id);
      await prisma.uploadSession.updateMany({
        where: { id: session.id, status: { in: ["ABORTED", "EXPIRED", "COMPLETED"] } },
        data: { chunksCleanedAt: new Date() }
      });
      await releaseTemporary("session:" + session.id);
    } catch (error) {
      app.log.warn({ err: error }, "Terminal upload byte cleanup deferred to worker");
    }
  }

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
      await cleanupTerminalSession(session);
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
    await cleanupTerminalSession(session);
    return { message: "Upload session aborted" };
  });
}

module.exports = uploadRoutes;
