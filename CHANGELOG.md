# Changelog

All notable changes to VaultBox API are documented here.

## [Unreleased]

### Security

- **Download bearer tokens can be revoked and are never exposed by the app's own telemetry (#51).** A download URL is a bearer credential, but a leaked or no-longer-wanted one could only be left to expire. New `DELETE /download-sessions/:id` (the `id` is returned by `POST /files/:id/download-token` and is not secret) and `DELETE /files/:id/download-sessions` (every active session of one of your files) revoke owner-only, idempotently and audited (`DOWNLOAD_SESSION_REVOKED`, details = session id); `revokeSessions` ("log out everywhere") now also revokes the user's unexpired download sessions in the same transaction. A revoked or expired session cannot begin a transfer (`410`, including further ranges of the same download); a stream that is already open runs to completion by design (documented, tested with a paused 32 MB transfer), and parallel ranges / `ETag` / `If-Range` are unchanged. Tests prove the raw token and its hash never appear in application logs (success, `416`, `410`, `404`, validation and storage-failure paths), audit rows or metrics, and that download responses and refusals are `no-store` with `Referrer-Policy: no-referrer`. `docs/DEPLOYMENT.md` gains the token threat model, URL-exposure and edge/APM redaction requirements, safe sharing guidance and the (deferred) header-based alternative. A request authenticated just before a revocation commits cannot mint a download session after it: issuance re-checks the session version under the account row lock and answers `401 SESSION_REVOKED`. Migration `20261105200000_download_token_revocation` adds one nullable column.

### Fixed

