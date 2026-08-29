const prisma = require("../lib/prisma");
const cache = require("../lib/cache");

async function loadAccount(userId) {
  const cached = await cache.getJson("auth-user", userId);
  if (cached) return cached;

  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      status: true
    }
  });

  if (account) {
    await cache.setJson("auth-user", userId, account, 10);
  }

  return account;
}

async function requireAuth(request, reply) {
  try {
    await request.jwtVerify();

    if (!request.user?.id) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const account = await loadAccount(request.user.id);

    if (!account) {
      return reply.code(401).send({ message: "Account no longer exists" });
    }

    if (account.status !== "ACTIVE") {
      return reply.code(403).send({ message: `Account is ${account.status.toLowerCase()}` });
    }

    request.user = {
      ...request.user,
      email: account.email,
      role: account.role,
      status: account.status
    };
  } catch (error) {
    if (reply.sent) return;
    request.log.debug({ err: error }, "Authentication failed");
    return reply.code(401).send({ message: "Invalid or expired token" });
  }
}

module.exports = { requireAuth };
