const prisma = require("../lib/prisma");
const { tokenVersion } = require("../lib/account");
const { AppError } = require("../lib/errors");

/*
 * Authentication reads the authoritative account state from PostgreSQL on every request.
 *
 * There is deliberately no cache of status or role: a cache that can be stale, fail to
 * invalidate, or be repopulated by a racing request is exactly how a suspended or demoted
 * account keeps its privileges. The cost is one primary-key lookup per request. Guarantee:
 * once a suspension, deletion, demotion or session revocation is committed, the next request
 * on ANY instance observes it (revocation latency is zero, independent of Redis).
 */
async function loadAccount(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, status: true, authVersion: true }
  });
}

async function requireAuth(request, reply) {
  try {
    await request.jwtVerify();
  } catch (error) {
    if (reply.sent) return;
    request.log.debug({ err: error }, "Authentication failed");
    return reply.code(401).send({ message: "Invalid or expired token" });
  }

  if (!request.user?.id) {
    return reply.code(401).send({ message: "Unauthorized" });
  }

  // A failing database lookup is an outage, not a bad credential. Answering 401 would tell clients
  // to discard valid sessions; surface it as 503 (logged at error level by the global handler).
  let account;
  try {
    account = await loadAccount(request.user.id);
  } catch (error) {
    const unavailable = new AppError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable");
    unavailable.cause = error;
    throw unavailable;
  }

  if (!account) {
    return reply.code(401).send({ message: "Account no longer exists" });
  }

  if (account.status !== "ACTIVE") {
    return reply.code(403).send({ message: `Account is ${account.status.toLowerCase()}` });
  }

  // The token was issued under an older (or, if a login raced a revocation, stale) session
  // version: the account was suspended, deleted, demoted or had its sessions revoked since.
  if (tokenVersion(request.user) !== account.authVersion) {
    return reply.code(401).send({ message: "Session is no longer valid; please sign in again" });
  }

  request.user = {
    ...request.user,
    email: account.email,
    role: account.role,
    status: account.status
  };
}

module.exports = { requireAuth };