- **`HEAD` no longer starts a download session; download refusals are no longer 500s (#52).** `HEAD /download/:token` (documented as metadata inspection) set `usedAt` and emitted `DOWNLOAD_SESSION_STARTED`, so a client sizing a file before downloading consumed the session's first-use event. Only a `GET` that has opened its stream starts a session (still atomic, exactly one event for parallel first ranges). While testing this, a pre-existing bug surfaced: error replies for a missing stored file (`404`) and an unsatisfiable range (`416`) were sent after the binary `Content-Type` had been set, which Fastify rejects for a JSON body, so clients received `500 FST_ERR_REP_INVALID_PAYLOAD_TYPE`. All refusals are now decided before any download header is set and return their proper status with a JSON body. The download routes also use the app's injected storage adapter instead of the process-wide default (the download part of #56). `ETag`, `Range`, `If-Range` and header behavior is unchanged. **Behavior change:** `HEAD` no longer sets `usedAt`.

- **Login and registration under abuse (#49).** Unknown e-mail addresses skipped password verification (fast `401`) and suspended or deleted accounts were disclosed without any credential (`403`), so addresses and account states could be enumerated by response and by time. Now every failure is the same `401`; every attempt does exactly one bcrypt comparison at cost 12 (a dummy hash for unknown accounts); the account state is revealed only to someone who supplied the correct password (`403`). **Behavior change:** a suspended or deleted account with a *wrong* password now gets `401` instead of `403`. Password hashing moved off the main thread into a bounded worker-thread pool (`PASSWORD_HASH_CONCURRENCY` / `_QUEUE` / `_WAIT_MS`, defaults 2 / 64 / 5000): measured event-loop delay under 32 concurrent failed logins fell from ~3.2 s to ~12 ms, and excess load is refused with `503` + `Retry-After` instead of stalling the API. The per-address guard runs before hashing, so credential stuffing across many accounts costs no CPU once capped. Rate-limit keys in Redis now hold a digest instead of the raw address or e-mail, `/metrics` gains hashing counters, and a damaged stored hash is a plain non-match. Hash format unchanged (no migration); seeded demo accounts are now hashed at cost 12. `crypto.scrypt`/Argon2id were assessed and deferred (see `docs/DEPLOYMENT.md`).

- **Audit events are atomic with the changes they describe (#48).** Several handlers committed a change and then wrote the audit row separately, so an audit failure returned an error for a change that had already happened (a retry could duplicate or confuse it), and a download session could be marked started with its event lost. Now registration, one-shot and resumable uploads (create / complete / abort), file deletion, download-session creation and first use, plan changes, admin suspend / reactivate / delete and payment suspension write their audit row in the same transaction: the change and its event commit or roll back together, so an audit failure leaves nothing behind and a retry is safe; concurrent duplicates emit exactly one event. `LOGIN` is written before any token is issued. The only post-commit event, `FILE_DELETED_METADATA_ONLY` (stored bytes not removable), is best-effort and can no longer affect the response. Audit `details` no longer contain file names or e-mail addresses (identifiers and sizes only; existing rows untouched). No schema change. Tested with real audit-store failures (a database trigger rejecting the insert) and with failures injected at COMMIT. Test hygiene: rate-limit counters now outlive a test process (PostgreSQL/Redis), so tests that register or log in use their own client address (`scripts/fresh-address.js`, and `WORKER_TRUST_PROXY=loopback` for the multi-process worker) instead of piling up against `127.0.0.1`; five consecutive full runs without resetting Redis or the database pass.

- **Client IP comes from the trusted proxy chain only (#47).** Production used Fastify `trustProxy: true`, which trusts every peer and takes the *leftmost* `X-Forwarded-For` entry, a value the client writes: a forged header could rotate throttle buckets and falsify the audit log. The setting is now `TRUST_PROXY` (addresses, CIDR ranges, `loopback`/`linklocal`/`uniquelocal`); unset means private-network proxies in production and no proxy elsewhere. `true`, bare hop counts, `/0` ranges, ranges that include public internet addresses (e.g. `::ffff:0:0/96`, `::/1`, an IPv4 range shorter than `/8`), empty entries and malformed values stop startup. All throttles, audit logs and request logs use one `clientIp(request)` that always yields a valid IP address (a malformed value falls back to the connection address). New admin-only `GET /admin/network-diagnostics` shows how an address was derived so the real Render chain can be verified, and production start warns while `TRUST_PROXY` is unset. **Operator action:** run the diagnostics call after deploying; if `clientIp` is a proxy address, add that range to `TRUST_PROXY`. No schema change.

- **Sensitive rate limits stay global and safe during Redis outages (#46).** Previously every replica silently fell back to its own in-memory counter, so N replicas admitted N times the limit. Now login, registration and download-token issuance fall back to a PostgreSQL fixed-window counter (still global across replicas) and **fail closed with `503` + `Retry-After`** if that is unavailable too; upload-session create/part keep the documented bounded per-process fallback. After a degraded decision a sensitive route stays on the shared counter for one window, so reconnecting Redis does not hand attackers a fresh budget. Login gains independent caps per account (30 / 15 min, across addresses) and per address (120 / 5 min, across accounts). The healthy path is unchanged (one Lua round trip). The admin-only `/metrics` reports `rateLimiter.mode` and decision counters (no identities). Migration `20261105100000_rate_limit_windows` adds one table whose keys are hashes. **Behavior change:** the new login caps and the `503` refusal when neither store works.

- **Suspension is enforced at the commit point of in-flight writes (#45).** A request authenticated before a suspension could still finish an upload, create a session, folder or download token, or change plans afterwards. Every transaction that creates usage now takes the owner's `User` row lock (the row a suspension updates) and requires `ACTIVE` there, and the quota/plan SQL statements are predicated on `status = 'ACTIVE'`: the write either commits before the suspension or is refused with `403 ACCOUNT_NOT_ACTIVE`, with its bytes removed and its reservation returned. Abort, expiry, reservation release and sweeper recovery deliberately ignore the status, so a suspended account cannot strand reserved quota. No schema change; public API unchanged except the new refusal. Mid-flight interleavings are tested deterministically (held storage writes and a suspension committed while the request is blocked on the row lock) against real PostgreSQL.

- **Suspension and privilege revocation are enforced immediately and consistently (#44).** The 10-second Redis cache of role/status in `requireAuth` (which could be stale, fail to invalidate, or be repopulated by a racing login) is gone: authentication reads status, role and a new per-account session version from PostgreSQL on every request, so a committed suspension, deletion or demotion is enforced on the next request on every instance, independent of Redis. JWTs now carry the session version (`av`); suspend/reactivate/delete/role changes bump it in the same statement, so a login that races a suspension cannot leave a reusable credential. **Behavior changes:** after reactivation or demotion, tokens issued earlier are rejected with `401` and the user must sign in again; each authenticated request now costs one primary-key lookup. Tokens issued before this release have no `av` and stay valid until the account is revoked. Migration `20261104250000_user_auth_version` adds one column.

- **Idempotency concurrency gate is fair per account (#43 follow-up).** The process-wide gate that protects the connection pool now admits at most one in-flight idempotent request per account at a time (waiters queue per account, bounded), so one account retrying the same key in a burst cannot occupy every slot and starve other accounts. A request that merely waits behind *other* idempotent requests of the same account and gives up now gets `429` + `Retry-After` (`IDEMPOTENCY_BUSY`) instead of the documented identical-request `409`, which is reserved for a request that really is waiting on the same key (the gate tracks the holder's operation and key to tell them apart). The lock-wait tests count only waiters on the advisory lock of their own `(user, operation, key)`. No schema or API change. `npm test` now runs test files serially (`--test-concurrency=1`): the files share one database and the upload sweeper is global, so a concurrent file could recover another file's deliberately stale session (observed once under CPU load as a flaky `recovery is compare-and-set` test); the suite takes about 40 s instead of 16 s.

- **Idempotency is actor-scoped, durable and fenced (#43).** Idempotency for `POST /folders` moved from Redis (with a per-process fallback) to PostgreSQL: the claim on `(userId, operation, key)`, the folder and the stored response commit in one transaction, so identical keys from different users cannot collide, there is no pending record whose TTL can expire and be overwritten by a slow request, a retry after a lost response replays the original folder id, concurrent duplicates wait and replay (or get `409` + `Retry-After` after `IDEMPOTENCY_LOCK_TIMEOUT_MS`), a different body under the same key is `422`, and Redis outages or multiple replicas cannot cause duplicates. **Behavior change:** malformed `Idempotency-Key` values (outside 1-128 chars of `A-Za-z0-9._:~-`) are now rejected with `400`; previously they were silently truncated. The Redis idempotency module and its process-local fallback were removed. Identical in-flight requests are serialised by an advisory lock whose wait alone is bounded, a per-process gate (`IDEMPOTENCY_MAX_CONCURRENT`) keeps duplicate bursts from exhausting the connection pool, and committed records replay without a transaction. Migration `20261104240000_idempotency_keys` adds one table.

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
