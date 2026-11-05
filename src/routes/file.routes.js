const crypto = require("crypto");
const { clientIp } = require("../lib/client-ip");
const { recordAudit, recordAuditBestEffort } = require("../lib/audit");
const { pipeline } = require("stream/promises");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { formatBytes } = require("../lib/bytes");
const { HashingTransform } = require("../lib/hash-stream");
const { softDeleteFileWithQuota } = require("../lib/file-delete");
const { processFileDeletions, removeFileBytesNow, pruneFinishedFileDeletions } = require("../lib/file-deletion");
const {
  reserveUploadQuota
} = require("../lib/quota");
const {
  createReservation,
  startReservationHeartbeat,
  commitReservation,
  linkReservationFile,
  releaseReservation
} = require("../lib/upload-reservation");
const { lockActiveUserForUpdate } = require("../lib/upload-session");
const { retryOnConflict } = require("../lib/db-retry");
const { decodeCursor, cursorWhere, cursorOrderBy, finishCursorPage } = require("../lib/pagination");

const fileCursorTypes = {
  createdAt: "date",
  updatedAt: "date",
  size: "bigint",
  originalName: "string"
};

function serializeFile(file) {
  return {
    id: file.id,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size.toString(),
    sizeFormatted: formatBytes(file.size),
    checksum: file.checksum,
    folderId: file.folderId,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt
  };
}

function declaredUploadSize(request, maxUploadBytes) {
  const raw = request.headers["x-upload-size"];
  if (raw === undefined) return null;
  if (!/^\d+$/.test(String(raw))) return NaN;
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxUploadBytes) return NaN;
  return BigInt(size);
}

