async function requireAuth(request, reply) {
  try {
    await request.jwtVerify();

    if (!request.user?.id) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
  } catch {
    return reply.code(401).send({ message: "Invalid or expired token" });
  }
}

module.exports = { requireAuth };