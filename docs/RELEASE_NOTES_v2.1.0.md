# VaultBox API v2.1.0 — Resumable Upload & Efficiency Release

VaultBox API v2.1.0 turns the v2 transfer foundation into a bidirectional resumable transfer system and completes a repository-wide efficiency pass across database access, Redis coordination, filesystem I/O, quota accounting, pagination, search, and deployment safety.

The provider architecture remains unchanged: **Render + Neon PostgreSQL + Upstash Redis**.

## Headline feature: durable resumable uploads

VaultBox now supports interruption-safe, chunked uploads in addition to the resumable HTTP range downloads introduced in v2.0.0.

The resumable upload lifecycle is:

1. `POST /upload-sessions` creates a durable upload session and atomically reserves the expected file size against the user's current plan.
2. `PUT /upload-sessions/:id/parts/:partNumber` streams one exact, bounded part using `Content-Range` and optional `x-chunk-sha256` verification.
3. `GET /upload-sessions/:id` reports uploaded and missing parts so clients resume only the data that is still absent.
4. `POST /upload-sessions/:id/complete` atomically claims completion, streams parts into final storage in deterministic order, verifies final size and optional SHA-256, creates one `File`, and converts reserved bytes into committed `storageUsed` exactly once.
5. `DELETE /upload-sessions/:id` aborts an unfinished upload, deletes temporary part bytes, and releases the reservation.

Upload session and part metadata lives in PostgreSQL, not Redis, so restart recovery, ownership checks, idempotency, and quota state remain durable. Temporary bytes stay behind the storage-adapter boundary so a future multipart object-storage implementation can replace local part files without redesigning the public protocol.

### Concurrency and integrity guarantees

- Upload ownership is enforced in every session operation.
- Part numbers are unique per session.
- Exact byte geometry prevents overlapping or duplicated ranges.
- Replaying the same part is idempotent when the checksum matches.
- Conflicting retries are rejected instead of silently replacing bytes.
- Whole files are never concatenated in Node memory.
- Concurrent completion requests can create at most one final file and charge quota once.
- Expired or aborted sessions release reserved capacity.
- Cleanup reconciles stale sessions left by process interruption.

## One-shot uploads now reject known quota failures before file I/O

The existing `POST /files/upload` path remains compatible.

Clients that know the exact file payload size can send:

```http
x-upload-size: <bytes>
```

VaultBox atomically reserves that amount before reading the multipart file or opening a storage file. A request that cannot fit the account's current plan returns `413` before full network, hashing, and disk work is wasted.

The declaration is an admission bound only. The streamed byte count remains authoritative:

- a shorter body returns `422`;
- a body beyond the declaration is bounded and returns `413`;
- parser, pipeline, truncation, mismatch, and database failures release the reservation;
- successful uploads convert the reservation to `storageUsed` in the same transaction that creates file metadata.

Clients that omit `x-upload-size` retain the existing safe final quota-check behavior.

## Atomic quota and file lifecycle invariants

The quota path was rewritten around database-enforced state transitions rather than stale application snapshots.

- Upload admission evaluates the plan that is current when the database statement executes.
- Active resumable-upload reservations count against plan capacity.
- Plan downgrades cannot race an upload into an invalid over-limit state.
- File deletion changes ACTIVE -> DELETED and decrements storage in one ownership-scoped PostgreSQL statement.
- Duplicate or concurrent deletes cannot decrement storage twice.
- Successful upload responses reuse `UPDATE ... RETURNING` instead of issuing another user lookup solely to display `storageUsed`.

The committed invariant is that admitted upload/plan transitions cannot leave `storageUsed + reservedUploadBytes` above the current plan limit.

## Database and collection efficiency

### Cursor pagination

Large file, folder, admin-user, and audit-log collections now support stable cursor pagination using a deterministic `(sort value, id)` tie-breaker.

Cursor mode fetches `limit + 1` and does not issue an exact `COUNT(*)`. Legacy page-number pagination remains for compatibility but is bounded to prevent pathological offsets.

### Search and sort indexes

- PostgreSQL `pg_trgm` powers indexable substring search for file names and admin user name/email lookup.
- GIN trigram indexes preserve case-insensitive `contains` semantics.
- Composite indexes align with supported file sort modes and cursor access paths.

### Admin reporting

`GET /admin/storage-report` now computes total users, status buckets, and total storage in one PostgreSQL aggregate query instead of separate group/aggregate scans.

## Redis and process-memory efficiency

- Distributed throttle decisions now use one Lua `EVAL` round trip instead of separate `INCR`, `EXPIRE`, and `TTL` calls.
- CI includes a real Redis service and proves one Redis command per throttle decision.
- Process-local Redis fallbacks are bounded, TTL-aware stores rather than unbounded Maps.
- Dead file-cache invalidations were removed where no matching cache read path existed.

Redis remains an optimization and coordination layer; PostgreSQL remains the source of truth.

## Download hot-path efficiency

Parallel/range downloads retain v2.0.0 semantics while reducing repeated control-plane work:

- already-started download sessions skip pointless `usedAt IS NULL` updates;
- concurrent first ranges still emit at most one first-download audit event;
- GET opens the file directly instead of doing `access()` followed by a second open;
- missing or unreadable bytes still map to a controlled not-found response;
- HEAD stays metadata-only;
- Range, ETag, and If-Range semantics are unchanged.

## Storage lifecycle efficiency

Local storage readiness is now a process startup invariant. The storage adapter is initialized once during Fastify readiness instead of issuing `mkdir(..., { recursive: true })` on every upload request.

A storage initialization failure prevents normal startup rather than failing later inside a user upload.

## Quality and CI gate

The repository now requires a full verification pipeline with:

- PostgreSQL service
- Redis service
- dependency security audit
- Prisma client generation
- Prisma migration deployment
- JavaScript syntax checks
- ESLint static analysis
- unit and integration tests
- concurrency tests against real PostgreSQL
- filesystem-backed transfer tests
- repeatable control-plane benchmark
- retained engineering evidence artifacts

No PR in the v2.1.0 efficiency/resumability run was merged before this gate was green.

## Deployment hardening

The production start contract now applies committed Prisma migrations before the Fastify process starts:

```text
prisma migrate deploy -> node src/server.js
```

This closes the gap where GitHub Actions validated migrations against its PostgreSQL service but the existing Render build command did not apply them to the production Neon database.

The release deploy must therefore reach a schema-current state before the application binds its public port.

## Compatibility

- Existing one-shot uploads remain supported.
- Existing range/resumable download behavior remains supported.
- The provider set remains Render, Neon PostgreSQL, and Upstash Redis.
- Existing v1-compatible stored filenames remain readable through the constrained storage compatibility boundary.
- The API remains backed by Render-local file storage; resumability does not change the durability or horizontal-sharing limits of node-local bytes.

## Upgrade checklist

1. Use Node.js 24.x.
2. Deploy the v2.1.0 release from `main`.
3. Allow startup to apply all committed Prisma migrations before Fastify starts.
4. Confirm `/health` returns healthy.
5. Confirm `/infra/health` reports PostgreSQL and Redis operational state.
6. Confirm Swagger/OpenAPI reports version `2.1.0` and exposes the upload-session routes plus `x-upload-size`.
7. Exercise one declared-size one-shot upload and one interrupted/resumed chunked upload.
8. Confirm quota reservation is released after abort/failure and converted exactly once after completion.

## Release scope

v2.1.0 includes the merged work from the efficiency and resumable-upload run, including PRs #23 through #36 and their associated issues/tests.
