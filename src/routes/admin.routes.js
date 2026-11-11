const prisma = require("../lib/prisma");
const { clientIp, describeTrustProxy } = require("../lib/client-ip");
const { recordAudit } = require("../lib/audit");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/admin");
const { formatBytes } = require("../lib/bytes");
const { getStorageReport } = require("../lib/storage-report");
const { decodeCursor, cursorWhere, cursorOrderBy, finishCursorPage } = require("../lib/pagination");
const { setAccountStatus } = require("../lib/account");

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
          includeTotal: { type: "boolean", description: "Page mode: false skips exact totals; defaults true for compatibility." },
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

    if (request.query.includeTotal === false) {
      const rows = await prisma.user.findMany({
        where: baseWhere,
        include: { plan: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit + 1
      });
      return {
        users: rows.slice(0, limit).map(serializeAdminUser),
        pagination: {
          mode: "page", page, limit, total: null, pages: null,
          hasMore: rows.length > limit
        }
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

    // One statement changes the status and bumps the session version: every outstanding token
    // is rejected on the next request on any instance (no cache to invalidate).
    // Status change, session revocation and audit event commit together.
    const updatedUser = await prisma.$transaction(async (tx) => {
      const changed = await setAccountStatus(id, "SUSPENDED", tx);
      if (!changed) return null;
      await recordAudit(tx, {
        action: "USER_SUSPENDED",
        details: request.body?.reason ? `${id}: ${request.body.reason}` : `Suspended ${id}`,
        userId: request.user.id,
        ip: clientIp(request)
      });
      return changed;
    });
    if (!updatedUser) return reply.code(404).send({ message: "User not found" });

    return { message: "User suspended successfully", user: updatedUser };
  });

  app.patch("/admin/users/:id/reactivate", {
    preHandler: [requireAuth, requireAdmin],
    schema: { tags: ["Admin"], summary: "Reactivate a suspended user", security: [{ bearerAuth: [] }] }
  }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!user) return reply.code(404).send({ message: "User not found" });

    // Reactivation also bumps the session version, so tokens issued before the suspension stay dead.
    const updatedUser = await prisma.$transaction(async (tx) => {
      const changed = await setAccountStatus(user.id, "ACTIVE", tx);
      if (!changed) return null;
      await recordAudit(tx, {
        action: "USER_REACTIVATED",
        details: `Reactivated ${user.id}`,
        userId: request.user.id,
        ip: clientIp(request)
      });
      return changed;
    });
    if (!updatedUser) return reply.code(404).send({ message: "User not found" });

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

    const deletedUser = await prisma.$transaction(async (tx) => {
      const changed = await setAccountStatus(id, "DELETED", tx);
      if (!changed) return null;
      await recordAudit(tx, {
        action: "USER_DELETED",
        details: `Deleted ${id}`,
        userId: request.user.id,
        ip: clientIp(request)
      });
      return changed;
    });
    if (!deletedUser) return reply.code(404).send({ message: "User not found" });

    return { message: "User deleted successfully", user: deletedUser };
  });

  app.get("/admin/network-diagnostics", {
    preHandler: [requireAuth, requireAdmin],
    schema: {
      tags: ["Admin"],
      summary: "Show how this request's client IP was derived (verify the trusted-proxy setting)",
      description: "Call it from a client whose address you know. `clientIp` must equal that address and `socketAddress` should be your ingress proxy. If `clientIp` is the proxy's address, TRUST_PROXY does not cover the real ingress; if it ever shows a value you did not send from, the setting is too permissive.",
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => ({
    trustProxy: {
      policy: describeTrustProxy(app.vaultboxConfig?.trustProxy),
      source: app.vaultboxConfig?.trustProxySource || "default"
    },
    clientIp: clientIp(request),
    socketAddress: request.raw.socket?.remoteAddress || null,
    forwardedFor: request.headers["x-forwarded-for"] || null,
    chain: request.ips || [clientIp(request)]
  }));

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
