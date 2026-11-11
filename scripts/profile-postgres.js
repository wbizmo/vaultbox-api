"use strict";
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const prisma = require("../src/lib/prisma");

const DEFAULT_SIZES = [100, 2000, 8000];
const ITERATIONS = Number(process.env.VAULTBOX_QUERY_PROFILE_ITERATIONS || 20);

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  if (!ordered.length) return null;
  return Math.round(ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)] * 1000) / 1000;
}

function walkPlan(node, found = []) {
  if (!node) return found;
  found.push({
    type: node["Node Type"], relation: node["Relation Name"] || null,
    index: node["Index Name"] || null, actualRows: node["Actual Rows"] ?? null,
    sharedReadBlocks: node["Shared Read Blocks"] ?? null
  });
  for (const child of node.Plans || []) walkPlan(child, found);
  return found;
}

const queries = [
  {
    name: "created-desc-cursor",
    sql: 'SELECT "id" FROM "File" WHERE "userId"=$1 AND "status"=\'ACTIVE\' ORDER BY "createdAt" DESC,"id" DESC LIMIT 26',
    args: (id) => [id]
  },
  {
    name: "size-desc-cursor",
    sql: 'SELECT "id" FROM "File" WHERE "userId"=$1 AND "status"=\'ACTIVE\' ORDER BY "size" DESC,"id" DESC LIMIT 26',
    args: (id) => [id]
  },
  {
    name: "folder-root-cursor",
    sql: 'SELECT "id" FROM "File" WHERE "userId"=$1 AND "status"=\'ACTIVE\' AND "folderId" IS NULL ORDER BY "createdAt" DESC,"id" DESC LIMIT 26',
    args: (id) => [id]
  },
  {
    name: "case-insensitive-search",
    sql: 'SELECT "id" FROM "File" WHERE "userId"=$1 AND "status"=\'ACTIVE\' AND "originalName" ILIKE $2 ORDER BY "createdAt" DESC,"id" DESC LIMIT 26',
    args: (id) => [id, "%quarterly%"]
  },
  {
    name: "short-term-search",
    sql: 'SELECT "id" FROM "File" WHERE "userId"=$1 AND "status"=\'ACTIVE\' AND "originalName" ILIKE $2 ORDER BY "createdAt" DESC,"id" DESC LIMIT 26',
    args: (id) => [id, "%re%"]
  },
  {
    name: "legacy-exact-total-count",
    sql: 'SELECT COUNT(*) FROM "File" WHERE "userId"=$1 AND "status"=\'ACTIVE\'',
    args: (id) => [id]
  }
];

async function explainAndTime(query, userId, client = prisma) {
  const args = query.args(userId);
  // The only SQL text comes from hardcoded, reviewed query definitions; all
  // tenant IDs and search terms are positional parameters.
  const planRows = await client.$queryRawUnsafe(
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query.sql, ...args
  );
  const result = planRows[0]["QUERY PLAN"][0];
  const samples = [];
  for (let i = 0; i < ITERATIONS + 5; i++) {
    const started = performance.now();
    await client.$queryRawUnsafe(query.sql, ...args);
    if (i >= 5) samples.push(performance.now() - started);
  }
  return {
    query: query.name,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    planningMs: result["Planning Time"],
    explainExecutionMs: result["Execution Time"],
    blocks: result.Plan["Shared Hit Blocks"] ?? null,
    planNodes: walkPlan(result.Plan)
  };
}

async function comparePageModes(userId, client = prisma) {
  const fetchPage = queries[0];
  const count = queries.find((query) => query.name === "legacy-exact-total-count");
  const latency = { legacyCountAndPage: [], optOutPage: [] };
  for (let i = 0; i < ITERATIONS + 5; i++) {
    for (const mode of Object.keys(latency)) {
      const start = performance.now();
      if (mode === "legacyCountAndPage") {
        await client.$queryRawUnsafe(count.sql, ...count.args(userId));
      }
      await client.$queryRawUnsafe(fetchPage.sql, ...fetchPage.args(userId));
      if (i >= 5) latency[mode].push(performance.now() - start);
    }
  }
  return Object.fromEntries(Object.entries(latency).map(([mode, timings]) => [
    mode, { p50Ms: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95) }
  ]));
}

async function insertTenantRows(userId, size, seed) {
  const statuses = ["ACTIVE", "ACTIVE", "ACTIVE", "ACTIVE", "DELETED"];
  for (let begin = 0; begin < size; begin += 500) {
    const rows = Array.from({ length: Math.min(500, size - begin) }, (_, offset) => {
      const i = begin + offset;
      const storedName = crypto.randomUUID();
      return {
        originalName: i % 17 === 0
          ? "Quarterly Budget Report " + i + ".pdf"
          : i % 23 === 0 ? "RESEARCH " + i + ".txt" : "Asset Document " + i + ".bin",
        storedName, mimeType: "application/octet-stream",
        size: BigInt((i % 751) + 1) * 1024n,
        path: storedName, userId, status: statuses[i % statuses.length],
        createdAt: new Date(Date.UTC(2026, 0, 1) + (i % 1000) * 1000),
        checksum: crypto.createHash("sha256").update(seed + ":" + i).digest("hex")
      };
    });
    await prisma.file.createMany({ data: rows });
  }
}

async function run({ sizes = DEFAULT_SIZES, client = prisma } = {}) {
  if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS < 5 || ITERATIONS > 1000) {
    throw new Error("VAULTBOX_QUERY_PROFILE_ITERATIONS must be 5..1000");
  }
  const tag = crypto.randomUUID();
  const userIds = [];
  const results = [];
  try {
    for (const size of sizes) {
      const user = await client.user.create({
        data: {
          name: "query-plan-" + tag,
          email: "query-plan-" + size + "-" + tag + "@example.invalid",
          password: "only-for-local-test"
        }
      });
      userIds.push(user.id);
      await insertTenantRows(user.id, size, tag);
      await client.$executeRawUnsafe('ANALYZE "File"');
      const profiles = [];
      for (const query of queries) profiles.push(await explainAndTime(query, user.id, client));
      const pageModeComparison = await comparePageModes(user.id, client);
      results.push({ tenantSize: size, profiles, pageModeComparison });
    }
    const pgVersion = await client.$queryRawUnsafe("SHOW server_version");
    const indexSizes = await client.$queryRawUnsafe(
      `SELECT indexrelname AS name, pg_relation_size(indexrelid)::text AS bytes
       FROM pg_stat_user_indexes WHERE schemaname='public'
       AND relname IN ('File','User','Folder') ORDER BY pg_relation_size(indexrelid) DESC`
    );
    return {
      indexSizes,
      environment: {
        postgresVersion: pgVersion[0].server_version,
        node: process.version, database: "PostgreSQL",
        queryIterations: ITERATIONS, data: "synthetic-skewed-tenant-files",
        sizes, preparedSQLParameters: true
      }, results
    };
  } finally {
    for (const userId of userIds) {
      await client.file.deleteMany({ where: { userId } });
      await client.user.delete({ where: { id: userId } });
    }
  }
}

if (require.main === module) {
  run().then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error("Query profile failed:", error.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
module.exports = { percentile, walkPlan, run, queries, explainAndTime, comparePageModes };
