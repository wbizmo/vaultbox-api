# VaultBox API

VaultBox is a secure cloud-storage API built with Fastify, Prisma, PostgreSQL, Redis, and a storage-adapter boundary. The **v2.5.0 source release candidate** consolidates the v2.3 reliability, v2.4 performance/security and v2.5 API improvements while retaining the v1–v2.2 features.

- Source version: **v2.5.0**. Published releases and tags: [GitHub Releases](https://github.com/wbizmo/vaultbox-api/releases). Verify production's deployed commit independently; the package version does not prove deployment.
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
- Versioned release notes: [v1.0.0](./docs/RELEASE_NOTES_v1.0.0.md) · [v2.0.0](./docs/RELEASE_NOTES_v2.0.0.md) · [v2.1.0](./docs/RELEASE_NOTES_v2.1.0.md) · [v2.1.1](./docs/RELEASE_NOTES_v2.1.1.md) · [v2.2.0](./docs/RELEASE_NOTES_v2.2.0.md) · [v2.3.0 grouping](./docs/RELEASE_NOTES_v2.3.0.md) · [v2.4.0 grouping](./docs/RELEASE_NOTES_v2.4.0.md) · [v2.5.0](./docs/RELEASE_NOTES_v2.5.0.md). **v2.3 and v2.4 were development groupings, not separately published releases.**
- Upload protocol: [`docs/UPLOADS.md`](./docs/UPLOADS.md)
- Engineering record: [`docs/V2_ENGINEERING_PLAN.md`](./docs/V2_ENGINEERING_PLAN.md)

## Live service

- API: `https://vaultbox-api-ucff.onrender.com`
- Swagger UI: `https://vaultbox-api-ucff.onrender.com/docs`
- Liveness: `https://vaultbox-api-ucff.onrender.com/health`
- Dependency health: `https://vaultbox-api-ucff.onrender.com/infra/health`

Render may cold-start an inactive free-tier service, so first-request latency on the public URL is not comparable to the in-process benchmark.

## What VaultBox includes in v2.5.0

These capabilities are cumulative. v2.5.0 **does not remove** the original account, storage, administration or download API.

| Introduced | Capabilities retained in v2.5.0 |
| --- | --- |
| **v1.0.0 foundation** | Registration, login, JWT and role permissions; plans, subscriptions and quota; file upload/list/delete/checksums; folder CRUD; expiring download tokens; administrative users, suspension, audit logs, payment-failure simulation; health, metrics, Swagger/OpenAPI and Redis-based throttling. |
| **v2.0.0** | Streaming checksums and quota-safe writes, HTTP HEAD/Range, 206/416, strong ETags, short-lived resumable download sessions, parallel-download client, robust Redis startup/health. |
| **v2.1.0–v2.1.1** | Durable resumable chunked uploads with retries and part checksums; database indexing, cursor pagination, efficient quota admission and reduced Redis round trips; Node 24 security update. |
| **v2.2.0** | Cross-tenant authorization tests; server-side paid-plan entitlements; immediate account/session revocation; upload leases, idempotency, hardened rate limits, audits and concurrency enforcement. |
| **v2.3 functionality (included in 2.5)** | Durable file-deletion outbox, crash-safe temporary-byte controls and orphan reconciliation, stream abort/cleanup, expired transfer pruning, optional S3-compatible adapter and dry-run-only checksum migration tools. |
| **v2.4 functionality (included in 2.5)** | Transfer/query performance profiles, 10k cleanup and fenced multireplica worker leases, compact upload-progress views, BOLA/fault/process test gates, optional count-free listing, exact-SHA/manual release gate and build-time Prisma generation. |
| **v2.5.0 API** | Folder-aware upload and move APIs, root/folder file filtering, reservation-aware quota figures, stable tie-breaker for file pagination, clearer temporary-storage exhaustion responses (HTTP 507). |

### New API options and backwards compatibility

- **Folder-aware files:** `POST /files/upload` accepts optional `x-folder-id`; `POST /upload-sessions` accepts optional `folderId`. `PATCH /files/:id` with `{"folderId":"owned-folder-id"}` moves a file; `{"folderId":null}` moves it to root. `GET /files?folderId=<id>` selects a folder and `folderId=root` selects root. Folder deletion detaches contained files and pending uploads transactionally.
- **Scalable progress:** `GET /upload-sessions/:id` still defaults to its legacy response; `view=summary` and `view=page&limit=100&afterPart=-1` are optional for up to 10,000 parts.
- **Optional count-free paging:** `GET /files`, `GET /folders` and supported admin listings keep exact counts by default; clients may request `includeTotal=false`.
- **Accurate remaining quota:** `GET /quota` retains legacy fields and adds reserved, committed, total-allocated and currently available bytes as BigInt-safe decimal strings.
- **Operational changes:** overloaded temporary storage may return 507. v2.5.0 requires a build-generated Prisma client and a separate migration stage before startup; `npm start` no longer migrates.

**Storage durability exception:** S3 code exists but **no real S3 provider is configured or verified**. Local single-instance storage must be backed by an actually persistent, backed-up volume; ephemeral Render filesystem is not durable user storage. S3/IAM/migration and multi-host guarantees are **UNVERIFIED**, not release acceptance. See [deployment guidance](./docs/DEPLOYMENT.md).

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
3. `GET /upload-sessions/:id` — inspect uploaded and missing parts; optional `view=summary` or `view=page&limit=100&afterPart=-1` bounds responses for up to 10,000 parts.
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
  |      download sessions, audit logs,
  |      plan entitlements, upload reservations,
  |      idempotency keys
  |
  +--> Upstash Redis
  |      throttling (authentication reads PostgreSQL, no cache)
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
- `GET /quota` — committed `storageUsed`/`usagePercent` remain backward compatible; `reservedUploadBytes`, `committedStorageUsed`, `totalAllocatedBytes`, and `allocatedUsagePercent` distinguish pending uploads. `availableBytes = max(storageLimit - storageUsed - reservedUploadBytes, 0)` is remaining immediately admissible capacity. Byte counts are decimal strings for BigInt precision.
- `PATCH /plans/:planId/subscribe` — free plans are self-service; **paid plans (`priceMonthly > 0`) require a server-side entitlement** (see [Plan entitlements](./docs/DEPLOYMENT.md#plan-entitlements-and-billing-webhook)). Without one the route returns `403`.
- `POST /billing/webhook` — HMAC-signed, idempotent `entitlement.granted` / `entitlement.revoked` events (no bearer token).

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

- `POST /folders` (supports an `Idempotency-Key` header for retry-safe creation; scoped per user, kept 24 h)
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

## Verification for v2.5.0 review

```bash
npm ci
npm run deploy:generate
npx prisma validate
npm run typecheck
npm run build
npm run lint
npm run security:scan
npm test
npm run benchmark
npm run benchmark:transfers
npm run benchmark:queries
VAULTBOX_BENCHMARK_ALLOW_WRITES=1 npm run benchmark:capabilities  # disposable DB only
npm audit --audit-level=moderate
```

The Node.js backend requires no JavaScript transpilation. The **real build** generates the Prisma client, performs strict TypeScript checking of the generated Prisma upload/quota/cleanup type contracts and checked JavaScript security and exact-SHA release-gate code, then validates that the runtime and all route modules load correctly. **The typecheck does not yet cover every JavaScript source file**; syntax validation, ESLint, security analysis and integration tests cover the remaining untyped JavaScript. Build and typecheck are not no-op commands. CI also checks PostgreSQL 16 migrations, Redis 7 coordination, distributed fault-injection, the 10,000-session cleanup backlog, real HTTP transfer tests, security-extended CodeQL and benchmark evidence. Superseded PR SHA runs are cancelled to reduce wasted runner minutes.

The main-branch workflow must pass again on the **exact final main SHA** after merge. PR validation alone cannot substitute for that release gate.

## Measured engineering benchmarks (v2.5.0)

On [GitHub CI run #43130804149](https://github.com/wbizmo/vaultbox-api/actions/runs/43130804149), commit `0c911c9`, with Node 24.22.2, PostgreSQL 16.15, Redis 7 and **local temporary storage**:

| Measurement | CI result |
| --- | ---: |
| In-process Fastify `/health`, 5,000 requests / concurrency 32 | **26,711.43 req/s**, p50 0.941 ms, p95 2.332 ms, p99 9.319 ms, 0 errors |
| One-shot uploads, 256 KiB each, concurrency 32 | **37.704 MiB/s**, p95 205.271 ms |
| Resumable part PUTs, 64 KiB parts, concurrency 16 | **32.554 MiB/s**, p95 117.440 ms |
| Ranged downloads, 4 KiB each, concurrency 32 | **4.892 MiB/s** (32-client resumable profile), p95 24.951 ms |
| PostgreSQL 8,000-file page, with exact total | **1.182 ms p50** |
| PostgreSQL 8,000-file page, `includeTotal=false` | **0.225 ms p50** |

These are **synthetic CI fixture scores**, not live Render throughput or evidence of production durability. All 8 HTTP transfer profiles reported 0 failures. For the full 1/4/16/32-client tables, the cross-release capability API matrix (scores on current v2.5.0 code only), runner variables, raw artifact, exact reproduction instructions, and interpretation caveats, see **[Benchmark report and reproduction guide](./docs/BENCHMARKS_v2.5.0.md)**. Historical performance claims must identify the commit and environment; rerun on the final main SHA to publish a final release baseline.

## Render Free deployment and limitations

**The v2.5.0 API can run on the existing Render Free service without S3 or a paid disk.** Its `npm install --omit=dev` build executes a Render-only `postinstall` hook to generate/verify Prisma using the pinned production dependency. Setting `VAULTBOX_RENDER_FREE_MODE=1` enables an explicit **single-instance-only startup migration** fallback before `node src/server.js`, because Render Free does not support pre-deploy jobs. Every other platform keeps the separated migration deployment contract.

**Critical limitation:** Render Free's local files are **ephemeral**: writes vanish on redeploy, restart and after idle spin-down. Neon metadata can remain after bytes disappear. This deployment is a feature demonstration/evaluation system, **not durable file storage**. Transfer capabilities, security, upload retry, cleanup, S3-compatible adapter and all other code paths remain present; provider-dependent durability guarantees are **UNVERIFIED** by decision. No paid storage or S3 has been configured. See the [Render Free deployment contract](./docs/DEPLOYMENT.md#render-free-deployment-contract-supported-v250-compatibility-mode).

## Production deployment

**v2.5.0 normally separates build, migration and startup.** On Render Free, the explicitly enabled compatibility hooks above supply generation and migration around the unchanged `npm start` entrypoint:

```text
Build: npm ci && npm run build
Approved migration/predeploy stage: npm run deploy:migrate
Start: npm start (node src/server.js only)
```

Verify Render's build and deploy settings, persistent storage and rehearsed migration rollback **before** merging or deploying. The PR's release/version update is not a production deployment. Do not rely on an application process to run migrations on every replica boot, and do not treat an ephemeral Render filesystem as durable user storage.

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
