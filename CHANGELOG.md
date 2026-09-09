# Changelog

All notable changes to VaultBox API are documented here.

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
