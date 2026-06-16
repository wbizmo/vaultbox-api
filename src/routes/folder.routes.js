const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

async function folderRoutes(app) {
  app.post("/folders", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "Create folder",
      security: [{ bearerAuth: [] }],
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" }
        }
      }
    }
  }, async (request, reply) => {
    const folder = await prisma.folder.create({
      data: {
        name: request.body.name,
        userId: request.user.id
      }
    });

    return reply.code(201).send({ message: "Folder created successfully", folder });
  });

  app.get("/folders", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "List folders",
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const folders = await prisma.folder.findMany({
      where: { userId: request.user.id },
      include: { _count: { select: { files: true } } },
      orderBy: { createdAt: "desc" }
    });

    return { folders };
  });

  app.patch("/folders/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "Rename folder",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" }
        }
      },
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" }
        }
      }
    }
  }, async (request, reply) => {
    const folder = await prisma.folder.findFirst({
      where: {
        id: request.params.id,
        userId: request.user.id
      }
    });

    if (!folder) return reply.code(404).send({ message: "Folder not found" });

    const updatedFolder = await prisma.folder.update({
      where: { id: folder.id },
      data: { name: request.body.name }
    });

    return { message: "Folder renamed successfully", folder: updatedFolder };
  });

  app.delete("/folders/:id", {
    preHandler: requireAuth,
    schema: {
      tags: ["Folders"],
      summary: "Delete folder",
      security: [{ bearerAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" }
        }
      }
    }
  }, async (request, reply) => {
    const folder = await prisma.folder.findFirst({
      where: {
        id: request.params.id,
        userId: request.user.id
      }
    });

    if (!folder) return reply.code(404).send({ message: "Folder not found" });

    await prisma.folder.delete({ where: { id: folder.id } });

    return { message: "Folder deleted successfully" };
  });
}

module.exports = folderRoutes;
