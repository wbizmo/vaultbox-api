# VaultBox API

VaultBox is a secure cloud-storage API built with Fastify, Prisma, Neon PostgreSQL, Upstash Redis, and Render. **v2.1.0** adds durable resumable chunked uploads and completes an efficiency pass across transfer I/O, quota accounting, database access, Redis coordination, pagination, search, and deployment safety.

- Current release: **v2.1.0 — Resumable Upload & Efficiency Release**
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
- Release notes: [`docs/RELEASE_NOTES_v2.1.0.md`](./docs/RELEASE_NOTES_v2.1.0.md)
- Upload protocol: [`docs/UPLOADS.md`](./docs/UPLOADS.md)
- Engineering record: [`docs/V2_ENGINEERING_PLAN.md`](./docs/V2_ENGINEERING_PLAN.md)

## Live service

- API: `https://vaultbox-api-ucff.onrender.com`
- Swagger UI: `https://vaultbox-api-ucff.onrender.com/docs`
- Liveness: `https://vaultbox-api-ucff.onrender.com/health`
- Dependency health: `https://vaultbox-api-ucff.onrender.com/infra/health`

Render may cold-start an inactive free-tier service, so first-request latency on the public URL is not comparable to the in-process benchmark.

## Transfer engine

### Resumable, parallel downloads

VaultBox supports standard HTTP byte-range semantics:

- `HEAD` for size/type/ETag discovery without transferring bytes
- `Accept-Ranges: bytes`
- `Range: bytes=start-end`
- `206 Partial Content`
- `Content-Range`
- strong SHA-256-backed ETags
- `If-Range`
- `416 Range Not Satisfiable`
- reusable short-lived download sessions with hashed bearer credentials

The reference downloader can persist completed ranges, resume after interruption, write directly to final offsets, and verify the completed SHA-256:

```bash
node scripts/parallel-download.js \
  "https://vaultbox-api-ucff.onrender.com/download/<token>" \
  ./large-file.bin \
  8 \
  8
```

The final two arguments are parallel requests and part size in MiB.

### Resumable chunked uploads

Large or interruption-prone uploads use a durable PostgreSQL-backed session protocol:

1. `POST /upload-sessions` — create a session and atomically reserve the expected bytes.
2. `PUT /upload-sessions/:id/parts/:partNumber` — stream one bounded part with exact `Content-Range` geometry and optional `x-chunk-sha256`.
3. `GET /upload-sessions/:id` — inspect uploaded and missing parts.
4. `POST /upload-sessions/:id/complete` — claim completion, stream deterministic assembly, verify final size/checksum, create one file, and convert reserved quota exactly once.
5. `DELETE /upload-sessions/:id` — abort, remove temporary bytes, and release the reservation.

The default recommendation is **8 MiB chunks** and **4 parallel part uploads**. The server never concatenates the complete file in Node memory.

Correctness is enforced at multiple layers:

- every session lookup is ownership-scoped;
- part number is unique per session;
- exact ranges prevent overlap/duplicate bytes;
- matching retries are idempotent;
- conflicting retries are rejected;
- concurrent completion can create at most one final file;
- expired/aborted sessions release quota reservations;
- stale session cleanup tolerates process interruption.

### Efficient one-shot uploads

`POST /files/upload` remains available for simple clients and still hashes SHA-256 inline while streaming.

Clients that know the exact file payload size should send:

```http
x-upload-size: 8388608
```

This is the **file byte count**, not multipart `Content-Length`. VaultBox reserves the declared bytes before reading the multipart file or opening storage. A known over-quota request can therefore return `413` without receiving, hashing, and writing the full file.

The server-measured stream length remains authoritative:

- shorter than declared: `422` and reservation release;
- larger than declared: bounded/truncated and `413`;
- parser/pipeline/database failure: temporary bytes removed and reservation released;
- success: reservation converted to `storageUsed` atomically with `File` creation.

Clients that omit `x-upload-size` keep the compatible final quota-check flow.

## Efficiency work in v2.1.0

### Database

