async function requireAdmin(request, reply) {
  if (!request.user || request.user.role !== "ADMIN") {
    return reply.code(403).send({
      message: "Admin access required"
    });
  }
}

module.exports = { requireAdmin };
