# Changelog

All notable changes to VaultBox API are documented here.

## [Unreleased]

### Fixed

- **Idempotency is actor-scoped, durable and fenced (#43).** Idempotency for `POST /folders` moved from Redis (with a per-process fallback) to PostgreSQL: the claim on `(userId, operation, key)`, the folder and the stored response commit in one transaction, so identical keys from different users cannot collide, there is no pending record whose TTL can expire and be overwritten by a slow request, a retry after a lost response replays the original folder id, concurrent duplicates wait and replay (or get `409` + `Retry-After` after `IDEMPOTENCY_LOCK_TIMEOUT_MS`), a different body under the same key is `422`, and Redis outages or multiple replicas cannot cause duplicates. **Behavior change:** malformed `Idempotency-Key` values (outside 1-128 chars of `A-Za-z0-9._:~-`) are now rejected with `400`; previously they were silently truncated. The Redis idempotency module and its process-local fallback were removed. Migration `20261104240000_idempotency_keys` adds one table.

- **One-shot upload reservations survive crashes (#42).** With `x-upload-size`, pending quota is now owned by a durable `UploadReservation` row created in the same transaction as the quota increment, kept alive by a heartbeat lease, and committed or released exactly once by compare-and-set (a swept or duplicate attempt cannot double-adjust counters or consume another reservation's bytes). The shared 5-minute sweeper releases reservations whose lease lapsed, on any instance. Tested by SIGKILLing a real worker process at reservation, before streaming, mid-stream, after the bytes are written and inside the commit transaction. Clients without `x-upload-size` are unchanged. Migration `20261104230000_upload_reservations` adds a table and enum. Rolling-deploy caveat and a read-only leak-check query are in `docs/DEPLOYMENT.md`.

- **In-flight part uploads vs completion/abort/expiry (#41).** A part can only become visible through a short transaction that locks the session row `FOR SHARE` and re-checks it is still `UPLOADING` and unexpired, so claiming completion, aborting and expiring (which update that row) cannot interleave with a late insert: the part either commits first and is in the frozen set, or is rejected (`409`/`410`) and its bytes removed. Completion re-reads the part set after its claim; its missing-object repair deletes only the exact row/object pair; a writer whose chunk directory vanished mid-stream gets `409` instead of `500`. No schema change.

- **Upload completion vs expiry (#40).** Completion now holds a renewable, fenced lease (`completionToken`, `completionLeaseUntil`, `completionGeneration`); the final commit requires the token, so expiry/recovery can no longer invalidate a live completion and a recovered "zombie" completer can no longer publish a file or double-charge quota. A healthy long assembly is never reclaimed; a crashed completer is recovered only after its lease lapses (to `UPLOADING`, or `EXPIRED` with the reservation released once). Lock order is now `User` then `UploadSession` everywhere (previously abort/expiry locked them in the opposite order to the completion commit, a deadlock risk); deadlock/serialization victims are retried with bounded jittered backoff. Migration `20261104220000_upload_completion_lease` adds three columns and an index.

### Security

- **Plan entitlements (#39).** Selecting a paid plan now requires a server-side `PlanEntitlement` granted by an HMAC-signed, idempotent `POST /billing/webhook` event; entitlement check, quota fit and plan switch are one SQL statement under a per-user row lock, so revocation cannot be raced. **Behavior change:** previously any authenticated user could self-select any plan. Set `PLAN_SWITCH_MODE=demo` to keep that behavior explicitly. Adds migration `20261104210000_plan_entitlements` (two new tables; no existing data touched).

### Added

- `PlanEntitlement` / `BillingEvent` tables, `BILLING_WEBHOOK_SECRET`, `BILLING_WEBHOOK_TOLERANCE_SECONDS`, `PLAN_SWITCH_MODE`.

- Two-tenant BOLA/IDOR regression matrix (`test/authorization-matrix.integration.test.js`, #50): cross-tenant access to files, folders, upload sessions/parts and download tokens must be indistinguishable from unknown IDs and leave DB state and stored bytes unchanged; admin routes reject ordinary accounts and forged role/signature/`alg:none` tokens; suspended/deleted accounts are blocked; concurrent owner/foreign deletion charges quota once; and every OpenAPI route outside an explicit public allowlist must reject anonymous callers.

## [2.1.1] - 2026-11-04

### Security

- Upgrade the pinned Node.js runtime from 24.19.0 to **24.22.2** (Node.js 24 LTS), which includes the 2026-10-21 security release (24.22.1) fixes.
- Refresh in-range transitive/direct dependencies in the lockfiles (including `fastify` 5.12.8, `fast-jwt` 6.3.6, `@fastify/busboy` 3.2.4, `fast-uri`, `ip-address`, `brace-expansion`) so `npm audit --audit-level=high` passes again. No `package.json` dependency ranges changed.

### Changed

- CI now fails if the running Node.js version differs from `.node-version`.
- The release workflow derives the version from `package.json`, runs only after the CI workflow succeeded on the exact commit, and no longer hardcodes v2.1.0.

## [2.1.0] - 2026-09-09

### Added

- Durable PostgreSQL-backed resumable upload sessions.
- Numbered, bounded upload parts with exact `Content-Range` validation.
- Per-part SHA-256 integrity support and idempotent same-part retries.
- Upload progress inspection with uploaded/missing part discovery.
- Atomic, idempotent upload completion with streaming server-side assembly.
- Abort/expiry cleanup for temporary parts and quota reservations.
- Explicit `x-upload-size` early quota admission for one-shot uploads.
- Cursor pagination for files, folders, admin users, and audit logs.
- PostgreSQL trigram indexes for substring file/user search.
- Composite indexes aligned to supported cursor/sort access paths.
- ESLint as a required CI quality gate.
- Real PostgreSQL and Redis services in CI for integration/concurrency verification.

### Changed

- Upload and plan-change quota decisions now execute against current database state atomically.
- Active upload reservations now count against available plan capacity.
- File deletion and quota decrement now occur in one ownership-scoped state transition.
- Distributed throttling now uses one Redis Lua round trip per decision.
- Process-local Redis fallbacks are bounded and TTL-aware.
- Admin storage reporting now uses one PostgreSQL aggregate query.
- Range-download session bookkeeping skips redundant writes after first use.
- Download reads open the stored file directly instead of `access()` followed by open.
- Local storage readiness is initialized once during application startup.
- Successful one-shot upload responses reuse quota `UPDATE ... RETURNING` state instead of re-reading the user row.
- Production `npm start` now applies committed Prisma migrations before starting Fastify.
- OpenAPI version now derives from the package release version.

### Removed

- Dead file-cache invalidation calls that had no corresponding cache read path.
- Repeated per-upload storage directory initialization.
- Avoidable post-upload user lookup used only for quota response formatting.

### Fixed

- Concurrent uploads and incompatible plan downgrades can no longer both commit into an over-limit state.
- Concurrent/duplicate file deletes cannot decrement storage twice.
- Concurrent upload completion can create at most one final file and charge quota once.
- Known over-quota one-shot uploads can be rejected before writing the entire payload when `x-upload-size` is supplied.
- Missing download bytes remain a controlled not-found response after removal of the filesystem precheck.

### Deployment

- Release remains on Render + Neon PostgreSQL + Upstash Redis.
- Prisma migrations are applied before the public server starts, closing the previous CI-vs-production migration gap.

## [2.0.0] - 2026-08-29

### Added

- HTTP byte-range downloads with `HEAD`, `Range`, `206 Partial Content`, `Content-Range`, ETag, and `If-Range` support.
- Reusable short-lived resumable download sessions with hashed credentials.
- Reference parallel downloader with persistent resume state and final SHA-256 verification.
- Streaming upload hashing without a post-write whole-file reread.
- Atomic PostgreSQL quota reservation for one-shot uploads.
- Redis lifecycle repair, health reporting, throttling, caching, and idempotency support.
- Production configuration hardening, security headers, request IDs, metrics, and CI benchmark evidence.
- Storage-adapter boundary preserving Render-local storage while allowing future object-storage replacement.

### Changed

- Runtime upgraded to Node.js 24 LTS.
- Authentication revalidates current account state after JWT verification.
- Collection endpoints were bounded and common access paths indexed.
- Production configuration fails closed for critical database/secret configuration.

## [1.0.0] - 2026-06-18

Initial production release with authentication, plans and quotas, file/folder operations, signed downloads, administration, billing simulation, PostgreSQL persistence, Redis integration, health monitoring, and Swagger/OpenAPI documentation.