async function fileRoutes(app) {
  const storage = app.vaultboxStorage;

  // Byte-removal worker (issue #54). Every replica runs it; FOR UPDATE SKIP LOCKED plus the row lease make
  // concurrent sweeps safe, and a crashed sweep's rows are simply claimed again once their lease lapses.
  const sweepFileDeletions = async () => {
    try {
      await processFileDeletions(storage, { log: app.log });
      await pruneFinishedFileDeletions();
    } catch (error) {
      app.log.warn({ err: error }, "File deletion sweep failed");
    }
  };
  app.addHook("onReady", sweepFileDeletions);
  const fileDeletionTimer = setInterval(sweepFileDeletions, 60 * 1000);
  fileDeletionTimer.unref();
  app.addHook("onClose", async () => clearInterval(fileDeletionTimer));

  app.post("/files/upload", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Stream a file with optional early quota admission via x-upload-size",
      security: [{ bearerAuth: [] }],
      consumes: ["multipart/form-data"],
      headers: {
        type: "object",
        properties: {
          "x-upload-size": {
            type: "string",
            pattern: "^[0-9]+$",
            description: "Optional exact file byte count. When supplied, VaultBox reserves quota before reading the multipart file body."
          }
        }
      }
    }
  }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      include: { plan: true }
    });

    if (!user?.plan) {
      return reply.code(403).send({ message: "No active storage plan found" });
    }

    const expectedSize = declaredUploadSize(request, app.vaultboxConfig.maxUploadBytes);
    if (typeof expectedSize === "number" && Number.isNaN(expectedSize)) {
      return reply.code(400).send({
        message: "x-upload-size must be a positive integer within the configured upload limit"
      });
    }

    // With x-upload-size the pending quota is owned by a durable UploadReservation row (created in
    // the same transaction as the quota increment), so a crash cannot strand it: the sweeper
    // releases it once its lease lapses. Without the header nothing is held across the stream.
    const leaseMs = (app.vaultboxConfig.uploadReservationLeaseSeconds || 120) * 1000;
    let reservationId = null;
    let heartbeat = null;
    const releaseEarlyReservation = async () => {
      heartbeat?.stop();
      if (!reservationId) return;
      const id = reservationId;
      reservationId = null;
      await releaseReservation(id).catch(() => null);
    };

    if (expectedSize !== null) {
      const reserved = await createReservation(user.id, expectedSize, leaseMs);
      if (!reserved) {
        return reply.code(413).send({
          message: "Storage quota exceeded",
          attemptedUploadSize: expectedSize.toString(),
          storageLimit: user.plan.storageLimit.toString()
        });
      }
      reservationId = reserved.id;
      heartbeat = startReservationHeartbeat(reservationId, leaseMs);
    }

    let data;
    try {
      data = expectedSize === null
        ? await request.file()
        : await request.file({ limits: { fileSize: Number(expectedSize), files: 1 } });
    } catch (error) {
      await releaseEarlyReservation();
      throw error;
    }
    if (!data) {
      await releaseEarlyReservation();
      return reply.code(400).send({ message: "No file uploaded" });
    }

    const originalName = String(data.filename || "upload").slice(0, 255);
    const mimeType = String(data.mimetype || "application/octet-stream").slice(0, 255);
    const storedName = crypto.randomUUID();
    const hasher = new HashingTransform("sha256");

    try {
      await pipeline(data.file, hasher, storage.createWriteStream(storedName));
    } catch (error) {
      await storage.delete(storedName).catch(() => false);
      await releaseEarlyReservation();
      throw error;
    }

    if (data.file.truncated) {
      await storage.delete(storedName).catch(() => false);
      await releaseEarlyReservation();
      return reply.code(413).send({ message: "Upload exceeds its declared or configured file-size limit" });
    }

    const fileSize = hasher.bytes;
    const checksum = hasher.digest();
    if (expectedSize !== null && fileSize !== expectedSize) {
      await storage.delete(storedName).catch(() => false);
      await releaseEarlyReservation();
      return reply.code(422).send({
        message: "Uploaded byte count does not match x-upload-size",
        declaredSize: expectedSize.toString(),
        actualSize: fileSize.toString()
      });
    }

    let file;
    let admittedQuota;

    try {
      const committed = await retryOnConflict(() => prisma.$transaction(async (tx) => {
        // Lock order: User first (see lib/upload-session.js).
        // Account-state fence at the commit point: a suspension that landed while the body streamed
        // rejects the commit (403) and the bytes + reservation are given back by the catch below.
        await lockActiveUserForUpdate(tx, user.id);
        const reservation = expectedSize === null
          ? await reserveUploadQuota(user.id, fileSize, tx)
          : await commitReservation(tx, reservationId, user.id, fileSize);

        if (!reservation) {
          const quotaError = new Error(
            expectedSize === null ? "Storage quota exceeded" : "Upload reservation is no longer valid"
          );
          quotaError.code = expectedSize === null
            ? "STORAGE_QUOTA_EXCEEDED"
            : "UPLOAD_RESERVATION_INVALID";
          throw quotaError;
        }

        const created = await tx.file.create({
          data: {
            originalName,
            storedName,
            mimeType,
            size: fileSize,
            path: storedName,
            checksum,
            userId: user.id
          }
        });
        if (expectedSize !== null) await linkReservationFile(tx, reservationId, created.id);

        // Critical audit event, atomic with the file and the quota change: if it cannot be written the
        // whole upload rolls back (bytes removed below, reservation returned) and a retry is safe.
        await recordAudit(tx, {
          action: "FILE_UPLOADED",
          details: `${created.id}:${fileSize}`,
          userId: user.id,
          ip: clientIp(request)
        });

        return { file: created, reservation };
      }));

      file = committed.file;
      admittedQuota = committed.reservation;
      heartbeat?.stop();
      reservationId = null; // converted atomically with the file; nothing left to release
    } catch (error) {
      await storage.delete(storedName).catch(() => false);
      await releaseEarlyReservation();

      if (error.code === "STORAGE_QUOTA_EXCEEDED") {
        const currentUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { plan: { select: { storageLimit: true } } }
        });
        const currentLimit = currentUser?.plan?.storageLimit || 0n;

        return reply.code(413).send({
          message: "Storage quota exceeded",
          storageLimit: currentLimit.toString(),
          attemptedUploadSize: fileSize.toString()
        });
      }
      if (error.code === "UPLOAD_RESERVATION_INVALID") {
        return reply.code(409).send({ message: error.message });
      }

      throw error;
    }

    return reply.code(201).send({
      message: "File uploaded successfully",
      file: serializeFile(file),
      quota: {
        storageUsed: admittedQuota.storageUsed.toString(),
        storageLimit: admittedQuota.storageLimit.toString(),
        storageUsedFormatted: formatBytes(admittedQuota.storageUsed),
        storageLimitFormatted: formatBytes(admittedQuota.storageLimit)
      }
    });
  });

  app.get("/files", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "List current user's files with bounded page or cursor pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          pagination: { type: "string", enum: ["page", "cursor"] },
          page: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string", maxLength: 1024 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          search: { type: "string", maxLength: 120 },
          sort: { type: "string", enum: ["createdAt", "updatedAt", "size", "originalName"] },
          order: { type: "string", enum: ["asc", "desc"] }
        }
      }
    }
  }, async (request, reply) => {
    const mode = request.query.pagination || "page";
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 25);
    const search = request.query.search?.trim();
    const sort = request.query.sort || "createdAt";
    const order = request.query.order || "desc";
    const baseWhere = {
      userId: request.user.id,
      status: "ACTIVE",
      ...(search ? { originalName: { contains: search, mode: "insensitive" } } : {})
    };

    if (mode === "cursor") {
      const options = { sort, order, type: fileCursorTypes[sort] };
      let decoded = null;
      if (request.query.cursor) {
        try {
          decoded = decodeCursor(request.query.cursor, options);
        } catch {
          return reply.code(400).send({ message: "Invalid pagination cursor" });
        }
      }

      const rows = await prisma.file.findMany({
        where: { AND: [baseWhere, cursorWhere(decoded, options)] },
        orderBy: cursorOrderBy(sort, order),
        take: limit + 1
      });
      const result = finishCursorPage(rows, limit, options);

      return {
        files: result.items.map(serializeFile),
        pagination: { ...result.pagination, limit }
      };
    }

    const [total, files] = await prisma.$transaction([
      prisma.file.count({ where: baseWhere }),
      prisma.file.findMany({
        where: baseWhere,
        orderBy: { [sort]: order },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return {
      files: files.map(serializeFile),
      pagination: {
        mode: "page",
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    };
  });

  app.delete("/files/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Delete a file and update storage usage atomically",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } }
      }
    }
  }, async (request, reply) => {
    // The status change, the quota decrement and the audit event are one transaction: a failing audit
    // insert rolls the deletion back instead of leaving a deleted file behind an error response.
    const file = await prisma.$transaction(async (tx) => {
      const deleted = await softDeleteFileWithQuota(request.user.id, request.params.id, tx);
      if (!deleted) return null;
      await recordAudit(tx, {
        action: "FILE_DELETED",
        details: deleted.id,
        userId: request.user.id,
        ip: clientIp(request)
      });
      return deleted;
    });
    if (!file) return reply.code(404).send({ message: "File not found" });

    // The outbox row committed with the deletion, so the bytes are removed eventually even if this attempt
    // fails or the process dies right here; the worker below (and on every replica) retries with backoff.
    const removed = await removeFileBytesNow(storage, file.id, { log: request.log }).catch((error) => {
      request.log.error({ err: error, fileId: file.id }, "Failed to remove stored file bytes; queued for retry");
      return false;
    });

    if (!removed) {
      // The deletion itself is committed and audited; the leftover bytes stay queued in the outbox. This
      // marker event is best-effort and its failure cannot change the outcome.
      await recordAuditBestEffort(prisma, {
        action: "FILE_DELETED_METADATA_ONLY",
        details: file.id,
        userId: request.user.id,
        ip: clientIp(request)
      }, request.log);
    }

    return { message: "File deleted successfully" };
  });
}

module.exports = fileRoutes;
