const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const uploadDir = path.join(process.cwd(), "storage", "uploads");

function formatBytes(bytes) {
  const value = Number(bytes);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

async function ensureUploadDir() {
  await fs.promises.mkdir(uploadDir, { recursive: true });
}

async function fileRoutes(app) {
  app.post("/files/upload", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Upload a file with quota enforcement",
      security: [{ bearerAuth: [] }],
      consumes: ["multipart/form-data"],
      response: {
        201: {
          type: "object",
          properties: {
            message: { type: "string" },
            file: {
              type: "object",
              properties: {
                id: { type: "string" },
                originalName: { type: "string" },
                mimeType: { type: "string" },
                size: { type: "string" },
                sizeFormatted: { type: "string" },
                checksum: { type: "string" },
                createdAt: { type: "string" }
              }
            },
            quota: {
              type: "object",
              properties: {
                storageUsed: { type: "string" },
                storageLimit: { type: "string" },
                storageUsedFormatted: { type: "string" },
                storageLimitFormatted: { type: "string" }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    await ensureUploadDir();

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      include: { plan: true }
    });

    if (!user || user.status !== "ACTIVE") {
      return reply.code(403).send({ message: "Account is not active" });
    }

    if (!user.plan) {
      return reply.code(403).send({ message: "No active storage plan found" });
    }

    const data = await request.file();

    if (!data) {
      return reply.code(400).send({ message: "No file uploaded" });
    }

    const originalName = data.filename;
    const mimeType = data.mimetype || "application/octet-stream";
    const storedName = `${crypto.randomUUID()}-${originalName}`;
    const filePath = path.join(uploadDir, storedName);

    await pipeline(data.file, fs.createWriteStream(filePath));

    const stats = await fs.promises.stat(filePath);
    const fileSize = BigInt(stats.size);
    const nextUsage = BigInt(user.storageUsed) + fileSize;

    if (nextUsage > BigInt(user.plan.storageLimit)) {
      await fs.promises.unlink(filePath);

      return reply.code(413).send({
        message: "Storage quota exceeded",
        storageUsed: user.storageUsed.toString(),
        storageLimit: user.plan.storageLimit.toString(),
        attemptedUploadSize: fileSize.toString()
      });
    }

    const fileBuffer = await fs.promises.readFile(filePath);
    const checksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    const file = await prisma.file.create({
      data: {
        originalName,
        storedName,
        mimeType,
        size: fileSize,
        path: filePath,
        checksum,
        userId: user.id
      }
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { storageUsed: nextUsage }
    });

    await prisma.auditLog.create({
      data: {
        action: "FILE_UPLOADED",
        details: originalName,
        userId: user.id,
        ip: request.ip
      }
    });

    return reply.code(201).send({
      message: "File uploaded successfully",
      file: {
        id: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size.toString(),
        sizeFormatted: formatBytes(file.size),
        checksum: file.checksum,
        createdAt: file.createdAt
      },
      quota: {
        storageUsed: nextUsage.toString(),
        storageLimit: user.plan.storageLimit.toString(),
        storageUsedFormatted: formatBytes(nextUsage),
        storageLimitFormatted: formatBytes(user.plan.storageLimit)
      }
    });
  });

  app.get("/files", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "List current user's files",
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  originalName: { type: "string" },
                  mimeType: { type: "string" },
                  size: { type: "string" },
                  sizeFormatted: { type: "string" },
                  checksum: { type: "string" },
                  createdAt: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  }, async (request) => {
    const files = await prisma.file.findMany({
      where: {
        userId: request.user.id,
        status: "ACTIVE"
      },
      orderBy: { createdAt: "desc" }
    });

    return {
      files: files.map((file) => ({
        id: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size.toString(),
        sizeFormatted: formatBytes(file.size),
        checksum: file.checksum,
        createdAt: file.createdAt
      }))
    };
  });

  app.delete("/files/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Files"],
      summary: "Delete a file and update storage usage",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" }
        }
      },
      response: {
        200: {
          type: "object",
          properties: {
            message: { type: "string" }
          }
        }
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

    if (!file) {
      return reply.code(404).send({ message: "File not found" });
    }

    if (fs.existsSync(file.path)) {
      await fs.promises.unlink(file.path);
    }

    await prisma.file.update({
      where: { id: file.id },
      data: { status: "DELETED" }
    });

    const user = await prisma.user.findUnique({
      where: { id: request.user.id }
    });

    const newUsage = BigInt(user.storageUsed) - BigInt(file.size);

    await prisma.user.update({
      where: { id: request.user.id },
      data: {
        storageUsed: newUsage > 0n ? newUsage : 0n
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "FILE_DELETED",
        details: file.originalName,
        userId: request.user.id,
        ip: request.ip
      }
    });

    return { message: "File deleted successfully" };
  });
}

module.exports = fileRoutes;
