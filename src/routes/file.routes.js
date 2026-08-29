const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { formatBytes } = require("../lib/bytes");
const { HashingTransform } = require("../lib/hash-stream");
const { storage } = require("../lib/storage");
const cache = require("../lib/cache");

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

async function fileRoutes(app) {
  app.post("/files/upload", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Stream a file to storage with atomic quota enforcement",
      security: [{ bearerAuth: [] }],
      consumes: ["multipart/form-data"]
    }
  }, async (request, reply) => {
    await storage.ready();

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      include: { plan: true }
    });

    if (!user?.plan) {
      return reply.code(403).send({ message: "No active storage plan found" });
    }

    const data = await request.file();
    if (!data) return reply.code(400).send({ message: "No file uploaded" });

    const originalName = String(data.filename || "upload").slice(0, 255);
    const mimeType = String(data.mimetype || "application/octet-stream").slice(0, 255);
    const storedName = crypto.randomUUID();
    const hasher = new HashingTransform("sha256");

    try {
      await pipeline(data.file, hasher, storage.createWriteStream(storedName));
    } catch (error) {
      await storage.delete(storedName).catch(() => false);
      throw error;
    }

    if (data.file.truncated) {
      await storage.delete(storedName).catch(() => false);
      return reply.code(413).send({ message: "Upload exceeds the configured file-size limit" });
    }

    const fileSize = hasher.bytes;
    const checksum = hasher.digest();
    let file;

    try {
      file = await prisma.$transaction(async (tx) => {
        const reserved = await tx.$executeRaw`
          UPDATE "User"
          SET "storageUsed" = "storageUsed" + ${fileSize}, "updatedAt" = NOW()
          WHERE "id" = ${user.id}
            AND "storageUsed" + ${fileSize} <= ${user.plan.storageLimit}
        `;

        if (reserved !== 1) {
          const quotaError = new Error("Storage quota exceeded");
          quotaError.code = "STORAGE_QUOTA_EXCEEDED";
          throw quotaError;
        }

        return tx.file.create({
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
      });
    } catch (error) {
      await storage.delete(storedName).catch(() => false);

      if (error.code === "STORAGE_QUOTA_EXCEEDED") {
        return reply.code(413).send({
          message: "Storage quota exceeded",
          storageLimit: user.plan.storageLimit.toString(),
          attemptedUploadSize: fileSize.toString()
        });
      }

      throw error;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { storageUsed: true }
    });

    await Promise.all([
      prisma.auditLog.create({
        data: {
          action: "FILE_UPLOADED",
          details: `${file.id}:${originalName}`,
          userId: user.id,
          ip: request.ip
        }
      }),
      cache.del("file-list", user.id)
    ]);

    return reply.code(201).send({
      message: "File uploaded successfully",
      file: serializeFile(file),
      quota: {
        storageUsed: currentUser.storageUsed.toString(),
        storageLimit: user.plan.storageLimit.toString(),
        storageUsedFormatted: formatBytes(currentUser.storageUsed),
        storageLimitFormatted: formatBytes(user.plan.storageLimit)
      }
    });
  });

  app.get("/files", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "List current user's files with bounded pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1, maximum: 1000000 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          search: { type: "string", maxLength: 120 },
          sort: { type: "string", enum: ["createdAt", "updatedAt", "size", "originalName"] },
          order: { type: "string", enum: ["asc", "desc"] }
        }
      }
    }
  }, async (request) => {
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 25);
    const search = request.query.search?.trim();
    const sort = request.query.sort || "createdAt";
    const order = request.query.order || "desc";
    const where = {
      userId: request.user.id,
      status: "ACTIVE",
      ...(search ? { originalName: { contains: search, mode: "insensitive" } } : {})
    };

    const [total, files] = await prisma.$transaction([
      prisma.file.count({ where }),
      prisma.file.findMany({
        where,
        orderBy: { [sort]: order },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return {
      files: files.map(serializeFile),
      pagination: {
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
    const file = await prisma.file.findFirst({
      where: {
        id: request.params.id,
        userId: request.user.id,
        status: "ACTIVE"
      }
    });

    if (!file) return reply.code(404).send({ message: "File not found" });

    await prisma.$transaction(async (tx) => {
      await tx.file.update({
        where: { id: file.id },
        data: { status: "DELETED" }
      });

      await tx.$executeRaw`
        UPDATE "User"
        SET "storageUsed" = GREATEST("storageUsed" - ${file.size}, 0), "updatedAt" = NOW()
        WHERE "id" = ${request.user.id}
      `;
    });

    const removed = await storage.deleteFile(file).catch((error) => {
      request.log.error({ err: error, fileId: file.id }, "Failed to remove stored file bytes");
      return false;
    });

    await Promise.all([
      prisma.auditLog.create({
        data: {
          action: removed ? "FILE_DELETED" : "FILE_DELETED_METADATA_ONLY",
          details: `${file.id}:${file.originalName}`,
          userId: request.user.id,
          ip: request.ip
        }
      }),
      cache.del("file", file.id),
      cache.del("file-list", request.user.id)
    ]);

    return { message: "File deleted successfully" };
  });
}

module.exports = fileRoutes;
