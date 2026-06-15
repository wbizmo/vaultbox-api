const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");

function formatBytes(bytes) {
  const value = Number(bytes);

  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;

  return `${value} B`;
}

async function adminRoutes(app) {
  app.get("/admin/users", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "List all users",
      security: [{ bearerAuth: [] }]
    }
  }, async () => {
    const users = await prisma.user.findMany({
      include: { plan: true },
      orderBy: { createdAt: "desc" }
    });

    return {
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        storageUsed: user.storageUsed.toString(),
        storageUsedFormatted: formatBytes(user.storageUsed),
        plan: user.plan
          ? {
              id: user.plan.id,
              name: user.plan.name,
              priceMonthly: user.plan.priceMonthly,
              storageLimit: user.plan.storageLimit.toString(),
              storageLimitFormatted: formatBytes(user.plan.storageLimit)
            }
          : null,
        createdAt: user.createdAt
      }))
    };
  });

  app.patch("/admin/users/:id/suspend", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "Suspend a user account",
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
        properties: {
          reason: { type: "string" }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { reason } = request.body || {};

    if (id === request.user.id) {
      return reply.code(400).send({ message: "You cannot suspend your own account" });
    }

    const user = await prisma.user.findUnique({
      where: { id }
    });

    if (!user) {
      return reply.code(404).send({ message: "User not found" });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { status: "SUSPENDED" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "USER_SUSPENDED",
        details: reason || `Suspended ${user.email}`,
        userId: request.user.id,
        ip: request.ip
      }
    });

    return {
      message: "User suspended successfully",
      user: updatedUser
    };
  });

  app.patch("/admin/users/:id/reactivate", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "Reactivate a suspended user",
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
    const { id } = request.params;

    const user = await prisma.user.findUnique({
      where: { id }
    });

    if (!user) {
      return reply.code(404).send({ message: "User not found" });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "USER_REACTIVATED",
        details: `Reactivated ${user.email}`,
        userId: request.user.id,
        ip: request.ip
      }
    });

    return {
      message: "User reactivated successfully",
      user: updatedUser
    };
  });

  app.delete("/admin/users/:id", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "Soft delete a user account",
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
    const { id } = request.params;

    if (id === request.user.id) {
      return reply.code(400).send({ message: "You cannot delete your own account" });
    }

    const user = await prisma.user.findUnique({
      where: { id }
    });

    if (!user) {
      return reply.code(404).send({ message: "User not found" });
    }

    const deletedUser = await prisma.user.update({
      where: { id },
      data: { status: "DELETED" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true
      }
    });

    await prisma.auditLog.create({
      data: {
        action: "USER_DELETED",
        details: `Deleted ${user.email}`,
        userId: request.user.id,
        ip: request.ip
      }
    });

    return {
      message: "User deleted successfully",
      user: deletedUser
    };
  });

  app.get("/admin/storage-report", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "Get platform-wide storage report",
      security: [{ bearerAuth: [] }]
    }
  }, async () => {
    const users = await prisma.user.findMany({
      include: { plan: true }
    });

    const totalStorageUsed = users.reduce((sum, user) => {
      return sum + BigInt(user.storageUsed);
    }, 0n);

    return {
      totalUsers: users.length,
      activeUsers: users.filter((user) => user.status === "ACTIVE").length,
      suspendedUsers: users.filter((user) => user.status === "SUSPENDED").length,
      deletedUsers: users.filter((user) => user.status === "DELETED").length,
      totalStorageUsed: totalStorageUsed.toString(),
      totalStorageUsedFormatted: formatBytes(totalStorageUsed)
    };
  });
}

module.exports = adminRoutes;
