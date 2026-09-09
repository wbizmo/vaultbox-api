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

VaultBox speaks standard HTTP byte-range semantics instead of forcing every file through one uninterrupted sequential stream.

- `HEAD` exposes size, ETag, content type, and range support without transferring the file.
- `Accept-Ranges: bytes` advertises resumability.
- `Range: bytes=start-end` returns `206 Partial Content`.
- `Content-Range` identifies exactly which segment was returned.
- `If-Range` protects resumes against a file changing underneath the client.
- Strong ETags are derived from the stored SHA-256 checksum.
- Short-lived download sessions can be reused for range requests until expiry.
- Download credentials are stored hashed in PostgreSQL rather than as plaintext bearer secrets.
- Invalid or unsatisfiable ranges return `416 Range Not Satisfiable`.

The repository includes a reference parallel downloader:

```bash
node scripts/parallel-download.js \
  "https://vaultbox-api-ucff.onrender.com/download/<token>" \
  ./large-file.bin \
  8 \
  8
```

The final two arguments are parallel requests and part size in MiB. The client writes ranges directly to their final offsets, maintains `<output>.vaultbox-resume.json`, skips completed segments after a restart, and verifies the completed file against VaultBox's SHA-256 ETag when available.

### Streaming and resumable uploads

The original `POST /files/upload` path remains available for simple one-shot uploads. It streams bytes directly to storage and calculates SHA-256 inline, so it does not buffer the whole file or reread it just to hash it.

Large or unreliable transfers can use the resumable upload protocol:

1. `POST /upload-sessions` with `originalName`, `mimeType`, `expectedSize`, and optional whole-file SHA-256 `checksum`.
2. VaultBox reserves the expected bytes atomically against the user's current plan and returns a session ID, fixed `chunkSize`, `partCount`, expiry, and suggested parallelism.
3. `PUT /upload-sessions/:id/parts/:partNumber` sends one multipart file part with an exact `Content-Range: bytes start-end/total`. `x-chunk-sha256` is optional on the first upload and can be used for integrity verification and idempotent retries.
4. `GET /upload-sessions/:id` reports uploaded and missing part numbers, state, and expiry so an interrupted client can resume only what is missing.
5. `POST /upload-sessions/:id/complete` validates the complete part set, streams parts to final storage in deterministic order, verifies final size and optional whole-file checksum, then atomically converts reserved bytes into `storageUsed` and creates exactly one `File` record.
6. `DELETE /upload-sessions/:id` aborts an unfinished session, removes temporary parts, and releases its quota reservation.

The default recommended chunk size is **8 MiB** with **4 parallel part uploads**. Both are configurable. Parts are streamed with bounded memory; the server never concatenates the complete file in RAM. Part-number uniqueness and exact range geometry prevent overlaps or duplicated bytes. Concurrent completion is claimed atomically, so at most one file is created and quota is charged once.

Upload-session and part state lives in PostgreSQL rather than Redis. This keeps resumability durable across application restarts and makes user ownership/BOLA checks part of every session operation. Temporary part bytes stay behind the storage adapter, so a future object-storage multipart implementation can replace local temporary files without changing the public protocol.

Expired sessions release reserved quota and their temporary chunks are cleaned by lifecycle cleanup. Stale sessions left by a crash are also reconciled by periodic cleanup.

### Redis used deliberately

Redis is connected during startup, closed gracefully during shutdown, and its actual client state and ping latency are reported by `/infra/health`.

Redis is used for low-latency ephemeral coordination where failure can safely degrade: short-lived authorization-state caching, distributed throttling, and idempotency state. Neon PostgreSQL remains the source of truth for users, quotas, files, resumable-upload sessions, and audit state.

## Engineering evidence

The benchmark is checked into `scripts/benchmark.js` and runs in CI. Run it with:

```bash
npm run benchmark
```

These are in-process control-plane measurements. Public transfer speed is still bounded by the Render instance, storage device, route to the client, and client connection.

## Reliability and security changes

- Production startup fails closed when `DATABASE_URL` or a sufficiently strong `JWT_SECRET` is missing.
- Node.js 24 LTS is the supported runtime.
- CORS is allowlisted through `CORS_ORIGINS` in production.
- Protected requests verify current account state after JWT validation, so suspended/deleted accounts cannot continue indefinitely with an old token.
- Redis-backed auth/download/upload throttling falls back safely to bounded local process throttling when Redis is unavailable.
- Response security headers and safe download filename handling are installed globally.
- Signed download credentials are redacted from application request logs.
- Request IDs and `Server-Timing` are emitted for diagnostics.
- File/folder/admin list paths support bounded pagination and scalable cursor pagination.
- Substring search uses PostgreSQL trigram indexes while common sort paths have matching composite indexes.
- Folder deletion moves contained files to the root instead of stranding/deleting them unexpectedly.
- Plan downgrades account for both committed storage and active upload reservations.
- Resumable session creation reserves quota atomically, preventing concurrent sessions from oversubscribing a plan.
- Chunk ranges are deterministic and non-overlapping; part retries are idempotent when the checksum matches.
- Completion verifies byte count and optional whole-file SHA-256 before atomically creating file metadata and charging storage.
- Abort/expiry releases reservations and removes temporary upload chunks.
- Legacy v1 stored filenames remain readable through a path-constrained compatibility boundary.

