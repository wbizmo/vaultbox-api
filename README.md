# VaultBox API

VaultBox is a secure cloud-storage API built with Fastify, Prisma, Neon PostgreSQL, Upstash Redis, and Render. Version 2 focuses on transfer reliability, bounded resource use, observable performance, and security without replacing the existing infrastructure providers.

> The public Render URL tracks the deployed branch. The v2 capabilities documented here apply after this branch is merged and deployed.

## Live service

- API: `https://vaultbox-api-ucff.onrender.com`
- Swagger UI: `https://vaultbox-api-ucff.onrender.com/docs`
- Liveness: `https://vaultbox-api-ucff.onrender.com/health`
- Dependency health: `https://vaultbox-api-ucff.onrender.com/infra/health`

Render may cold-start an inactive free-tier service, so first-request latency on the public URL is not comparable to the in-process benchmark below.

## v2 engineering highlights

### Resumable, parallel downloads

VaultBox now speaks standard HTTP byte-range semantics instead of forcing every file through one uninterrupted sequential stream.

- `HEAD` exposes size, ETag, content type, and range support without transferring the file.
- `Accept-Ranges: bytes` advertises resumability.
- `Range: bytes=start-end` returns `206 Partial Content`.
- `Content-Range` identifies exactly which segment was returned.
- `If-Range` protects resumes against a file changing underneath the client.
- Strong ETags are derived from the stored SHA-256 checksum.
- Short-lived download sessions can be reused for range requests until expiry.
- Download credentials are stored hashed in PostgreSQL rather than as plaintext bearer secrets.
- Invalid or unsatisfiable ranges return `416 Range Not Satisfiable`.

The repository also includes a reference parallel downloader:

```bash
node scripts/parallel-download.js \
  "https://vaultbox-api-ucff.onrender.com/download/<token>" \
  ./large-file.bin \
  8 \
  8
```

The final two arguments are parallel requests and part size in MiB. The client writes ranges directly to their final offsets, maintains `<output>.vaultbox-resume.json`, skips completed segments after a restart, and verifies the completed file against VaultBox's SHA-256 ETag when available.

This is the protocol foundation required for download-manager-style throughput and recovery after network interruption. Actual Internet throughput remains bounded by the Render instance, storage device, route to the client, and client connection; VaultBox does not claim CDN or MEGA-scale global throughput from a single application instance.

### Streaming uploads

Uploads no longer write a file and then read the whole file back into memory to hash it. SHA-256 is calculated while bytes are streamed to storage. This removes the v1 full-file reread and avoids memory use proportional to file size.

Quota reservation is also atomic at the PostgreSQL layer, preventing concurrent uploads from independently passing the same stale quota check.

### Redis repaired and used deliberately

The Redis "offline" status was caused by two application wiring defects introduced during the TLS/client-lifecycle refactor:

1. `src/lib/redis.js` changed from exporting a Redis client directly to exporting `{ redis, connectRedis }`, while the infrastructure route still called `.ping()` on the module wrapper.
2. The server startup path never called `connectRedis()`, so the explicit Upstash client was not opened.

v2 fixes both defects while keeping Upstash. Redis is connected during startup, closed gracefully during shutdown, and its actual client state and ping latency are reported by `/infra/health`.

Redis is used for low-latency ephemeral coordination where failure can safely degrade: short-lived authorization-state caching, distributed throttling, and idempotency state. Neon PostgreSQL remains the source of truth.

## Engineering evidence

The README reports measured figures only. The benchmark is checked into `scripts/benchmark.js` and runs in CI so the numbers can be reproduced rather than hand-written.

Validated on **2026-08-29** using GitHub Actions `ubuntu-24.04`, **Node.js 24.19.0**, 5,000 Fastify-inject requests to `/health`, concurrency 32:

| Metric | Result |
| --- | ---: |
| Requests | 5,000 |
| Concurrency | 32 |
| Total benchmark duration | 283.92 ms |
| Throughput | 17,610.86 req/s |
| Minimum latency | 0.450 ms |
| p50 latency | 1.577 ms |
| p95 latency | 3.817 ms |
| p99 latency | 8.383 ms |
| Maximum latency | 12.650 ms |
| Average latency | 1.814 ms |
| Errors | 0 |
| Unit tests | 13/13 passing |
| Dependency audit | 0 known vulnerabilities in the validated lockfile |

These are **in-process control-plane measurements**. They intentionally exclude public-Internet latency, Render cold starts, Neon query latency, Upstash latency, file-system I/O, and file-transfer bandwidth. `/infra/health` separately measures database and Redis dependency latency at runtime.

Run the same benchmark locally with:

```bash
npm run benchmark
```

The parallel downloader prints its own observed `throughputMiBPerSecond`, which is the correct place to measure real transfer speed for a specific host/network path.

## Reliability and security changes

