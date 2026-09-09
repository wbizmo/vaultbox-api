# VaultBox v2 Engineering Record

**Status:** completed through **v2.1.0** on 2026-09-09.

## Goal

Evolve VaultBox from a compact storage API into a production-oriented transfer service without replacing the established provider set: **Render, Neon PostgreSQL, and Upstash Redis**.

The work was executed in two stages:

- **v2.0.0:** resumable/range downloads, streaming upload hashing, Redis/runtime repair, security hardening, storage abstraction, observability, CI and benchmark evidence.
- **v2.1.0:** durable resumable chunked uploads plus a first-principles efficiency/concurrency pass across quota state, file lifecycle, database queries, pagination, search, Redis round trips, filesystem work, deployment migration safety, and quality gates.

## Completed provider-preserving architecture

### Render

Render remains the application runtime. Storage access is isolated behind an adapter instead of being baked into routes. Application startup now treats storage readiness as a lifecycle invariant.

The production start contract applies Prisma migrations before Fastify starts accepting traffic, closing the previous gap between CI migration verification and the existing Render build command.

### Neon PostgreSQL

Neon remains the persistent source of truth for:

- users and plans;
- committed `storageUsed` and active `reservedUploadBytes`;
- file/folder metadata;
- resumable upload sessions and uploaded parts;
- download sessions;
- audit logs.

Correctness-sensitive transitions are pushed into PostgreSQL statements/transactions rather than depending on application read-then-write sequences.

### Upstash Redis

Upstash remains a low-latency ephemeral coordination layer for:

- short-lived account-state caching;
- distributed throttling;
- idempotency state.

Redis is deliberately not the durable source of truth for resumable uploads or quota accounting. Redis outages degrade optimization paths without corrupting persistent state.

## Transfer engine

### Downloads

Implemented standard HTTP range semantics:

- `Accept-Ranges: bytes`
- `Range: bytes=start-end`
- `206 Partial Content`
- `Content-Range`
- SHA-256-backed strong ETags
- `If-Range`
- `HEAD` metadata discovery
- reusable short-lived download sessions
- hashed download credentials
- reference parallel/resumable downloader

The final hot path removes the pre-read `access()` check, opens stored bytes directly, and avoids repeated first-use updates once a session is already started while preserving atomic first-download auditing.

### One-shot uploads

The compatible upload endpoint:

- streams directly to storage;
- computes SHA-256 inline;
- never rereads the whole file just to hash it;
- can use `x-upload-size` to reserve quota before file I/O;
- still treats server-measured bytes as authoritative;
- falls back to the existing final quota check when a client cannot declare size.

### Resumable uploads

v2.1.0 adds a durable upload-session protocol:

- create session and reserve expected bytes;
- upload fixed numbered parts with exact byte ranges;
- inspect uploaded/missing parts;
- resume only missing parts after interruption;
- retry the same part idempotently;
- stream deterministic server-side assembly;
- verify final size and optional whole-file SHA-256;
- atomically convert reserved quota into used quota exactly once;
- abort/expire sessions and release resources.

All session operations are ownership-scoped. Part uniqueness and completion state are database-enforced so concurrency cannot duplicate bytes, files, or quota charges.

## Efficiency and complexity work

### Quota and file lifecycle

- Upload admission evaluates the user's **current** plan in the same SQL transition that reserves capacity.
- Active upload reservations are included in plan-capacity calculations.
- Plan downgrade and upload races serialize on persistent state and cannot both commit an invalid over-limit state.
- File ACTIVE -> DELETED and storage decrement happen in one ownership-scoped SQL statement.
- Duplicate/concurrent delete calls cannot decrement quota twice.
- Successful upload responses reuse `UPDATE ... RETURNING` instead of issuing a redundant user lookup.

### Collections and database access

- Cursor pagination uses stable `(sort value, id)` tie-breaking and avoids exact counts for cursor mode.
- Legacy page pagination is retained for compatibility but bounded.
- Trigram GIN indexes support current case-insensitive substring search semantics.
- Composite indexes align with supported cursor/sort access paths.
- Admin storage reporting is one aggregate query rather than multiple scans/round trips.

### Redis and process memory

- Throttling collapses increment/expiry/TTL work into one Lua `EVAL` round trip.
- Process-local fallbacks are bounded and TTL-aware instead of unbounded Maps.
- Cache invalidations with no matching read path were removed rather than inventing a cache to justify them.

### Filesystem work

- Storage initialization runs once per application lifecycle.
- Download GET removes check-then-open filesystem I/O.
- Upload hashing is performed in the write pass.
- Chunked assembly is streaming and bounded; no whole-file concatenation occurs in Node memory.

## Concurrency invariants

The implementation and PostgreSQL-backed tests cover these invariants:

1. An admitted upload/plan state cannot exceed the plan capacity when committed plus reserved bytes are considered.
2. A file can decrement committed storage at most once.
3. One upload part number corresponds to at most one accepted byte segment per session.
4. Concurrent completion can create at most one final `File` and charge quota once.
5. Matching chunk retries are idempotent; conflicting retries are rejected.
6. Aborted/expired sessions release reserved capacity.
7. First-download audit state transitions at most once per download session even under concurrent initial ranges.

## Security work

Completed controls include:

- fail-closed production database/secret configuration;
- current account-state enforcement after JWT verification;
- normalized email identities;
- stronger password policy/hashing cost;
- production CORS allowlisting;
- defensive response headers;
- hashed download credentials;
- credential-aware request-log redaction;
- distributed throttling with bounded local fallback;
- audit records for security-sensitive state changes;
- opaque storage keys and constrained legacy-path compatibility;
- BOLA/ownership enforcement inside upload/download/file persistence queries.

## Observability and verification

The repository includes repeatable evidence rather than hand-written performance claims:

- request IDs;
- `Server-Timing`;
- process/request metrics;
- PostgreSQL and Redis dependency health/latency;
- in-process control-plane benchmark;
- dependency security audit;
- retained CI artifacts.

The release gate provisions real PostgreSQL and Redis services and requires:

- dependency audit;
- Prisma generation;
- migration deployment;
- syntax validation;
- ESLint;
- unit/integration/concurrency tests;
- benchmark execution.

## Completed upgrade sequence

- [x] Repair Redis and runtime lifecycle.
- [x] Harden configuration and authentication boundaries.
- [x] Add common errors, request timing, metrics and security utilities.
- [x] Introduce the storage adapter and one-pass streaming upload hashing.
- [x] Make quota/file state transitions atomic.
- [x] Implement resumable range-capable downloads.
- [x] Bound Redis/process fallback state.
- [x] Add scalable cursor pagination.
- [x] Add search/sort indexes aligned to actual query semantics.
- [x] Reduce Redis, database and filesystem hot-path round trips.
- [x] Implement durable resumable chunked uploads.
- [x] Add early one-shot quota admission.
- [x] Add PostgreSQL + Redis integration/concurrency CI coverage.
- [x] Make production startup migration-aware.
- [x] Package v2.1.0 with changelog, release notes, README and automated GitHub release publication.

## Remaining infrastructure boundary

The current byte store is still Render-local filesystem storage. The code no longer assumes local storage at the route boundary, but local bytes are still limited by the durability, disk, bandwidth, and horizontal-sharing properties of that deployment model.

A future durable object-storage/CDN adapter is therefore an infrastructure evolution, not a prerequisite for the v2.1.0 application architecture or public upload/download protocol.