## Architecture

```text
Client
  |
  v
Render / Fastify API
  |-- auth, validation, quotas, resumable upload/download sessions
  |-- streaming assembly, HTTP range serving, request timing, health
  |
  +--> Neon PostgreSQL
  |      users, plans, file metadata, committed + reserved quota,
  |      upload sessions/parts, download sessions, audit logs
  |
  +--> Upstash Redis
  |      ephemeral auth cache, throttling, idempotency
  |
  +--> Storage adapter
         current provider: Render-local filesystem
         final files + bounded temporary upload parts
```

The current provider set is intentionally preserved: **Render + Neon PostgreSQL + Upstash Redis**.

### Storage scaling boundary

The storage adapter removes storage-specific assumptions from route code, but the deployed byte store is still node-local filesystem storage. Unless a durable Render disk is attached, local files may be ephemeral across instance replacement; even with persistent disk, node-local bytes are not horizontally shared like object storage.

A future object-storage/CDN backend can be introduced behind the adapter. The resumable API already models upload sessions and numbered parts, which maps naturally to object-storage multipart APIs.

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

- `POST /files/upload` — compatible one-shot streaming upload
- `GET /files`
- `DELETE /files/:id`
- `POST /upload-sessions` — create resumable upload + reserve quota
- `GET /upload-sessions/:id` — inspect progress/missing parts
- `PUT /upload-sessions/:id/parts/:partNumber` — stream one exact ranged part
- `POST /upload-sessions/:id/complete` — assemble, verify and commit
- `DELETE /upload-sessions/:id` — abort and release reservation
- `POST /folders`
- `GET /folders`
- `PATCH /folders/:id`
- `DELETE /folders/:id`

For upload parts, the server returns the calculated SHA-256 checksum. A retry should send that digest as `x-chunk-sha256`; a different checksum for an already-filled part number is rejected with `409` rather than silently replacing bytes.

### Downloads

- `POST /files/:id/download-token`
- `GET /files/:id/download-capabilities`
- `HEAD /download/:token`
- `GET /download/:token`

`GET /download/:token` accepts standard `Range` and `If-Range` headers.

### Administration and billing

Administrative user lifecycle, storage reporting, audit-log access, and billing-failure simulation remain available through Swagger.

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
UPLOAD_CHUNK_BYTES=8388608
UPLOAD_SESSION_EXPIRES_MINUTES=60
UPLOAD_MAX_PARTS=10000
UPLOAD_SUGGESTED_PARALLEL_PARTS=4
DOWNLOAD_TOKEN_EXPIRES_MINUTES=15
DOWNLOAD_MAX_RANGES=8
DOWNLOAD_SUGGESTED_PART_BYTES=8388608

REDIS_URL=
REDIS_KEY_PREFIX=vaultbox
```

`MAX_UPLOAD_BYTES` is the maximum total file size for both one-shot and resumable uploads. `UPLOAD_CHUNK_BYTES` is bounded by the total upload limit. `UPLOAD_MAX_PARTS` prevents pathological session metadata growth.

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
npm run lint
npm test
npm run benchmark
npm audit --audit-level=high
```

CI provisions PostgreSQL and Redis and performs dependency audit, Prisma generation and migration deployment, JavaScript syntax checks, ESLint, unit/integration tests, and the benchmark. Benchmark and audit JSON are retained as workflow artifacts.

## Deployment notes

Before deploying v2:

1. Use Node.js 24.x on Render.
2. Set `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`, and production `CORS_ORIGINS`.
3. Configure upload chunk/session limits as needed; the defaults are 8 MiB chunks, 60-minute sessions, and four suggested parallel parts.
4. Run `npm ci`, `npx prisma generate`, and `npx prisma migrate deploy`.
5. Deploy and confirm `/health` and `/infra/health`.
6. Exercise a one-shot upload, interrupted/resumed chunked upload, idempotent part retry, completion, abort, ranged download, quota, suspension, and reactivation flow.

## Repository layout

```text
.github/workflows/      CI verification
prisma/                 schema, seed, migrations
scripts/benchmark.js    reproducible control-plane benchmark
scripts/parallel-download.js
                        resumable parallel reference downloader
src/config/             validated runtime configuration
src/lib/                storage, quota, upload/download session, Redis utilities
src/middleware/         authorization boundaries
src/routes/             REST endpoints
test/                   native Node.js unit and integration tests
docs/                   engineering and upgrade plan
```

See `docs/V2_ENGINEERING_PLAN.md` for the provider-preserving upgrade rationale and remaining architectural boundaries.

## License

MIT