- Production startup fails closed when `DATABASE_URL` or a sufficiently strong `JWT_SECRET` is missing.
- Node.js 24 LTS replaces the EOL Node.js 20 runtime.
- CORS is allowlisted through `CORS_ORIGINS` in production.
- Protected requests verify the current database-backed account state after JWT validation, so suspended/deleted accounts cannot continue indefinitely with an old token.
- Short-lived Redis caching avoids turning that enforcement into unnecessary database load.
- Authentication endpoints normalize email identities and use stronger password validation and bcrypt cost 12.
- Redis-backed auth/download throttling falls back safely to local process throttling when Redis is unavailable.
- Response security headers and safe download filename handling are installed globally.
- Signed download credentials are redacted from application request logs.
- Request IDs and `Server-Timing` are emitted for diagnostics.
- File/folder/admin list paths use bounded pagination instead of unbounded result sets.
- Folder deletion moves contained files to the root instead of stranding/deleting them unexpectedly.
- Plan downgrades are refused when current usage exceeds the destination plan.
- Folder creation supports idempotency keys.
- Administrative storage reporting uses aggregation rather than loading every user into application memory.
- Query-path indexes cover common owner/status/time access patterns.
- Legacy v1 stored filenames remain readable through a path-constrained compatibility boundary.

## Architecture

```text
Client
  |
  v
Render / Fastify API
  |-- auth, validation, quotas, transfer sessions, HTTP range serving
  |-- request timing, health, security controls
  |
  +--> Neon PostgreSQL
  |      users, plans, file metadata, quotas, download sessions, audit logs
  |
  +--> Upstash Redis
  |      ephemeral auth cache, throttling, idempotency, operational coordination
  |
  +--> Storage adapter
         current provider: Render-local filesystem
         streaming reads/writes and range reads
```

The current provider set is intentionally preserved: **Render + Neon PostgreSQL + Upstash Redis**.

### Storage scaling boundary

The new storage adapter removes storage-specific assumptions from route code, but the deployed byte store is still node-local filesystem storage. Unless a durable Render disk is attached, local files may be ephemeral across instance replacement; even with persistent disk, node-local bytes are not horizontally shared like object storage. Parallel range support can saturate a single host more efficiently, but it cannot manufacture bandwidth beyond that host's network/disk ceiling.

A future object-storage/CDN backend can be introduced behind the adapter without redesigning the HTTP transfer surface, if the infrastructure strategy changes later.

## Core API surface

### System and infrastructure

- `GET /`
- `GET /health`
- `GET /infra/health`
- `GET /metrics` — administrator only
- `GET /docs`

### Authentication and account

- `POST /auth/register`
- `POST /auth/login`
- `GET /me`

### Plans and quota

- `GET /plans`
- `GET /quota`
- `PATCH /plans/:planId/subscribe`

### Files and folders

- `POST /files/upload`
- `GET /files`
- `DELETE /files/:id`
- `POST /folders`
- `GET /folders`
- `PATCH /folders/:id`
- `DELETE /folders/:id`

### Downloads

- `POST /files/:id/download-token`
- `GET /files/:id/download-capabilities`
- `HEAD /download/:token`
- `GET /download/:token`

`GET /download/:token` accepts standard `Range` and `If-Range` headers.

### Administration and billing

Administrative user lifecycle, storage reporting, audit-log access, and billing-failure simulation remain available through the documented routes in Swagger.

## Configuration

Copy `.env.example` and provide real secrets/URLs:

```env
PORT=4000
NODE_ENV=development

DATABASE_URL=
DIRECT_URL=

JWT_SECRET=replace_this_with_at_least_32_random_characters
JWT_EXPIRES_IN=7d

APP_URL=http://localhost:4000
CORS_ORIGINS=http://localhost:3000,http://localhost:5173

MAX_UPLOAD_BYTES=104857600
DOWNLOAD_TOKEN_EXPIRES_MINUTES=15
DOWNLOAD_MAX_RANGES=8
DOWNLOAD_SUGGESTED_PART_BYTES=8388608

REDIS_URL=
REDIS_KEY_PREFIX=vaultbox
```

Provider values remain normal connection strings supplied by Neon and Upstash; the application does not rewrite a configured Redis scheme.

## Local development

Requirements:

- Node.js 24.x
- npm 11.x
- PostgreSQL connection
- Redis connection is recommended; Redis-dependent optimizations degrade safely when unavailable

```bash
git clone https://github.com/wbizmo/vaultbox-api.git
cd vaultbox-api
npm ci
cp .env.example .env
npx prisma generate
npx prisma migrate deploy
npm run seed
npm run dev
```

## Verification

```bash
npm test
npm run benchmark
npm audit
```

CI additionally performs Prisma generation, JavaScript syntax checks, a dependency security gate, the unit suite, and the benchmark. Benchmark and audit JSON are retained as workflow artifacts.

## Deployment notes

Before deploying v2:

1. Use Node.js 24.x on Render.
2. Set `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`, and the production `CORS_ORIGINS` allowlist.
3. Run `npm ci` and `npx prisma generate`.
4. Run `npx prisma migrate deploy` for the new query indexes.
5. Deploy the application and confirm `/health` and `/infra/health`.
6. Regenerate any pre-v2 outstanding download token after rollout; v2 stores token hashes rather than v1 plaintext token values.
7. Exercise one full upload, ranged download, interrupted/resumed download, delete, quota, suspension, and reactivation flow in the deployed environment.

## Repository layout

```text
.github/workflows/      CI verification
prisma/                 schema, seed, migrations
scripts/benchmark.js    reproducible control-plane benchmark
scripts/parallel-download.js
                        resumable parallel reference downloader
src/config/             validated runtime configuration
src/lib/                storage, Redis, range, metrics, security utilities
src/middleware/         authorization boundaries
src/routes/             REST endpoints
test/                   native Node.js unit tests
docs/                   engineering and upgrade plan
```

See `docs/V2_ENGINEERING_PLAN.md` for the provider-preserving upgrade rationale and remaining architectural boundaries.

## License

MIT
