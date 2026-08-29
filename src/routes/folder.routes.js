const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { reserve, complete } = require("../lib/idempotency");

async function folderRoutes(app) {
  app.post("/folders", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "Create folder",
      security: [{ bearerAuth: [] }],
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

    const idempotencyKey = request.headers["idempotency-key"];
    const idempotencyPayload = { userId: request.user.id, name };
    const reservation = await reserve("folder-create", idempotencyKey, idempotencyPayload, 600);

    if (!reservation.acquired) {
      if (!reservation.samePayload) {
        return reply.code(422).send({ message: "Idempotency key was already used with a different request" });
      }
      if (reservation.replay) {
        reply.header("Idempotent-Replay", "true");
        return reply.code(201).send(reservation.replay);
      }
      return reply.code(409).send({ message: "An identical request is still in progress" });
    }

    const folder = await prisma.folder.create({
      data: { name, userId: request.user.id }
    });
    const response = { message: "Folder created successfully", folder };
    await complete("folder-create", idempotencyKey, idempotencyPayload, response, 600);

    return reply.code(201).send(response);
  });

  app.get("/folders", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "List folders with pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      }
    }
  }, async (request) => {
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 25);
    const where = { userId: request.user.id };

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
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
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
