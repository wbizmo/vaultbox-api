# VaultBox v2.5.0: CI Benchmark Evidence and Reproduction

**Evidence:** [VaultBox CI run #43130804149](https://github.com/wbizmo/vaultbox-api/actions/runs/43130804149), PR #88 head `0c911c9662a44dd32691fe3e64fa95558f85629b`, 2026-11-12 00:57–00:58 UTC. The downloadable `vaultbox-engineering-evidence` artifact (30-day GitHub retention) contains `benchmark.json`, `transfer-benchmark.json`, `query-benchmark.json`, the redacted test output, dependency audit and build verification. This is the *pre-documentation-update baseline*, not a final main-branch or production benchmark.

## Environment and interpretation

- GitHub Actions `ubuntu-latest`, Linux x64, Node **v24.22.2**, PostgreSQL **16.15** (postgres:16-alpine), Redis **7** (redis:7-alpine).
- Transfer: warmed real HTTP Fastify server on `127.0.0.1`, real Prisma/PostgreSQL and Redis, **local temporary storage**, synthetic files **256 KiB**, resumable chunks **64 KiB**, range downloads **4 KiB**, 1/4/16/32 concurrent clients. Each profile performs one set of operations, so these are not sustained production load tests.
- Health: `fastify.inject` (in-process), 5,000 requests, concurrency 32, 250 warmups; **no network** and no external storage or user transaction.
- Query profiler: synthetic skewed tenants of 100, 2,000 and 8,000 files; 20 timed runs after 5 warmups plus PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)`. The query profiler **writes rows**, and must never be run against production. Metric units are milliseconds.
- CPU, RSS and PostgreSQL query counts are included per stage in the JSON artifact. CI enforces a 1,024 MiB RSS budget and 20 s request timeout. Figures vary with hardware, noisy neighbours, filesystem and DB settings; no S3, public network or Neon production baselines were recorded.

## Fastify health benchmark

| Requests | Clients | Requests/second | p50 | p95 | p99 | Errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 32 | **26,711.43** | 0.941 ms | 2.332 ms | 9.319 ms | 0 |

## Real HTTP transfer benchmarks

Throughput is actual transferred bytes per stage divided by elapsed stage time. Resumable part PUT and one-shot upload report distinct stages, not end-to-end session throughput. `p95` values from 1-client samples are single-request observations.

| Concurrent clients | One-shot upload MiB/s | One-shot p95 ms | Resumable part PUT MiB/s | Part PUT p95 ms | Resumable ranged GET MiB/s | Range GET p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 5.352 | 46.570 | 11.449 | 20.619 | 0.933 | 4.156 |
| 4 | 26.815 | 37.259 | 23.271 | 40.273 | 2.204 | 6.920 |
| 16 | 33.787 | 116.528 | **32.554** | 117.440 | 4.113 | 14.811 |
| 32 | **37.704** | 205.271 | 28.338 | 272.488 | **4.892** | 24.951 |

All **8 transfer profiles** (4 concurrencies × 2 modes) had **0 failed operations**. The output also records list/token/delete stage timings; consult the raw artifact rather than extrapolating aggregate throughput.

## PostgreSQL query and count-free pagination

| Synthetic tenant files | Exact count + page p50 / p95 | Page without total p50 / p95 | Reduction in median |
| ---: | ---: | ---: | ---: |
| 100 | 0.380 / 0.485 ms | 0.196 / 0.253 ms | 48.4% |
| 2,000 | 0.637 / 0.783 ms | 0.235 / 0.290 ms | 63.1% |
| 8,000 | **1.182 / 1.253 ms** | **0.225 / 0.246 ms** | **81.0%** |

For 8,000 rows, the individual cursor `created-desc` query median was **0.241 ms** and the standalone legacy exact-total count median was **0.926 ms**. Count-free pagination is explicitly opt-in via `includeTotal=false`; default API shape is unchanged.

## Reproduce locally (disposable environment only)

Use the same workflow services and pinned runtime. Start **disposable PostgreSQL 16 and Redis 7** on loopback, and point `DATABASE_URL` only to that **test database**. The query profiler seeds and deletes thousands of rows; do not point at Neon production, staging with user content, or any shared database.

```bash
# Set up disposable PostgreSQL 16 and Redis 7 before running.
git checkout <exact-release-commit>
node --version                  # v24.22.2
npm ci --no-fund --no-audit
export NODE_ENV=test
export DATABASE_URL=postgresql://benchmark:benchmark@127.0.0.1:5432/benchmark
export REDIS_URL=redis://127.0.0.1:6379
export JWT_SECRET=ci-only-secret-that-is-long-enough-for-tests
npm run deploy:generate
npm run deploy:migrate
npm run benchmark             > benchmark.json
npm run benchmark:transfers   > transfer-benchmark.json
VAULTBOX_QUERY_PROFILE_ALLOW_WRITES=1 npm run benchmark:queries > query-benchmark.json
```

Each npm script prefixes its output with an npm banner; the JSON payload starts at the first `{`. The transfer script supports `BENCHMARK_FILE_BYTES` (default 262144), `BENCHMARK_CHUNK_BYTES` (default 65536) and `BENCHMARK_MAX_RSS_MB` (default 1024). The health script supports `BENCH_REQUESTS` (default 5000) and `BENCH_CONCURRENCY` (default 32). Query profiling supports `VAULTBOX_QUERY_PROFILE_ITERATIONS` (default 20; permitted 5–1000). The profiler refuses `NODE_ENV=production` and refuses runs without `VAULTBOX_QUERY_PROFILE_ALLOW_WRITES=1`.

**CI-exact reproduction:** Re-run the `VaultBox CI` workflow against the final main commit or inspect its fresh artifact; it additionally runs security, lint, typecheck, integration tests and 10k cleanup stress. Record commit, run ID, hardware, PostgreSQL/Redis versions and any overrides before comparing results. Do not silently compare local Fastify inject throughput to real HTTP/public Render requests.

## Not measured / not accepted

No production Render/Neon/Upstash latency or uptime benchmark, no real production S3 provider, no persistent-disk recovery proof, no long-running SLA baseline, and no cross-host durability test. Those require separately authorized production observability, a safe staging clone and storage acceptance. The S3 provider acceptance remains **UNVERIFIED by owner direction**, not passed.
