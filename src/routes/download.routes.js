const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { storage } = require("../lib/storage");
const { contentDispositionAttachment } = require("../lib/security");
const { parseSingleRange, rangeHeader } = require("../lib/range");
const { createDownloadToken, hashDownloadToken, etagForChecksum } = require("../lib/download-token");
const { recordFirstDownload } = require("../lib/download-session");
const { throttlePreHandler } = require("../lib/throttle");

const tokenThrottle = throttlePreHandler(
  "download-token",
  { limit: 60, windowSeconds: 60 },
  (request) => request.user?.id || request.ip
);

async function loadDownloadRecord(rawToken) {
  return prisma.downloadToken.findUnique({
    where: { token: hashDownloadToken(rawToken) },
    include: {
      file: true,
      user: { select: { status: true } }
    }
  });
}

async function validateDownload(request, reply, checkStorage = false) {
  const record = await loadDownloadRecord(request.params.token);

  if (!record) {
    reply.code(404).send({ message: "Invalid download token" });
    return null;
  }

  if (record.expiresAt < new Date()) {
    reply.code(410).send({ message: "Download token has expired" });
    return null;
  }

  if (record.user.status !== "ACTIVE") {
    reply.code(403).send({ message: "Account is not active" });
    return null;
  }

  if (record.file.status !== "ACTIVE") {
    reply.code(404).send({ message: "File no longer exists" });
    return null;
  }

  if (checkStorage && !(await storage.existsFile(record.file))) {
    reply.code(404).send({ message: "Stored file missing" });
    return null;
  }

  return record;
}

function setDownloadHeaders(reply, file, etag) {
  reply.header("Accept-Ranges", "bytes");
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Disposition", contentDispositionAttachment(file.originalName));
  reply.header("Content-Type", file.mimeType || "application/octet-stream");
  if (etag) reply.header("ETag", etag);
  reply.header("Last-Modified", file.updatedAt.toUTCString());
}

async function openDownloadStream(reply, file, options) {
  try {
    return await storage.openReadStreamForFile(file, options);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") {
      reply.code(404).send({ message: "Stored file missing" });
      return null;
    }
    throw error;
  }
}

async function serveDownload(request, reply, headOnly = false) {
  const record = await validateDownload(request, reply, headOnly);
  if (!record) return;

  const file = record.file;
  const totalSize = BigInt(file.size);
  const etag = etagForChecksum(file.checksum);
  setDownloadHeaders(reply, file, etag);

  const ifRange = request.headers["if-range"];
  const canUseRange = !ifRange || (etag && ifRange === etag);
  let range = null;

  if (request.headers.range && canUseRange) {
    try {
      range = parseSingleRange(request.headers.range, totalSize);
    } catch (error) {
      reply.header("Content-Range", `bytes */${totalSize}`);
      return reply.code(416).send({ message: error.message });
    }
  }

  if (range) {
    reply.code(206);
    reply.header("Content-Range", rangeHeader(range, totalSize));
    reply.header("Content-Length", range.length.toString());

    if (headOnly) {
      await recordFirstDownload(record, request.ip);
      return reply.send();
    }

    const stream = await openDownloadStream(reply, file, {
      start: Number(range.start),
      end: Number(range.end)
    });
    if (!stream) return;

    await recordFirstDownload(record, request.ip);
    return reply.send(stream);
  }

  reply.header("Content-Length", totalSize.toString());
  if (headOnly) {
    await recordFirstDownload(record, request.ip);
    return reply.send();
  }

  const stream = await openDownloadStream(reply, file);
  if (!stream) return;

  await recordFirstDownload(record, request.ip);
  return reply.send(stream);
}

async function downloadRoutes(app) {
  app.post("/files/:id/download-token", {
    preHandler: [requireAuth, tokenThrottle],
    schema: {
      tags: ["Downloads"],
      summary: "Create a resumable short-lived download session",
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

    const expiresAt = new Date(
      Date.now() + app.vaultboxConfig.downloadTokenExpiresMinutes * 60 * 1000
    );
    const token = createDownloadToken();

    await prisma.downloadToken.create({
      data: {
        token: token.hash,
        fileId: file.id,
        userId: request.user.id,
        expiresAt
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "DOWNLOAD_SESSION_CREATED",
        details: `${file.id}:${file.originalName}`,
        userId: request.user.id,
        ip: request.ip
      }
    });

    return {
      message: "Download session created",
      token: token.raw,
      expiresAt,
      downloadUrl: `/download/${token.raw}`,
      capabilities: {
        resumable: true,
        parallelRanges: true,
        acceptRanges: "bytes",
        suggestedPartBytes: app.vaultboxConfig.downloadSuggestedPartBytes,
        suggestedParallelRequests: app.vaultboxConfig.downloadMaxRanges,
        etag: etagForChecksum(file.checksum),
        size: file.size.toString()
      }
    };
  });

  app.get("/files/:id/download-capabilities", {
    preHandler: requireAuth,
    schema: {
      tags: ["Downloads"],
      summary: "Inspect file transfer capabilities",
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const file = await prisma.file.findFirst({
      where: { id: request.params.id, userId: request.user.id, status: "ACTIVE" }
    });

    if (!file) return reply.code(404).send({ message: "File not found" });

    return {
      fileId: file.id,
      size: file.size.toString(),
      etag: etagForChecksum(file.checksum),
      acceptRanges: "bytes",
      resumable: true,
      parallelRanges: true,
      suggestedPartBytes: app.vaultboxConfig.downloadSuggestedPartBytes,
      suggestedParallelRequests: app.vaultboxConfig.downloadMaxRanges
    };
  });

  app.get("/download/:token", {
    schema: {
      tags: ["Downloads"],
      summary: "Download or resume a file with an optional byte range",
      params: {
        type: "object",
        required: ["token"],
        properties: { token: { type: "string", minLength: 20, maxLength: 200 } }
      }
    }
  }, async (request, reply) => serveDownload(request, reply, false));

  app.head("/download/:token", {
    schema: {
      tags: ["Downloads"],
      summary: "Inspect download metadata without transferring bytes"
    }
  }, async (request, reply) => serveDownload(request, reply, true));
}

module.exports = downloadRoutes;