- Upload admission checks the plan that is current when the SQL statement executes.
- `storageUsed + reservedUploadBytes` is kept within the current plan limit for admitted upload/plan transitions.
- File ACTIVE -> DELETED and quota decrement happen in one ownership-scoped SQL transition.
- Successful upload responses reuse `UPDATE ... RETURNING` instead of re-reading the user solely for quota display.
- Admin storage reporting uses one aggregate query.
- Cursor pagination avoids exact counts and pathological large offsets for scalable collection traversal.
- `pg_trgm` GIN indexes make substring file/user search indexable without changing API semantics.
- Composite indexes align with cursor and supported file sort paths.

### Redis and process memory

- Distributed throttle decisions use one Redis Lua `EVAL` round trip.
- Process-local Redis fallbacks are bounded, TTL-aware stores rather than unbounded Maps.
- Dead file-cache invalidations with no corresponding cache read path were removed.
- Redis remains ephemeral coordination; PostgreSQL remains the source of truth.

### Filesystem and transfer paths

- Storage readiness runs once during Fastify startup instead of per upload.
- Range downloads avoid `access()` followed by open; the read handle is opened directly and missing bytes are mapped safely.
- Already-started download sessions skip redundant `usedAt IS NULL` writes.
- One-shot and chunked uploads use streaming SHA-256 and bounded memory.

## Architecture

```text
Client
  |
  v
Render / Fastify API
  |-- auth + current-account enforcement
  |-- atomic quota transitions
  |-- one-shot + resumable upload protocols
  |-- resumable HTTP range downloads
  |-- request timing, health and metrics
  |
  +--> Neon PostgreSQL
  |      users, plans, committed/reserved quota,
  |      files/folders, upload sessions/parts,
  |      download sessions, audit logs
  |
  +--> Upstash Redis
  |      short-lived auth cache, throttling, idempotency
  |
  +--> Storage adapter
         current provider: Render-local filesystem
         final files + bounded temporary upload parts
```

The provider set is intentionally preserved: **Render + Neon PostgreSQL + Upstash Redis**.

### Storage boundary

The storage adapter isolates byte-storage assumptions from route/domain logic, but the deployed provider remains node-local Render storage. Unless a durable Render disk is attached, local bytes may be ephemeral across instance replacement; even with persistent disk, node-local bytes are not horizontally shared like object storage.

The upload-session/part model maps naturally to future multipart object-storage APIs, so moving bytes to object storage/CDN does not require redesigning the public transfer protocol.

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

### Files and uploads

- `POST /files/upload`
- `GET /files`
- `DELETE /files/:id`
- `POST /upload-sessions`
- `GET /upload-sessions/:id`
- `PUT /upload-sessions/:id/parts/:partNumber`
- `POST /upload-sessions/:id/complete`
- `DELETE /upload-sessions/:id`

### Folders

- `POST /folders`
- `GET /folders`
- `PATCH /folders/:id`
- `DELETE /folders/:id`

### Downloads

- `POST /files/:id/download-token`
- `GET /files/:id/download-capabilities`
- `HEAD /download/:token`
- `GET /download/:token`

### Administration and billing

Administrative user lifecycle, storage reporting, audit-log access, and billing-failure simulation are documented in Swagger.

## Configuration

Copy `.env.example` and provide real values:

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

`MAX_UPLOAD_BYTES` bounds both one-shot and resumable file size. `UPLOAD_CHUNK_BYTES` is bounded by the total upload limit and `UPLOAD_MAX_PARTS` prevents pathological metadata growth.

## Local development

Requirements:

- Node.js 24.x
- npm 11.x
- PostgreSQL
- Redis recommended; Redis optimizations degrade safely when unavailable

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

CI provisions PostgreSQL and Redis and requires dependency audit, Prisma generation, migration deployment, syntax checks, ESLint, unit/integration tests, concurrency coverage, and benchmark evidence before merge.

## Production deployment

Render tracks `main` with auto-deploy enabled. The production start contract is deliberately migration-aware:

```text
npm start
  -> prisma migrate deploy
  -> node src/server.js
```

Fastify therefore does not bind its public port until committed Prisma migrations have been applied to Neon.

After each production deploy verify:

1. Render deploy status is `live` for the intended commit.
2. `/health` succeeds.
3. `/infra/health` reports PostgreSQL and Redis operational state.
4. Swagger/OpenAPI reports the release version and expected routes.
5. The production database migration table includes the latest committed migration.

## Release history

See [`CHANGELOG.md`](./CHANGELOG.md) and the versioned release notes in [`docs/`](./docs/).

## License

MIT
