const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { formatBytes } = require("../lib/bytes");
const { getStorageReport } = require("../lib/storage-report");
const { decodeCursor, cursorWhere, cursorOrderBy, finishCursorPage } = require("../lib/pagination");
const cache = require("../lib/cache");

const createdAtCursor = { sort: "createdAt", order: "desc", type: "date" };

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

function decodeCreatedAtCursor(raw) {
  return raw ? decodeCursor(raw, createdAtCursor) : null;
}

async function adminRoutes(app) {
  app.get("/admin/users", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "List users with bounded page or cursor pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          pagination: { type: "string", enum: ["page", "cursor"] },
          page: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string", maxLength: 1024 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "DELETED"] },
          search: { type: "string", maxLength: 120 }
        }
      }
    }
  }, async (request, reply) => {
    const mode = request.query.pagination || "page";
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 25);
    const search = request.query.search?.trim();
    const baseWhere = {
      ...(request.query.status ? { status: request.query.status } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } }
        ]
      } : {})
    };

    if (mode === "cursor") {
      let decoded;
      try {
        decoded = decodeCreatedAtCursor(request.query.cursor);
      } catch {
        return reply.code(400).send({ message: "Invalid pagination cursor" });
      }

      const rows = await prisma.user.findMany({
        where: { AND: [baseWhere, cursorWhere(decoded, createdAtCursor)] },
        include: { plan: true },
        orderBy: cursorOrderBy("createdAt", "desc"),
        take: limit + 1
      });
      const result = finishCursorPage(rows, limit, createdAtCursor);
      return {
        users: result.items.map(serializeAdminUser),
        pagination: { ...result.pagination, limit }
      };
    }

    const [total, users] = await prisma.$transaction([
      prisma.user.count({ where: baseWhere }),
      prisma.user.findMany({
        where: baseWhere,
        include: { plan: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return {
      users: users.map(serializeAdminUser),
      pagination: { mode: "page", page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
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
    const report = await getStorageReport();
    const totalStorageUsed = report.totalStorageUsed || 0n;

    return {
      totalUsers: report.totalUsers,
      activeUsers: report.activeUsers,
      suspendedUsers: report.suspendedUsers,
      deletedUsers: report.deletedUsers,
      totalStorageUsed: totalStorageUsed.toString(),
      totalStorageUsedFormatted: formatBytes(totalStorageUsed)
    };
  });

  app.get("/admin/audit-logs", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "View audit logs with bounded page or cursor pagination",
      security: [{ bearerAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          pagination: { type: "string", enum: ["page", "cursor"] },
          page: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string", maxLength: 1024 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          action: { type: "string", maxLength: 80 }
        }
      }
    }
  }, async (request, reply) => {
    const mode = request.query.pagination || "page";
    const page = Number(request.query.page || 1);
    const limit = Number(request.query.limit || 50);
    const where = request.query.action ? { action: request.query.action } : {};
    const include = { user: { select: { id: true, name: true, email: true, role: true } } };

    if (mode === "cursor") {
      let decoded;
      try {
        decoded = decodeCreatedAtCursor(request.query.cursor);
      } catch {
        return reply.code(400).send({ message: "Invalid pagination cursor" });
      }

      const rows = await prisma.auditLog.findMany({
        where: { AND: [where, cursorWhere(decoded, createdAtCursor)] },
        include,
        orderBy: cursorOrderBy("createdAt", "desc"),
        take: limit + 1
      });
      const result = finishCursorPage(rows, limit, createdAtCursor);
      return { logs: result.items, pagination: { ...result.pagination, limit } };
    }

    const [total, logs] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit
      })
    ]);

    return {
      logs,
      pagination: { mode: "page", page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    };
  });
}

module.exports = adminRoutes;
