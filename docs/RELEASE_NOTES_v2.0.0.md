# VaultBox API v2.0.0 — Resumable Transfer Engine

VaultBox v2 is a provider-preserving infrastructure and transfer-engine upgrade built on the existing Render, Neon PostgreSQL, and Upstash Redis stack.

## Highlights

### Resumable and parallel downloads

VaultBox now supports standard HTTP byte-range transfer semantics for large-file reliability and higher practical throughput:

- `HEAD` metadata requests without transferring file bodies
- `Accept-Ranges: bytes`
- `206 Partial Content`
- `Content-Range`
- `Range` and `If-Range`
- SHA-256-backed strong ETags
- `416 Range Not Satisfiable` handling
- reusable short-lived download sessions
- hashed download credentials instead of plaintext token storage
- a reference multi-part downloader that writes ranges directly to final offsets, persists completed-part state, resumes after interruption, and verifies the final SHA-256 checksum

This makes network interruption recoverable without restarting a large download from byte zero and allows clients to fetch independent segments concurrently.

### Streaming upload pipeline

- SHA-256 is computed while the upload stream is written instead of rereading the complete file afterwards.
- Quota reservation is atomic in PostgreSQL to prevent concurrent uploads from racing past account limits.
- New objects use opaque storage keys rather than embedding user-controlled filenames in storage paths.
- Legacy v1 file paths remain readable through a constrained compatibility boundary.

### Redis reliability fix

The Redis `offline` state was traced to two application regressions rather than a provider replacement requirement:

1. the Redis module changed to export `{ redis, connectRedis }`, while the infrastructure health route continued calling `.ping()` on the wrapper object;
2. application startup never called `connectRedis()` after the explicit client lifecycle was introduced.

v2 fixes both issues while keeping Upstash. Redis now connects explicitly at startup, closes gracefully on shutdown, reports actual client/ping state through infrastructure health, and safely degrades for ephemeral coordination when unavailable.

### Security and correctness

- current account state is revalidated after JWT verification, preventing suspended or deleted accounts from relying indefinitely on old tokens
- short-lived Redis authorization caching reduces database overhead while preserving account-state enforcement
- stronger password validation and bcrypt cost
- normalized email identities
- production CORS allowlisting
- fail-closed production configuration for critical secrets and database connectivity
- credential-aware request-log redaction
- response security headers
- safe attachment filename handling
- Redis-backed throttling with process-local fallback
- idempotency primitives
- safe plan-downgrade checks
- safer folder-deletion semantics that preserve contained files
- bounded pagination/search/sorting for collection endpoints
- database indexes for common access paths
- aggregation-based administrative storage reporting

### Runtime and dependency hardening

- Node.js 24 LTS runtime
- GitHub Actions upgraded to Node-24-native action releases
- deterministic `npm ci`
- CI fails on high-severity dependency advisories
- Dependabot enabled for npm and GitHub Actions maintenance
- validated dependency graph: **0 known vulnerabilities** at release time

## Engineering evidence

Final branch verification ran on GitHub Actions Ubuntu 24.04 with Node.js 24.19.0.

| Measurement | Result |
| --- | ---: |
| Requests | 5,000 |
| Concurrency | 32 |
| Throughput | 17,058.63 req/s |
| p50 latency | 1.634 ms |
| p95 latency | 3.809 ms |
| p99 latency | 8.361 ms |
| Average latency | 1.873 ms |
| Maximum latency | 12.650 ms |
| Benchmark errors | 0 |
| Unit tests | 13/13 passing |
| Dependency vulnerabilities | 0 |

The benchmark uses Fastify in-process injection against `/health`; these figures represent application control-plane overhead and deliberately exclude public Internet latency, Render cold starts, Neon/Upstash network latency, filesystem throughput, and actual file-transfer bandwidth.

Real transfer throughput can be measured with `scripts/parallel-download.js`, which reports observed MiB/s for the specific host/client network path.

## Observability

- request IDs
- `Server-Timing` response data
- process/request metrics endpoint
- database and Redis dependency latency in infrastructure health
- CI-retained benchmark and dependency-audit artifacts

## Upgrade notes

1. Deploy with Node.js 24.x.
2. Apply the included Prisma migration with `npx prisma migrate deploy`.
3. Confirm production `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`, and `CORS_ORIGINS` values.
4. Regenerate any outstanding pre-v2 download token because v2 stores download credentials as hashes.
5. After deployment, validate `/health` and `/infra/health`.
6. Exercise upload, ranged download, interrupted/resumed download, deletion, quota enforcement, suspension, and reactivation flows.

## Provider compatibility

No infrastructure provider was replaced in this release. VaultBox v2 continues to use:

- Render for the application runtime and current local storage adapter
- Neon PostgreSQL as the persistent source of truth
- Upstash Redis for ephemeral coordination

The storage adapter introduced in v2 creates a clean future boundary for durable object storage/CDN integration without changing the public download protocol.

## Compatibility note

Render-local storage remains the physical throughput and durability boundary of the current deployment. Parallel HTTP ranges improve transfer utilization and resumability, but they do not remove the bandwidth, disk, or persistence limitations of a single Render-hosted storage node.
