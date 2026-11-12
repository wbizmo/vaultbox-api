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

## Capability matrix across the entire release history

The v2.5.0 test suite now runs `npm run benchmark:capabilities` (see CI `capability-benchmark.json` artifact), with **23 API scenarios × 4 concurrency levels (1/4/16/32) × 40 operations each**, measuring **3,680 requests** in total, plus scenario preflights. These cover v1 foundation, v2.1 pagination/upload progress, v2.4 count-free/summary APIs, and v2.5 folder/quota/move additions. Each scenario reports requests/sec, p50/p95/p99/min/max, CPU time, peak RSS and error/status counts. The benchmark uses **Fastify.inject**, a real disposable PostgreSQL database and Redis configured in CI; it does not simulate the public internet. It refuses `NODE_ENV=production` and requires explicit `VAULTBOX_BENCHMARK_ALLOW_WRITES=1`.

**Critical interpretation:** the `introducedIn` column identifies the first release that delivered a feature. All numeric scores generated by this matrix measure the **current v2.5.0 implementation**, *not historical versions' binaries*. There are no legitimately comparable historical v1.0, v2.0, v2.1, or v2.2 CI measurements until each old tag is separately checked out and profiled against its own clean database and runtime. Never represent a v2.5.0 endpoint score as the speed of a historical version.

| Release origin | Measured API families in the current v2.5.0 implementation |
| --- | --- |
| v1.0.0 | public metadata, liveness, plans, account, counted files/folders, administrative users/storage/audit, folder creation |
| v2.0.0 | HTTP range/parallel downloads and token flow (covered by the existing real HTTP **transfer suite**); streaming checksums and transfer integrity are checked by integration tests |
| v2.1.0–2.1.1 | searchable/cursor file pages, legacy resumable upload progress, real transfer throughput and Node runtime security baseline |
| v2.2.0 | authorization/fault/rate-limit/audit integrity (measured indirectly by security/negative test gates; deliberate auth throttling should not be misrepresented as maximum throughput) |
| v2.3.0 grouping | temporary budget/reconciliation, stream cleanup, file deletion outbox (10k cleanup stress and failure-injection gates; no independent published v2.3 tag) |
| v2.4.0 grouping | count-free files/folders/admin, summarized/page upload progress, PostgreSQL 100/2000/8000 query profile and 10k worker stress (no independent v2.4 tag) |
| v2.5.0 | reservation-aware quota reads, root/folder file filtering, file moves |

**Reproduction on isolated test dependencies** (in addition to the preceding setup):

```bash
VAULTBOX_BENCHMARK_ALLOW_WRITES=1 npm run benchmark:capabilities > capability-benchmark.json
# Optional more stable sample sizes; range 32..500 requests per scenario
VAULTBOX_BENCHMARK_ALLOW_WRITES=1 BENCH_API_REQUESTS=100 npm run benchmark:capabilities > capability-100.json
```

For historical apples-to-apples performance comparison, use a **separate disposable PostgreSQL database and isolated checkout per tag** (v1.0.0, v2.0.0, v2.1.0, v2.1.1, v2.2.0 and v2.5.0), apply that tag's own migrations, pin its supported Node/npm and run only benchmark scenarios that that version actually supports. Keep non-reusable storage fixtures and test identities isolated; older releases do not contain this new harness and require a compatibility-specific runner. **No historical cross-tag speedup percentage is asserted here.**

## Actual historical tag-to-tag comparison

A separate **isolated GitHub Actions matrix** now checks out each *published* release tag `v1.0.0`, `v2.0.0`, `v2.1.0`, `v2.1.1`, `v2.2.0`, plus the current v2.5.0 release candidate in its own runner, pins the **Node version from that tag's own `.node-version` file**, installs that tag's dependencies and migrations against **fresh per-job PostgreSQL 16 / Redis 7**, and runs the **same external `scripts/benchmark-history.js` harness**. It measures `GET /health`, `GET /`, `GET /plans` at concurrency 1/4/16/32 with **100 requests per scenario**, each in a freshly initialized application instance to respect v1's 120-request/minute limit without disabling rate-limiting, recording throughput, p50/p95/p99, CPU/RSS and all errors. The evidence is retained as six separate version-labelled Actions artifacts.

This avoids the invalid shortcut of using current code and calling it a v1/v2 baseline. Still, **the historical benchmarks are comparisons of common public endpoints only**, not full feature-comparability claims: API versions, dependencies, Node runtimes and scheduling noise vary. Treat results as a historical trend, not a controlled hardware-to-hardware regression proof. Old releases with dependency or migration incompatibilities must be reported as **failed/not measured**, not silently skipped. The current v2.5.0 API capability matrix above covers feature-specific performance beyond these shared historical routes.

Workflow: [Historical Benchmarks](../.github/workflows/historical-benchmarks.yml). The automatic one-time candidate branch run triggers when the workflow file is added; future reruns can use the manual workflow dispatch after merge. Once CI finishes, insert the actual verified per-version numbers and run links here. **Do not fabricate scores while a job is pending**.

## Not measured / not accepted

No production Render/Neon/Upstash latency or uptime benchmark, no real production S3 provider, no persistent-disk recovery proof, no long-running SLA baseline, and no cross-host durability test. Those require separately authorized production observability, a safe staging clone and storage acceptance. The S3 provider acceptance remains **UNVERIFIED by owner direction**, not passed.
