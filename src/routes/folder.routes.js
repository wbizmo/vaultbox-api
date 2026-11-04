const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { validateIdempotencyKey, runIdempotent } = require("../lib/idempotency");
const { decodeCursor, cursorWhere, cursorOrderBy, finishCursorPage } = require("../lib/pagination");

const folderCursorOptions = { sort: "createdAt", order: "desc", type: "date" };

async function folderRoutes(app) {
  app.post("/folders", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "Create folder",
      description: "Send an `Idempotency-Key` header (1-128 chars of letters, digits and `. _ : ~ -`) to make retries safe. The same user, key and body replays the original response (`Idempotent-Replay: true`); the same key with a different body returns 422; an identical request still running longer than the wait returns 409 with `Retry-After`. Keys are scoped to the authenticated user and kept for 24 hours.",
      security: [{ bearerAuth: [] }],
      headers: {
        type: "object",
        properties: {
          "idempotency-key": { type: "string", description: "Optional retry-safety key, scoped to the authenticated user." }
        }
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 120 } }
      }
    }
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name) return reply.code(400).send({ message: "Folder name is required" });

    let idempotencyKey;
    try {
      idempotencyKey = validateIdempotencyKey(request.headers["idempotency-key"]);
    } catch (error) {
      return reply.code(400).send({ message: error.message });
    }

    const createFolder = (client) => client.folder.create({ data: { name, userId: request.user.id } });

    if (!idempotencyKey) {
      const folder = await createFolder(prisma);
      return reply.code(201).send({ message: "Folder created successfully", folder });
    }

    // The idempotency claim, the folder and the stored response commit in one transaction:
    // a retry after any failure sees either nothing (and runs again) or the original result.
    let result;
    try {
      result = await runIdempotent({
        userId: request.user.id,
        operation: "folder.create",
        key: idempotencyKey,
        payload: { name },
        lockTimeoutMs: app.vaultboxConfig?.idempotencyLockTimeoutMs,
        execute: async (tx) => ({
          status: 201,
          body: { message: "Folder created successfully", folder: await createFolder(tx) }
        })
      });
    } catch (error) {
      if (error.code === "IDEMPOTENCY_IN_PROGRESS") {
        reply.header("Retry-After", "1");
        return reply.code(409).send({ message: "An identical request is still in progress; retry shortly" });
      }
      throw error;
    }

    if (result.mismatch) {
      return reply.code(422).send({ message: "Idempotency key was already used with a different request" });
    }
    if (result.replayed) reply.header("Idempotent-Replay", "true");
    return reply.code(result.status).send(result.body);
  });

  app.get("/folders", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "List folders with bounded page or cursor pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          pagination: { type: "string", enum: ["page", "cursor"] },
          page: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string", maxLength: 1024 },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      }
    }
  }, async (request, reply) => {
    const mode = request.query.pagination || "page";
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 25);
    const where = { userId: request.user.id };

    if (mode === "cursor") {
      let decoded = null;
      if (request.query.cursor) {
        try {
          decoded = decodeCursor(request.query.cursor, folderCursorOptions);
        } catch {
          return reply.code(400).send({ message: "Invalid pagination cursor" });
        }
      }

      const rows = await prisma.folder.findMany({
        where: { AND: [where, cursorWhere(decoded, folderCursorOptions)] },
        include: { _count: { select: { files: true } } },
        orderBy: cursorOrderBy("createdAt", "desc"),
        take: limit + 1
      });
      const result = finishCursorPage(rows, limit, folderCursorOptions);
      return { folders: result.items, pagination: { ...result.pagination, limit } };
    }

    const [total, folders] = await prisma.$transaction([
      prisma.folder.count({ where }),
      prisma.folder.findMany({
        where,
        include: { _count: { select: { files: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return {
      folders,
      pagination: { mode: "page", page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    };
  });

  app.patch("/folders/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "Rename folder",
      security: [{ bearerAuth: [] }],
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 120 } }
      }
    }
  }, async (request, reply) => {
    const folder = await prisma.folder.findFirst({
      where: { id: request.params.id, userId: request.user.id }
    });
    if (!folder) return reply.code(404).send({ message: "Folder not found" });

    const updatedFolder = await prisma.folder.update({
      where: { id: folder.id },
      data: { name: request.body.name.trim() }
    });

    return { message: "Folder renamed successfully", folder: updatedFolder };
  });

  app.delete("/folders/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "Delete a folder without deleting contained files",
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const folder = await prisma.folder.findFirst({
      where: { id: request.params.id, userId: request.user.id }
    });
    if (!folder) return reply.code(404).send({ message: "Folder not found" });

    await prisma.$transaction([
      prisma.file.updateMany({
        where: { folderId: folder.id, userId: request.user.id },
        data: { folderId: null }
      }),
      prisma.folder.delete({ where: { id: folder.id } })
    ]);

    return { message: "Folder deleted successfully; contained files were moved to the root" };
  });
}

module.exports = folderRoutes;
