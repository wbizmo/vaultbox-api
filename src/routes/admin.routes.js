const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { formatBytes } = require("../lib/bytes");
const cache = require("../lib/cache");

function serializeAdminUser(user) {
  return {
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
  };
}

async function invalidateAccount(userId) {
  await cache.del("auth-user", userId);
}

async function adminRoutes(app) {
  app.get("/admin/users", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "List users with bounded pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "DELETED"] },
          search: { type: "string", maxLength: 120 }
        }
      }
    }
  }, async (request) => {
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 25);
    const search = request.query.search?.trim();
    const where = {
      ...(request.query.status ? { status: request.query.status } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } }
        ]
      } : {})
    };

    const [total, users] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return {
      users: users.map(serializeAdminUser),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    };
  });

  app.patch("/admin/users/:id/suspend", {
    preHandler: [requireAuth, requireAdmin],
    schema: { tags: ["Admin"], summary: "Suspend a user account", security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const { id } = request.params;
    if (id === request.user.id) return reply.code(400).send({ message: "You cannot suspend your own account" });

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ message: "User not found" });

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { status: "SUSPENDED" },
      select: { id: true, name: true, email: true, role: true, status: true }
    });

    await Promise.all([
      invalidateAccount(id),
      prisma.auditLog.create({
        data: {
          action: "USER_SUSPENDED",
          details: request.body?.reason || `Suspended ${user.email}`,
          userId: request.user.id,
          ip: request.ip
        }
      })
    ]);

    return { message: "User suspended successfully", user: updatedUser };
  });

  app.patch("/admin/users/:id/reactivate", {
    preHandler: [requireAuth, requireAdmin],
    schema: { tags: ["Admin"], summary: "Reactivate a suspended user", security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!user) return reply.code(404).send({ message: "User not found" });

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { status: "ACTIVE" },
      select: { id: true, name: true, email: true, role: true, status: true }
    });

    await Promise.all([
      invalidateAccount(user.id),
      prisma.auditLog.create({
        data: {
          action: "USER_REACTIVATED",
          details: `Reactivated ${user.email}`,
          userId: request.user.id,
          ip: request.ip
        }
      })
    ]);

    return { message: "User reactivated successfully", user: updatedUser };
  });

  app.delete("/admin/users/:id", {
    preHandler: [requireAuth, requireAdmin],
    schema: { tags: ["Admin"], summary: "Soft delete a user account", security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const { id } = request.params;
    if (id === request.user.id) return reply.code(400).send({ message: "You cannot delete your own account" });

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ message: "User not found" });

    const deletedUser = await prisma.user.update({
      where: { id },
      data: { status: "DELETED" },
      select: { id: true, name: true, email: true, role: true, status: true }
    });

    await Promise.all([
      invalidateAccount(id),
      prisma.auditLog.create({
        data: {
          action: "USER_DELETED",
          details: `Deleted ${user.email}`,
          userId: request.user.id,
          ip: request.ip
        }
      })
    ]);

    return { message: "User deleted successfully", user: deletedUser };
  });

  app.get("/admin/storage-report", {
    preHandler: [requireAuth, requireAdmin],
    schema: { tags: ["Admin"], summary: "Get platform-wide storage report", security: [{ bearerAuth: [] }] }
  }, async () => {
    const [statusGroups, storage] = await Promise.all([
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.aggregate({ _sum: { storageUsed: true }, _count: { _all: true } })
    ]);

    const counts = Object.fromEntries(statusGroups.map((group) => [group.status, group._count._all]));
    const totalStorageUsed = storage._sum.storageUsed || 0n;

    return {
      totalUsers: storage._count._all,
      activeUsers: counts.ACTIVE || 0,
      suspendedUsers: counts.SUSPENDED || 0,
      deletedUsers: counts.DELETED || 0,
      totalStorageUsed: totalStorageUsed.toString(),
      totalStorageUsedFormatted: formatBytes(totalStorageUsed)
    };
  });

  app.get("/admin/audit-logs", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "View audit logs with cursor-friendly pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          page: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          action: { type: "string", maxLength: 80 }
        }
      }
    }
  }, async (request) => {
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 50);
    const where = request.query.action ? { action: request.query.action } : {};

    const [total, logs] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return {
      logs,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    };
  });
}

module.exports = adminRoutes;
