# VaultBox v2.4.0 development grouping — Performance, Security and Release Operations

**Publication status:** v2.4.0 is a planning/implementation group incorporated directly into **v2.5.0** by the consolidated PR #88, **not** an independently published GitHub release or production deployment.

## Work included in v2.5.0

- **#58:** Fastify health, warmed real HTTP transfer and real PostgreSQL/Redis benchmarks with p50/p95/p99 latency, MiB/s, CPU/RSS, error and query counts; see [exact CI results](./BENCHMARKS_v2.5.0.md).
- **#59:** Atomic, fenced, leased, bounded cleanup workers with due-indexing, retries and 10,000-session / two-worker stress cases.
- **#60:** Summary/keyset paginated upload progress up to 10,000 parts; legacy response preserved by default.
- **#61:** Independent-process races, SIGKILL lifecycle tests, BOLA/IDOR, multipart/range fuzz corpus, static secrets and dependency gates.
- **#62:** Pinned Node/Prisma, build-time generation, approved migration stage and manual exact-main-SHA protected CI release workflow.
- **#63:** 100/2,000/8,000 file query profiles, deterministic keyset listing, and opt-in `includeTotal=false` for faster pages without exact counts.

The v2.5.0 cumulative release also includes the folder/quota changes of #64–#65. No v2.4 tag was created; do not claim a separate release. Production and provider-specific performance/storage acceptance remains outside the CI measurements.
