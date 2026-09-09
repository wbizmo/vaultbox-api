const crypto = require("crypto");
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
  releaseSession,
  expireIfNeeded,
  cleanupUploadSessions
} = require("../lib/upload-session");
const { throttlePreHandler } = require("../lib/throttle");

const createThrottle = throttlePreHandler(
  "upload-session-create",
  { limit: 30, windowSeconds: 60 },
  (request) => request.user?.id || request.ip
);
const partThrottle = throttlePreHandler(
  "upload-session-part",
  { limit: 240, windowSeconds: 60 },
  (request) => request.user?.id || request.ip
);

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
        const reservation = await reservePendingUploadQuota(request.user.id, expectedSize, tx);
        if (!reservation) {
          const error = new Error("Storage quota exceeded");
          error.code = "STORAGE_QUOTA_EXCEEDED";
          throw error;
        }

        return tx.uploadSession.create({
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
      });
    } catch (error) {
      await storage.deleteUploadSessionChunks(sessionId).catch(() => {});
      if (error.code === "STORAGE_QUOTA_EXCEEDED") {
        return reply.code(413).send({ message: "Storage quota exceeded" });
      }
      throw error;
    }

    await prisma.auditLog.create({
      data: {
        action: "UPLOAD_SESSION_CREATED",
        details: `${session.id}:${session.originalName}:${session.expectedSize}`,
        userId: request.user.id,
        ip: request.ip
      }
    });

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
      await prisma.uploadPart.deleteMany({
        where: { id: existing.id, session: { userId: request.user.id } }
      });
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
      part = await prisma.uploadPart.create({
        data: {
          sessionId: session.id,
          partNumber,
          offset: expected.start,
          size: measuredSize,
          checksum,
          storedName
        }
      });
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

    const claimed = await prisma.uploadSession.updateMany({
      where: {
        id: session.id,
        userId: request.user.id,
        status: "UPLOADING",
        expiresAt: { gt: new Date() }
      },
      data: { status: "COMPLETING" }
    });
    if (claimed.count !== 1) {
      session = await loadOwnedSession(request.user.id, session.id);
      if (session?.status === "COMPLETED") {
        const response = await completedResponse(request.user.id, session);
        return response || reply.code(409).send({ message: "Completed upload file is unavailable" });
      }
      return reply.code(409).send({ message: "Upload completion is already in progress" });
    }

    const storedName = crypto.randomUUID();
    let assembled;
    try {
      assembled = await storage.assembleUploadParts(session.id, session.parts, storedName);
    } catch (error) {
      await prisma.uploadSession.updateMany({
        where: { id: session.id, userId: request.user.id, status: "COMPLETING" },
        data: { status: "UPLOADING" }
      });
      if (error.code === "ENOENT" && Number.isInteger(error.uploadPartNumber)) {
        await prisma.uploadPart.deleteMany({
          where: {
            sessionId: session.id,
            partNumber: error.uploadPartNumber,
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
      await storage.delete(storedName).catch(() => false);
      await prisma.uploadSession.updateMany({
        where: { id: session.id, userId: request.user.id, status: "COMPLETING" },
        data: { status: "UPLOADING" }
      });
      return reply.code(422).send({ message: "Assembled upload size mismatch" });
    }
    if (session.expectedChecksum && assembled.checksum !== session.expectedChecksum) {
      await storage.delete(storedName).catch(() => false);
      await prisma.uploadSession.updateMany({
        where: { id: session.id, userId: request.user.id, status: "COMPLETING" },
        data: { status: "UPLOADING" }
      });
      return reply.code(422).send({ message: "Final upload checksum mismatch" });
    }

    let committed;
    try {
      committed = await prisma.$transaction(async (tx) => {
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
            fileId: null
          },
          data: {
            status: "COMPLETED",
            fileId: file.id,
            completedAt: new Date()
          }
        });
        if (completed.count !== 1) throw new Error("Upload completion state changed concurrently");
        return { file, quota };
      });
    } catch (error) {
      await storage.delete(storedName).catch(() => false);
      await prisma.uploadSession.updateMany({
        where: { id: session.id, userId: request.user.id, status: "COMPLETING" },
        data: { status: "UPLOADING" }
      });
      throw error;
    }

    await storage.deleteUploadSessionChunks(session.id).catch((error) => {
      request.log.warn({ err: error, sessionId: session.id }, "Upload committed but chunk cleanup failed");
    });
    await prisma.auditLog.create({
      data: {
        action: "UPLOAD_SESSION_COMPLETED",
        details: `${session.id}:${committed.file.id}:${assembled.size}`,
        userId: request.user.id,
        ip: request.ip
      }
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

    const aborted = await releaseSession(session, "ABORTED");
    if (!aborted) return reply.code(409).send({ message: "Upload session state changed concurrently" });
    await storage.deleteUploadSessionChunks(session.id).catch(() => {});
    await prisma.auditLog.create({
      data: {
        action: "UPLOAD_SESSION_ABORTED",
        details: `${session.id}:${session.originalName}`,
        userId: request.user.id,
        ip: request.ip
      }
    });
    return { message: "Upload session aborted" };
  });
}

module.exports = uploadRoutes;
