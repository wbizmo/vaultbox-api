const { performance } = require("perf_hooks");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "benchmark-only-secret-that-is-long-enough";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://benchmark:benchmark@127.0.0.1:5432/benchmark";

const buildApp = require("../src/app");

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

async function runBatch(app, count, concurrency) {
  const latencies = [];
  let errors = 0;
  let issued = 0;
  const startedAt = performance.now();

  async function worker() {
    while (true) {
      const current = issued;
      issued += 1;
      if (current >= count) return;

      const requestStartedAt = performance.now();
      const response = await app.inject({ method: "GET", url: "/health" });
      latencies.push(performance.now() - requestStartedAt);
      if (response.statusCode !== 200) errors += 1;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);

  return {
    requests: count,
    concurrency,
    durationMs: Number(durationMs.toFixed(2)),
    requestsPerSecond: Number((count / (durationMs / 1000)).toFixed(2)),
    latencyMs: {
      min: Number(latencies[0].toFixed(3)),
      p50: Number(percentile(latencies, 0.50).toFixed(3)),
      p95: Number(percentile(latencies, 0.95).toFixed(3)),
      p99: Number(percentile(latencies, 0.99).toFixed(3)),
      max: Number(latencies[latencies.length - 1].toFixed(3)),
      average: Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(3))
    },
    errors
  };
}

async function main() {
  const app = buildApp({ logger: false });
  await app.ready();

  for (let i = 0; i < 250; i += 1) {
    await app.inject({ method: "GET", url: "/health" });
  }

  const result = await runBatch(
    app,
    Number(process.env.BENCH_REQUESTS || 5000),
    Number(process.env.BENCH_CONCURRENCY || 32)
  );

  const report = {
    benchmark: "fastify-inject-health",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    result
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await app.close();

  if (result.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
