const { PrismaClient } = require("@prisma/client");

// Query timing/count events are enabled only for an explicit isolated benchmark.
const prisma = new PrismaClient(
  process.env.VAULTBOX_BENCHMARK_QUERY_COUNT === "true"
    ? { log: [{ emit: "event", level: "query" }] }
    : undefined
);

module.exports = prisma;