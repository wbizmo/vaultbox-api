const prisma = require("../lib/prisma");
const { clientIp } = require("../lib/client-ip");
const { recordAudit } = require("../lib/audit");
const { requireAuth } = require("../middleware/auth");
const { contentDispositionAttachment } = require("../lib/security");
const { parseSingleRange, rangeHeader } = require("../lib/range");
const { createDownloadToken, hashDownloadToken, etagForChecksum } = require("../lib/download-token");
const { recordFirstDownload, revokeDownloadSessions } = require("../lib/download-session");
const { throttlePreHandler } = require("../lib/throttle");
const { lockActiveUserShared } = require("../lib/upload-session");
const { tokenVersion } = require("../lib/account");

const tokenThrottle = throttlePreHandler(
  "download-token",
  { limit: 60, windowSeconds: 60, policy: "shared" },
  (request) => request.user?.id || clientIp(request)
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

  if (record.revokedAt) {
    reply.code(410).send({ message: "Download token has been revoked" });
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

  if (checkStorage && !(await request.server.vaultboxStorage.existsFile(record.file))) {
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

async function openDownloadStream(storage, reply, file, options) {
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

/**
 * Record the first use while a read stream is already open. If recording fails (for example the audit
 * insert is rejected and the transaction rolls back) nothing will ever consume or close that stream, so
 * destroy it -- otherwise its file descriptor leaks -- and let the original error produce the response.
 */
async function recordFirstDownloadOrRelease(record, request, stream) {
  try {
    await recordFirstDownload(record, clientIp(request));
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

/**
 * Serve (or inspect) a download session.
 *
 * Order matters (issue #52 and an error-reply bug found while testing #48):
 *   1. every refusal -- unknown/expired token, inactive account or file, unsatisfiable range, missing bytes --
 *      is decided and sent as a JSON error BEFORE any download header exists. Setting the binary Content-Type
 *      first made Fastify reject the JSON error body, turning a 404/416 into a 500;
 *   2. only a GET that has opened its stream records the session's first use ("started"): HEAD is metadata
 *      inspection, so it never sets usedAt and never emits DOWNLOAD_SESSION_STARTED. The compare-and-set in
 *      recordFirstDownload keeps concurrent first range requests down to exactly one event;
 *   3. the download headers are set last, then the body (or nothing, for HEAD) is sent.
 */
async function serveDownload(request, reply, headOnly = false) {
  const record = await validateDownload(request, reply, headOnly);
  if (!record) return;

  const file = record.file;
  const totalSize = BigInt(file.size);
  const etag = etagForChecksum(file.checksum);

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

  let stream = null;
  if (!headOnly) {
    stream = await openDownloadStream(
      request.server.vaultboxStorage,
      reply,
      file,
      range ? { start: Number(range.start), end: Number(range.end) } : undefined
    );
    if (!stream) return;
    await recordFirstDownloadOrRelease(record, request, stream);
  }

  setDownloadHeaders(reply, file, etag);
  if (range) {
    reply.code(206);
    reply.header("Content-Range", rangeHeader(range, totalSize));
    reply.header("Content-Length", range.length.toString());
  } else {
    reply.header("Content-Length", totalSize.toString());
  }

  return headOnly ? reply.send() : reply.send(stream);
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

    let sessionId;
    await prisma.$transaction(async (tx) => {
      await lockActiveUserShared(tx, request.user.id, tokenVersion(request.user));
      const created = await tx.downloadToken.create({
        data: {
          token: token.hash,
          fileId: file.id,
          userId: request.user.id,
          expiresAt
        }
      });
      sessionId = created.id;
      await recordAudit(tx, {
        action: "DOWNLOAD_SESSION_CREATED",
        details: file.id,
        userId: request.user.id,
        ip: clientIp(request)
      });
    });

    return {
      message: "Download session created",
      id: sessionId,
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

  app.delete("/download-sessions/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Downloads"],
      summary: "Revoke a download session so its URL stops working",
      security: [{ bearerAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }
    }
  }, async (request, reply) => {
    const owned = await prisma.downloadToken.findFirst({
      where: { id: request.params.id, userId: request.user.id },
      select: { id: true }
    });
    if (!owned) return reply.code(404).send({ message: "Download session not found" });
    await revokeDownloadSessions(request.user.id, { id: owned.id }, clientIp(request));
    return reply.code(204).send();
  });

  app.delete("/files/:id/download-sessions", {
    preHandler: requireAuth,
    schema: {
      tags: ["Downloads"],
      summary: "Revoke every active download session of one of your files",
      security: [{ bearerAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } }
    }
  }, async (request) => {
    const revoked = await revokeDownloadSessions(request.user.id, { fileId: request.params.id }, clientIp(request));
    return { revoked };
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
