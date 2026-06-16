const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

async function downloadRoutes(app) {
  app.post("/files/:id/download-token", {
    preHandler: requireAuth,
    schema: {
      tags: ["Downloads"],
      summary: "Create a short-lived signed download token",
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
            message: { type: "string" },
            token: { type: "string" },
            expiresAt: { type: "string" },
            downloadUrl: { type: "string" }
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

    if (!file) return reply.code(404).send({ message: "File not found" });

    const user = await prisma.user.findUnique({ where: { id: request.user.id } });

    if (!user || user.status !== "ACTIVE") {
      return reply.code(403).send({ message: "Account is not active" });
    }

    const expiresInMinutes = Number(process.env.DOWNLOAD_TOKEN_EXPIRES_MINUTES || 5);
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    const token = crypto.randomBytes(32).toString("hex");

    await prisma.downloadToken.create({
      data: {
        token,
        fileId: file.id,
        userId: user.id,
        expiresAt
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "DOWNLOAD_TOKEN_CREATED",
        details: file.originalName,
        userId: user.id,
        ip: request.ip
      }
    });

    return {
      message: "Download token created",
      token,
      expiresAt,
      downloadUrl: `/download/${token}`
    };
  });

  app.get("/download/:token", {
    schema: {
      tags: ["Downloads"],
      summary: "Download a file using a signed token",
      params: {
        type: "object",
        required: ["token"],
        properties: {
          token: { type: "string" }
        }
      }
    }
  }, async (request, reply) => {
    const record = await prisma.downloadToken.findUnique({
      where: { token: request.params.token },
      include: { file: true, user: true }
    });

    if (!record) return reply.code(404).send({ message: "Invalid download token" });
    if (record.usedAt) return reply.code(410).send({ message: "Download token has already been used" });
    if (record.expiresAt < new Date()) return reply.code(410).send({ message: "Download token has expired" });
    if (record.user.status !== "ACTIVE") return reply.code(403).send({ message: "Account is not active" });
    if (record.file.status !== "ACTIVE") return reply.code(404).send({ message: "File no longer exists" });
    if (!fs.existsSync(record.file.path)) return reply.code(404).send({ message: "Stored file missing" });

    await prisma.downloadToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() }
    });

    await prisma.auditLog.create({
      data: {
        action: "FILE_DOWNLOADED",
        details: record.file.originalName,
        userId: record.userId,
        ip: request.ip
      }
    });

    reply.header("Content-Disposition", `attachment; filename="${record.file.originalName}"`);
    reply.header("Content-Type", record.file.mimeType || "application/octet-stream");

    return reply.send(fs.createReadStream(path.resolve(record.file.path)));
  });
}

module.exports = downloadRoutes;
