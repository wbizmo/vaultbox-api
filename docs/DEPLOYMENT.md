# VaultBox production deployment

VaultBox v2.2.0 targets deployment on **Render + Neon PostgreSQL + Upstash Redis**.

## Production contract

Render tracks the repository `main` branch with auto-deploy enabled.

**Draft v2.5 operational cutover (#62):** `npm start` now runs **only** `node src/server.js`. It never invokes `npx`, downloads an executable, generates Prisma Client, or migrates a database. The installed `prisma@6.12.0` executable is a pinned production dependency. A production build must run `npm ci --omit=dev && npm run deploy:generate`, and a separate, approved migration stage must run `npm run deploy:migrate` before the app is promoted. Do not merge this PR until Render's build/migration commands are changed and verified on a staging clone.

**Current deployed v2.2.0 behavior differs.** Its legacy `npm start` generates Prisma and applies migrations before listening, because the existing free-tier Render build command installs production modules without applying migrations. Do not update Render production settings prematurely; old deployments must stay working while the new process is rehearsed.

If the Render plan does not support pre-deploy commands, use an independently scheduled, CI-verified one-off migration job with the lockfile-pinned CLI, then promote the already-generated application. Never silently fall back to applying migrations in every API replica's `npm start`. The migration runner and deployment must be serialized and use a PostgreSQL migration lock, preserving compatible additive schema changes. Use `npm_config_offline=true npm start` as the final cold-start check after the prepared build and migrations: no package-registry access may be required.

## Node.js runtime

The runtime is pinned in [`.node-version`](../.node-version) (currently `24.22.2`, Node.js 24 LTS "Krypton"). GitHub Actions reads it via `actions/setup-node` `node-version-file` and the CI job fails if `node --version` differs from the pin.

Render must resolve to the same version. Render's Node selection can be overridden by a `NODE_VERSION` environment variable, which takes precedence over `.node-version`; **delete or update that variable** so it cannot silently pin an older runtime. After each deploy confirm the effective version from the Render build log (`Using Node.js version ...`) or a shell on the instance (`node --version`). Do not expose it through public endpoints.

The minimum security-fixed 24.x baseline is `24.22.1` (2026-10-21 security release); `24.22.2` is the current patch.

## Required environment

At minimum production must provide:

- `DATABASE_URL`
- `JWT_SECRET`
- `REDIS_URL`
- `CORS_ORIGINS`

Client-IP derivation is controlled with `TRUST_PROXY` (see [Client IP and trusted proxies](#client-ip-and-trusted-proxies)); it is optional because production has a safe default.

Plan and billing behavior is controlled with (see [Plan entitlements](#plan-entitlements-and-billing-webhook)):

- `PLAN_SWITCH_MODE` — `entitled` (default) or `demo`
- `BILLING_WEBHOOK_SECRET` — shared HMAC secret; the webhook returns `503` while unset
- `BILLING_WEBHOOK_TOLERANCE_SECONDS` — signature timestamp tolerance (default 300)

Upload/download controls can be tuned with:

- `MAX_UPLOAD_BYTES`
- `UPLOAD_CHUNK_BYTES`
- `UPLOAD_SESSION_EXPIRES_MINUTES`
- `IDEMPOTENCY_LOCK_TIMEOUT_MS` (default 5000; how long an identical in-flight request is waited for before the caller gets 409 + `Retry-After`)
- `IDEMPOTENCY_MAX_CONCURRENT` (default 3; maximum idempotent transactions per process allowed to hold a database connection at once)
- `UPLOAD_RESERVATION_LEASE_SECONDS` (default 120; lease for one-shot upload reservations, renewed while the upload is alive)
- `UPLOAD_COMPLETION_LEASE_SECONDS` (default 120; lease renewed by heartbeat during completion)
- `UPLOAD_MAX_PARTS`
- `UPLOAD_SUGGESTED_PARALLEL_PARTS`
- `DOWNLOAD_TOKEN_EXPIRES_MINUTES`
- `DOWNLOAD_MAX_RANGES`
- `DOWNLOAD_SUGGESTED_PART_BYTES`

## Account suspension and session revocation

**Guarantee.** Authentication reads the account's status, role and *session version* (`User.authVersion`) from PostgreSQL on every request; nothing about authorization is cached in Redis or in process memory. Once a suspension, deletion, demotion or session revocation has committed, the **next request on every instance is rejected** — revocation latency is zero and does not depend on Redis being up. A request that had already passed authentication before the change is not interrupted, but it can no longer **create new usage**: every transaction that creates storage, a session, a file, a folder, a download token or changes the plan takes the owner's row lock and requires `ACTIVE` at its commit point (details below). If the database lookup itself fails, authentication answers `503` (never `401`), so an outage cannot be mistaken for a revoked credential.

**Rolling deploys and rollbacks.** The guarantee holds on an instance only while it runs this release, and for the whole fleet only once **every** instance does. During the overlap an old-build instance never reads `authVersion`: a session revoked with `revokeSessions`, or a suspension that is later reversed by reactivation, can still succeed there until the token's own JWT expiry, and a login served by an old-build instance after a version bump issues a token with no `av` claim that new instances reject with `401` (the user simply signs in again once the rollout is done). So: finish the rollout before revoking sessions or reactivating accounts. Rolling the application back to a build from before this release disables `authVersion` enforcement on those instances until they are replaced; the additive column itself is safe to leave in place. `npm start` regenerates the Prisma client before migrating, so a cached `node_modules` cannot keep a client that predates `authVersion`.

**Commit-time account check (in-flight requests).** `requireAuth` runs before a handler starts, so an upload that is still streaming when an administrator suspends the account has already been authenticated. These transitions therefore re-check the account *inside* their own transaction, under the owner's `User` row lock (the same row a suspension updates), so each one either commits entirely before the suspension or is refused with `403 ACCOUNT_NOT_ACTIVE` and leaves nothing behind:

| Transition | Check |
| --- | --- |
| One-shot upload commit (File + quota), with or without `x-upload-size`; reservation creation | row lock `FOR UPDATE` + `ACTIVE`; quota SQL also predicated on `ACTIVE` |
| Resumable: create session (reserves quota), complete (File + quota) | row lock `FOR UPDATE` + `ACTIVE` |
| Resumable: store a part | shared row lock (`FOR SHARE`) + `ACTIVE`, before the session lock |
| Create folder (plain and idempotent), create download token | shared row lock + `ACTIVE` |
| Plan change (self-service, entitled) | `status = 'ACTIVE'` in the single `UPDATE` |

A refused in-flight upload removes its bytes and returns its reservation; a refused completion gives the session back (`UPLOADING`), and the session's normal expiry later releases the reservation. **Cleanup is never blocked by suspension:** reservation release, session abort/expiry, stale-completion recovery and the sweeper do not look at the account status, so a suspended account cannot strand reserved quota. Other mutating routes were audited: renaming or deleting a folder or file only relabels or frees data (no new usage), so a request already in flight may finish; every *new* request is rejected by authentication.

**How tokens are bound.** Every JWT carries the session version it was issued under (claim `av`). Suspending, reactivating, deleting or changing the role of an account increments `authVersion` in the same statement as the change, so all tokens issued earlier are rejected — including after reactivation or demotion: affected users must sign in again. A login that races a suspension signs the version it read together with the status it checked, so the token it mints is already stale if the account changed in between. Tokens issued before this release have no claim and are treated as version 0, so existing sessions keep working until the account is revoked. JWT expiry is unchanged. Order of checks: a suspended or deleted account always gets `403 Account is suspended|deleted` (the state is checked first); `401 Session is no longer valid` applies to an *active* account whose token carries a stale session version.

**Changing roles or revoking sessions by hand.** Use `src/lib/account.js` (`setAccountStatus`, `setAccountRole`, `revokeSessions`) or, in SQL, bump the version with the change so existing tokens die:

```sql
UPDATE "User" SET "role" = 'USER', "authVersion" = "authVersion" + 1 WHERE "email" = 'former-admin@example.com';
```

(A role changed without the bump still takes effect immediately, because the role is read from the database on each request, but the account's older tokens stay valid at the new privilege.)

**Cost.** One primary-key lookup per authenticated request, replacing the previous 10-second Redis cache.

## Download sessions

`POST /files/:id/download-token` creates a short-lived, reusable download session; `GET`/`HEAD /download/:token` serve it, with `Range`, `If-Range` and strong `ETag` support so clients can fetch parts in parallel.

**What "started" means.** A session *starts* when a `GET` has successfully opened the file's stream (this sets `usedAt` and emits `DOWNLOAD_SESSION_STARTED`, atomically and exactly once even when several first range requests arrive together). **`HEAD` is metadata inspection and never starts a session**: it leaves `usedAt` unset, emits nothing, and a later real `GET` is still the first start. A request that fails before a stream exists (unknown or expired token, inactive account or file, unsatisfiable range, bytes missing from storage) is a JSON error and records nothing. The event is written when the stream is opened, before the bytes are sent; a connection that drops mid-transfer is still a start. A separate "inspected" event for `HEAD` is deliberately not recorded: it has no operational use and would add a write to every metadata probe.

**Errors.** Refusals are decided before any download header is set: `404` (unknown token, missing file or bytes), `410` (expired), `403` (inactive account), `416` + `Content-Range: bytes */<size>` (unsatisfiable range).

### Download token lifecycle and URL exposure

**Threat model.** `POST /files/:id/download-token` is *authenticated* (your JWT, active account, owner of the file); the resulting `/download/:token` URL is a *bearer credential*: anyone who holds the URL can download that one file until it expires or is revoked, without an account. The token is 32 random bytes (43 URL-safe characters), only its SHA-256 is stored, and it grants exactly one file. A leaked URL therefore means leaked file content for the remaining lifetime; it cannot be used for anything else.

**Lifetime and revocation.** Sessions expire after `DOWNLOAD_TOKEN_EXPIRES_MINUTES` (default 15) and can be revoked sooner:

| Action | Effect |
| --- | --- |
| `DELETE /download-sessions/:id` | Revokes one session you own (`204`; `404` if it is not yours; repeating it is harmless). |
| `DELETE /files/:id/download-sessions` | Revokes every active session of one of your files; returns `{ "revoked": n }`. |
| Log out everywhere (`revokeSessions`) | Also revokes all of that user's unexpired download sessions, in the same transaction. |
| Account suspension / deletion | Already refuses downloads (`403`) on the next request. |

`id` comes from the creation response and is not secret; a session is never looked up by token on these routes. Each revocation made by the two `DELETE` routes writes `DOWNLOAD_SESSION_REVOKED` (details = the session id) in the same transaction; log out everywhere revokes download sessions without writing that event.

**Expiry and revocation during a transfer.** The check happens when a request *begins*: a revoked or expired session answers `410` to every new `GET`/`HEAD`, including additional ranges of a download that is already in progress, so clients must request all ranges they need before the session ends (`DOWNLOAD_TOKEN_EXPIRES_MINUTES` should cover the slowest expected transfer). A stream that is already open is **not interrupted**: it runs to completion (bounded by the client's connection), because tearing down a response mid-flight would only produce truncated files. Neither revocation, suspension nor deleting the stored file stops an open stream (the local adapter reads through an open file descriptor). Nothing at the application level ends an open transfer; the only lever is the process itself. Restarting the instance is a broad mitigation, not an immediate cut-off: a graceful shutdown (`SIGTERM`/`SIGINT`) lets active transfers finish and the process force-exits after its 10-second shutdown timeout, interrupting whatever is still running, and it affects every transfer on that instance. Parallel ranges, `ETag` and `If-Range` behave as before while the session is live.

**What the application guarantees.** The raw token is never written by the application: request logs use `/download/[redacted]`, audit `details` and the `/metrics` counters carry only ids and counts, responses are `Cache-Control: private, no-store`, and every response (including refusals) sends `Referrer-Policy: no-referrer`. This is covered by tests that read the real log stream.

**What the application cannot guarantee (operator checklist).** Anything in front of the app sees the full URL: configure each of these to drop or mask the path after `/download/` (or the whole query/path for that route) -- the platform/edge access log (Render request logs), any CDN or WAF, load-balancer logs, APM/trace tools (URL attributes on spans), error trackers and uptime monitors. Browsers keep the URL in history, bookmarks and the address bar; a download link pasted into chat or e-mail is retained by those systems. Safe sharing: issue a session per recipient, keep the expiry short, revoke it as soon as the transfer is done, and prefer sending the *file ID* and letting the recipient authenticate when possible.

**Header-based alternative (considered, deferred).** Accepting the token in an `Authorization` header would keep it out of URLs for non-browser clients, but browsers cannot send custom headers for plain downloads, parallel-range clients already work with the URL form, and a second credential channel doubles the surface to redact and test. It is intentionally not added in this release; the revocation and redaction guarantees above are the mitigation.

## File deletion and byte cleanup

`DELETE /files/:id` is two steps with different guarantees:

1. **Logical deletion (once-only, atomic).** One statement marks the file `DELETED`, refunds its quota and inserts a `FileDeletion` job; the audit event commits in the same transaction. Repeating `DELETE` is a `404` and changes nothing.
2. **Physical removal (durable, retried).** The request tries to remove the bytes immediately. If that fails (or the process dies right there), the job stays queued and a worker retries it: every replica runs a sweep every 60 seconds, claiming due jobs under a 2-minute lease (`FOR UPDATE SKIP LOCKED`), so a crashed worker's job is picked up by another once the lease lapses. An object that is already gone counts as success. Failures back off exponentially (30 s doubling to 1 h, with jitter) and a job that fails 8 times is parked as `DEAD` with its last error; nothing is retried automatically after that. A job whose workers keep dying on the final attempt (so it never reports a failure) is parked the same way once its last lease lapses, and a worker that finishes after its lease lapsed cannot overwrite a newer worker's claim (settlement is fenced on the attempt number). Failures to record a job's state are logged with the file id and never stop the rest of the sweep.

The retry path only ever updates the job row, never `File` or quota, so it cannot refund twice or bring a file back. Finished (`DONE`) jobs are kept 7 days for inspection, then pruned.

**In-flight and new downloads.** A download stream that was already open when the file is deleted keeps reading (the local adapter reads through an open descriptor) and completes; every new download request, and every new download session, for a deleted file is refused (`404`).

**Observability.** The admin `/metrics` response includes `fileDeletions`: `pending`, `retrying`, `dead`, `oldestPendingAgeSeconds`, `oldestDeadAgeSeconds` and `unreclaimedBytes`. Alert on `dead > 0` or on a growing `oldestPendingAgeSeconds`.

**Operating it.** Inspect: `SELECT "fileId", "status", "attempts", "nextAttemptAt", "lastError" FROM "FileDeletion" WHERE "status" <> 'DONE' ORDER BY "createdAt";`. After fixing the storage problem, requeue dead jobs: `UPDATE "FileDeletion" SET "status" = 'PENDING', "attempts" = 0, "nextAttemptAt" = now(), "lockedUntil" = NULL WHERE "status" = 'DEAD';`. Files deleted before this release have no job; their leftover bytes are the subject of the orphan reconciliation work (#55). Rolling back to a build without this table leaves queued jobs unprocessed (they are not lost: they resume when a build with the worker runs again).

## Storage adapters and stream lifecycle

All upload, assembly and download I/O goes through the adapter injected into the app (`app.vaultboxStorage`); `src/lib/storage.js` supplies the local-disk default. Anything that implements the same interface (see `scripts/memory-storage-adapter.js` and `test/storage-adapter-contract.test.js` for a reference implementation and the behavioral contract) can replace it.

**Assembling an upload** (`POST /upload-sessions/:id/complete`) concatenates the parts with `stream.pipeline`: it hashes (SHA-256) and counts each byte once, holds a bounded amount in memory, and settles promptly on any failure of either stream, removing the partial object (never one that already existed). A missing part is reported by number so the client can re-upload it.

**Client disconnects.** A download whose client goes away is torn down by the HTTP layer and its read stream, and the file descriptor behind it, are closed; this is covered by a test that opens and abandons transfers and checks the process's descriptor count.

**Shutdown.** On `SIGTERM`/`SIGINT` the app aborts in-flight upload assemblies at once: they clean up, the upload session returns to a retryable state and the request is answered `503` with `Retry-After: 5`. Downloads already in progress are allowed to finish until the 10-second shutdown timeout, after which the process exits and the operating system releases their descriptors.

## Audit events

Each audited state change (the critical events listed below) is written **in the same PostgreSQL transaction as the change** (`src/lib/audit.js`). The two therefore always agree:

- the change commits ⇒ its audit row exists (there is no separate step that can fail after the commit);
- the audit insert fails ⇒ the whole transaction rolls back, the client receives an error, and nothing happened (no file, quota change, session, account, plan switch or revocation), so a **retry is safe** and the error is never ambiguous. Concurrent duplicate requests emit exactly one event because the compare-and-set that decides who performs the change is in the same transaction.

| Class | Events | If the audit store is unavailable |
| --- | --- | --- |
| **Critical, in the change's transaction** | `ACCOUNT_REGISTERED`, `FILE_UPLOADED`, `FILE_DELETED`, `UPLOAD_SESSION_CREATED` / `_COMPLETED` / `_ABORTED`, `DOWNLOAD_SESSION_CREATED`, `DOWNLOAD_SESSION_STARTED` (atomic with the `usedAt` flag), `DOWNLOAD_SESSION_REVOKED` (atomic with `revokedAt`), `PLAN_CHANGED`, `USER_SUSPENDED` / `_REACTIVATED` / `_DELETED`, `PAYMENT_FAILED` | the operation fails before commit (500) and leaves no trace |
| **Critical, no state change** | `LOGIN` | written before any token exists; on failure no token is issued |
| **Best effort, after the commit** | `FILE_DELETED_METADATA_ONLY` (the stored bytes could not be removed after the deletion committed) | the failure is logged and swallowed; it cannot change the outcome of the already-committed operation |

**Not audited today:** folder writes, upload-session and reservation expiry performed by the background sweeper, and billing-webhook entitlement changes (the webhook's own `BillingEvent` rows are its idempotent record). The guarantee above applies only to the events in the table. The audit table is the durable store and is written atomically, so there is no delivery backlog to drain or monitor; retries for removing stored **bytes** are described in [File deletion and byte cleanup](#file-deletion-and-byte-cleanup). Audit `details` hold identifiers (file, session and user ids) and sizes only, never file names, e-mail addresses or tokens; this is a **change from earlier versions**, which stored file names and e-mail addresses in `details`. Existing rows are not rewritten.

## Client IP and trusted proxies

Rate limits, audit-log addresses and request logs all use **one** derived identity (`clientIp(request)`, `src/lib/client-ip.js`). It is computed from the TCP connection and `X-Forwarded-For` according to `TRUST_PROXY`, which names *which peers are your own reverse proxies*. The server walks the address chain from the connection backwards while each address is a trusted proxy and stops at the first address that is not: **that is the client**. Anything a client writes into `X-Forwarded-For` sits further left and is never consulted. The result is always a syntactically valid IP address; a malformed value is replaced by the connection's own address.

| `TRUST_PROXY` | Meaning |
| --- | --- |
| unset, `NODE_ENV=production` | `loopback,linklocal,uniquelocal` — peers on private addresses (127/8, 169.254/16, 10/8, 172.16/12, 192.168/16, `fc00::/7`, `::1`, `fe80::/10`) are trusted proxies. A direct connection from a public address is never believed. |
| unset, any other environment | none: the connection address is the client (predictable for local runs and tests). |
| `none` | never trust forwarded headers. |
| list | comma-separated addresses, CIDR ranges and the keywords above, e.g. `10.0.0.0/8,203.0.113.0/24`. |
| `true`, `all`, `*`, a bare number such as `1`, a `/0` range, an IPv4 range shorter than `/8`, an IPv6 range that contains public internet addresses (the IPv4-mapped `::ffff:0:0/96` in any spelling, `::/1`, `2000::/3`, ...), an empty entry (stray or trailing comma), or anything malformed | **refused at startup.** `true` would make the *leftmost* (client-written) entry the identity; a bare hop count is treated by Fastify 5 as "trust nobody", so it is rejected rather than allowed to mean something unintended. The broad-range rules exist because such a range makes ordinary internet clients "trusted proxies" (verified against Fastify: with `::ffff:0:0/96` a public IPv4 client's forged `X-Forwarded-For` was believed). Private IPv6 ranges such as `fc00::/7` and `fe80::/10` remain valid. |

**Required ingress behavior.** Your edge/load balancer must connect to the app from an address covered by `TRUST_PROXY` and must **append** the address it saw to `X-Forwarded-For` (or overwrite the header). If it forwards a client-supplied header without appending, the client controls the entry that gets used. Do not expose the service directly to the internet on a port that bypasses the proxy.

**Render topology — verify, do not assume.** The repository cannot observe Render's actual hop chain, so the default is the conservative private-network policy: it can never be spoofed from the public side, but if the connection reaching the app is *not* a private address (or an extra edge network sits in front, e.g. a CDN on a custom domain), every client will resolve to the proxy's address and share its rate-limit buckets. After deploying, call `GET /admin/network-diagnostics` (admin token) from a machine whose public address you know:

- `clientIp` equals your address → correct, nothing to do.
- `clientIp` is the proxy/edge address → add its range to `TRUST_PROXY` (for example `loopback,linklocal,uniquelocal,<edge CIDR>`), redeploy, check again.
- `clientIp` shows an address that you did not send from → the setting is too permissive; fix it immediately.

`socketAddress`, `forwardedFor` and `chain` in the same response show exactly what was seen. A production start without `TRUST_PROXY` logs a warning pointing to this check. Until the check is done, the per-address login cap (120 / 5 min) may be shared by users behind the same resolved address.

## Authentication under abuse

**Uniform failure.** `POST /auth/login` answers every failure with the same `401 {"message":"Invalid email or password"}`: unknown e-mail address, wrong password, and a suspended or deleted account whose password was *not* supplied correctly. Every attempt performs exactly **one** bcrypt comparison at the production cost (12) — unknown accounts are compared against a fixed dummy hash — so neither the response nor the time says whether an address is registered or in what state. Only a caller who supplies the **correct** password is told `403 Account is suspended|deleted`, because they need that to act on it. (Registration still answers `409 Email already registered`, which is inherent to sign-up; its volume is limited by the per-address guard. Accounts whose hash was created at a lower cost than 12 — for example demo accounts seeded by older builds — finish faster than the dummy; re-seed or have users reset to equalise.)

**Layered limits** (all coordinated across replicas, see [Rate limiting](#rate-limiting-and-redis-outages)): per address and account pair (10 / 5 min), per account across all addresses (30 / 15 min), per address across all accounts (120 / 5 min). They run **before** any hashing, so a refused attempt costs no CPU.

**Hashing budget.** bcryptjs is pure JavaScript. Measured on this codebase (cost 12, 4 vCPU, Node 24.22.2; reproduce with `node scripts/measure-password-hashing.js`):

| 32 concurrent failed logins | wall time | event-loop delay (max) |
| --- | ---: | ---: |
| in-process (previous behaviour) | 10.9 s | **3,233 ms** |
| 2 worker threads (now) | 5.5 s | **12 ms** |

(8 concurrent in-process: 808 ms of loop delay; one comparison takes ~330 ms.) Login and registration therefore hash in a bounded pool of worker threads (`PASSWORD_HASH_CONCURRENCY`, default 2, workers created on first use). At most `PASSWORD_HASH_QUEUE` (default 64) requests wait for a worker and none waits longer than `PASSWORD_HASH_WAIT_MS` (default 5000); beyond that the request is refused immediately with **`503` + `Retry-After`** (never a credential failure, never counted as a login), so a burst is shed instead of stalling every other request. **Documented budget:** the event loop is never blocked for more than a few milliseconds by hashing (a test fails above 500 ms); worst-case added latency for a queued login is `PASSWORD_HASH_WAIT_MS`, and sustained throughput is about `PASSWORD_HASH_CONCURRENCY × 3` logins per second. Size `PASSWORD_HASH_CONCURRENCY` to the CPUs you can spare (each worker saturates one core while hashing). The stored hash format is unchanged (bcrypt), so there is **no migration** and older hashes keep working.

*Assessed, not adopted:* `crypto.scrypt` (Node's built-in, thread-pool based) is as fast off-loop but needs a hash-format migration (verify bcrypt, re-hash on login) and a second verifier for a rollback window; Argon2id needs a native dependency. Neither is justified while the pool keeps the loop responsive; revisit if hashing capacity becomes the bottleneck.

**Metrics.** The admin-only `GET /metrics` reports `passwordHashing` (concurrency, active, queued, completed, `rejectedQueueFull`, `rejectedWaitTimeout`, `workerFailures`) — counters and gauges only. A refused attempt logs `password_hash_busy` with the reason and nothing else. No password, e-mail address, token or client address is logged, and rate-limit keys (Redis and PostgreSQL) hold only a SHA-256 digest of namespace and identity. Alert on a non-zero rate of `rejectedQueueFull` **or** `rejectedWaitTimeout`: with the defaults sustained overload shows up first as wait-timeout refusals, because two workers finish only about 30 logins within the 5 s wait limit while the queue holds 64. Setting `PASSWORD_HASH_QUEUE` far above `PASSWORD_HASH_CONCURRENCY × 3 × PASSWORD_HASH_WAIT_MS / 1000` therefore mostly adds requests that will time out; keep it near that figure.

## Rate limiting and Redis outages

Throttling is a fixed window per route class. **Healthy:** one atomic Redis Lua round trip decides, so a limit is global across replicas (it is not multiplied by the replica count).

**Redis unavailable** (not configured, not connected, or a command failed) is handled by an explicit per-route policy:

| Route class | Routes | Policy while Redis is down |
| --- | --- | --- |
| Abuse-sensitive (`shared`) | `POST /auth/login`, `POST /auth/register`, `POST /files/:id/download-token` | A PostgreSQL fixed-window counter (`RateLimitWindow`, one atomic upsert) keeps the limit **global across replicas**. If PostgreSQL cannot answer either, the request is **refused** with `503` + `Retry-After` (fail closed); a per-process counter is never trusted for these routes. |
| Other (`local`) | upload-session create / part | Bounded per-process window (degraded: the limit is per replica until Redis returns). |

- **Reconnect hold-down.** After any degraded decision for a sensitive route, that route stays on the PostgreSQL counter for one full window instead of flipping straight back to Redis, whose counters know nothing about the outage; attempts made during the outage keep counting. If only *some* replicas lose Redis, the two stores are separate for up to one window, so the effective limit is at most 2x for that window.
- **Login caps.** Login is limited per (address, account) pair, additionally per account across all addresses (30 / 15 min) and per address across all accounts (120 / 5 min). Registration stays 8 / 10 min per address.
- **No identities stored.** `RateLimitWindow` keys are SHA-256 digests of namespace and identity (no emails or addresses); finished windows are pruned opportunistically in small batches. No cron job is needed.
- **Diagnostics.** The admin-only `GET /metrics` includes `metrics.rateLimiter` (`mode`: `redis` / `degraded` / `no_redis`, decision counters, namespaces in hold-down). Treat `degraded` on a multi-replica deployment as reduced protection and alert on it. `GET /infra/health` still reports Redis itself.
- **Migration** `20261105100000_rate_limit_windows` adds one small table; rolling back the application leaves it unused.

## Plan entitlements and billing webhook

`PATCH /plans/:planId/subscribe` no longer lets any authenticated user select a paid plan. A plan with `priceMonthly > 0` is activated only when the user holds an `ACTIVE`, in-period `PlanEntitlement` for that exact plan, checked in the same SQL statement that switches the plan and verifies `storageUsed + reservedUploadBytes` fits the new limit. Free plans remain self-service.

Entitlements are created and revoked only by `POST /billing/webhook`:

- Header `x-vaultbox-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(BILLING_WEBHOOK_SECRET, "<t>.<raw request body>")>`; timestamps outside the tolerance window are rejected (replay protection) and the comparison is constant-time.
- Body: `{ eventId, type: "entitlement.granted" | "entitlement.revoked", userId, planId, validUntil?, fallbackPlanId? }`.
- Processing is idempotent by `eventId` (`BillingEvent` primary key): a replay returns `200 { replayed: true }`; the same `eventId` with a different payload returns `409`.
- Grant, revoke and subscribe for one user lock that user's row first, so a revocation cannot be raced by a concurrent subscribe.
- On revoke the user is downgraded to the plan named `Free` (or the free plan given as `fallbackPlanId`) **if current usage fits**. Otherwise the user keeps the plan and all data in a *grace state*: nothing is deleted or made unreadable, the entitlement is revoked so the plan cannot be re-selected, and the downgrade happens when usage drops below the free limit and the user switches themselves. Time-based expiry (`validUntil`) is enforced when a plan is selected; there is no background sweeper yet that downgrades users whose entitlement merely lapsed.

### Demo mode — action required on existing deployments

Before this release any user could self-select the seeded Basic/Pro plans. The secure behavior is now the default **in every environment**. To keep the old unrestricted behavior (for example on a public demo with no billing) set `PLAN_SWITCH_MODE=demo` explicitly. **If the live Render service relies on self-service paid plans, set this variable before or when deploying, or those requests will return `403`.** Demo mode must not be used when paid plans confer real value.

## Release deploy checklist

1. Merge only after the full GitHub Actions CI gate is green.
2. Confirm Render auto-deploys the intended merge commit from `main`.
3. Confirm the deploy reaches `live` rather than `build_failed`, `update_failed`, or `canceled`.
4. Inspect startup/build logs for migration failures, Prisma errors, Redis connection errors, or repeated process restarts.
5. Confirm `GET /health` succeeds.
6. Confirm `GET /infra/health` reports PostgreSQL and Redis state.
7. Confirm the production `_prisma_migrations` table contains the latest repository migration.
8. Confirm Swagger/OpenAPI reports the release version and expected routes.
9. Exercise at least one authenticated write flow after schema-changing releases.

## Schema expectation (v2.1.x)

The production database must include migrations through:

```text
20261104250000_user_auth_version
```

(`20261104240000_idempotency_keys` and earlier migrations precede it.) `20261104250000_user_auth_version` adds one `NOT NULL DEFAULT 0` integer column to `User` (a metadata-only change in PostgreSQL 11+). Previous-build instances ignore it, so the migration is safe to apply before the new code starts.

(`20261104230000_upload_reservations` and earlier migrations precede it.) `20261104240000_idempotency_keys` adds the additive `IdempotencyKey` table only.

**Idempotency now lives in PostgreSQL.** Folder-creation idempotency no longer uses Redis, so Redis outages, restarts and multiple replicas cannot cause duplicate execution; Redis is used only for throttling. Records expire after 24 hours and are pruned by the shared 5-minute sweeper. Identical in-flight requests are serialised by a transaction-scoped advisory lock and only that wait is bounded by `IDEMPOTENCY_LOCK_TIMEOUT_MS`, so the timeout never fires because of an unrelated lock on the user row. Each process lets at most `IDEMPOTENCY_MAX_CONCURRENT` idempotent transactions hold a pooled connection; further duplicates queue in memory (holding no connection) and replay once they run, so a burst of duplicates behind a slow original cannot exhaust the Prisma pool. Keep `IDEMPOTENCY_MAX_CONCURRENT` below the pool size configured on `DATABASE_URL` (`connection_limit`, Prisma's default is `num_cpus * 2 + 1`). A committed, unexpired record is replayed with a plain read and no transaction.

Retries made *during* a rolling deploy against an instance still on the previous build use the old per-process fallback and are not deduplicated against the new store.

(`20261104220000_upload_completion_lease` and earlier migrations precede it.) `20261104230000_upload_reservations` adds the additive `UploadReservation` table and enum only.

**Checking for quota leaked before this release.** Reservations made by previous builds have no durable owner. After the rollout, no user should hold reserved bytes with nothing live to back them. This read-only query lists candidates (it changes nothing; investigate before correcting any value):

```sql
SELECT u."id", u."reservedUploadBytes",
       COALESCE(s.sessions, 0) AS "uploadSessionBytes", COALESCE(r.pending, 0) AS "pendingReservationBytes"
FROM "User" u
LEFT JOIN (SELECT "userId", SUM("expectedSize") AS sessions FROM "UploadSession"
           WHERE "status" IN ('UPLOADING','COMPLETING') GROUP BY "userId") s ON s."userId" = u."id"
LEFT JOIN (SELECT "userId", SUM("bytes") AS pending FROM "UploadReservation"
           WHERE "state" = 'PENDING' GROUP BY "userId") r ON r."userId" = u."id"
WHERE u."reservedUploadBytes" <> COALESCE(s.sessions, 0) + COALESCE(r.pending, 0);
```

Run it when no uploads are in flight (it will legitimately show rows while old-build instances still hold in-memory reservations).

(`20261104210000_plan_entitlements` and earlier migrations precede it.) The completion-lease migration only adds three nullable/defaulted columns and one index to `UploadSession`; running instances of the previous build ignore them, so it is safe to apply before the new code starts.

`20260909051000_resumable_upload_sessions` introduced durable upload session state and the user's `reservedUploadBytes` counter. `20261104210000_plan_entitlements` adds the additive `PlanEntitlement` and `BillingEvent` tables (no existing table or row is modified).

Earlier v2 migrations also add access-path, cursor-pagination, substring-search and file-sort indexes used by the optimized query paths.

## Health interpretation

### `/health`

Liveness confirms the Fastify process is serving requests.

### `/infra/health`

Dependency health is the stronger production check. It verifies current PostgreSQL and Redis connectivity/state rather than relying only on process liveness.

A release should not be considered healthy solely because Render says `live`; the dependency endpoint and migration state must also be verified.

## Storage warning

The current storage adapter writes bytes to Render-local filesystem storage. Application-level resumability and correctness do not make node-local storage horizontally shared or inherently durable across instance replacement.

A future object-storage adapter can replace this provider behind the existing storage boundary and upload-session protocol.

## Rollback

v2.1.1 itself contained no schema change. Releases after it add only additive schema (plan entitlements, upload completion leases, upload reservations, idempotency keys, account session versions, rate-limit windows, download-token revocation): leave those migrations in place on rollback, as older builds ignore the new tables and columns. Do **not** roll back to a build that runs Node.js `24.19.0` (it lacks the October 2026 security fixes). Roll back to a patched build instead: redeploy the previous commit with the `.node-version` pin kept at `24.22.2` or later.

Builds that predate the plan-entitlement release do not check entitlements: rolling back to one re-enables unrestricted paid-plan self-selection. Roll back only to a build that includes entitlement checks, or keep the current release running and fix forward. The new tables are additive and safe to leave in place on rollback.

Builds that predate download-token revocation (everything before v2.2.0, including v2.1.1) do not check `DownloadToken.revokedAt`: after a rollback to one, a download URL that was revoked (by the revoke endpoints or by "log out everywhere") works again until its stored `expiresAt`, and revocation stays disabled for as long as that build runs. The column and migration are harmless to leave in place. If revocation matters during an incident, fix forward instead of rolling back; if you must roll back, treat every download URL issued before the rollback as live until it expires. For a suspected leak, do not restore traffic until the latest stored expiry among the pre-rollback sessions has passed (`SELECT max("expiresAt") FROM "DownloadToken" WHERE "revokedAt" IS NOT NULL OR "expiresAt" > now();` -- the current setting is not a valid bound, since older sessions may have been issued under a longer one), or invalidate all existing tokens through a mechanism the rollback build enforces (for example by deleting the rows). Lowering `DOWNLOAD_TOKEN_EXPIRES_MINUTES` only limits URLs issued after the rollback; it does not shorten existing ones.

Builds that predate upload reservations cannot reconcile `PENDING` `UploadReservation` rows, so a rollback to one can leave `reservedUploadBytes` held for uploads that were in flight or had crashed. After such a rollback, run the quota-leak query from the schema section above when no uploads are in flight and investigate any rows it returns before correcting values.

### Transfer metadata retention (draft #57)

Every 5 minutes (also on startup), each instance runs an independent bounded metadata-pruning pass; PostgreSQL row locks with SKIP LOCKED prevent duplicate worker claims. Each resource is pruned in keyset order in batches (default 100 per pass, maximum 500). Terminal upload sessions (COMPLETED, ABORTED, EXPIRED) older than 30 days are removed with UploadPart rows by cascade, never active/COMPLETING sessions. Download tokens are removed only once expired for over 30 days. These operations do not touch durable File, quotas or audit evidence. File-deletion outbox retention is separately managed by the existing outbox worker; pending/dead entries are not pruned.

Configuration: VAULTBOX_METADATA_PRUNE_BATCH_SIZE=100 (1..500), VAULTBOX_UPLOAD_METADATA_RETENTION_DAYS=30 (1..3650), VAULTBOX_DOWNLOAD_METADATA_RETENTION_DAYS=30 (1..3650), VAULTBOX_AUDIT_RETENTION_DAYS=0 (0 disables deletion). AuditLog deletion is OFF by default; enabling it requires explicit owner approval of statutory retention requirements, legal holds, archiving and rollback/backup procedure before setting a positive value. Operators must capture backups before enabling audit pruning; restoration requires DB backups. Prune counts are logged as Transfer metadata pruned, errors as warnings. Alert if warnings persist, if the backlog increases across intervals, or if the oldest eligible terminal session is older than two retention intervals.

Deployment: apply the two additive ordered cleanup indexes in migration 20261110110000_metadata_retention. To disable pruning without reverting schema, stop the cleanup scheduler or deploy the prior app version (indexes can safely remain); do not attempt to recreate deleted metadata without a backup. On a representative database verify indexed ordered scans with EXPLAIN (ANALYZE, BUFFERS) before production cutover.


### Durable shared S3-compatible storage (draft #53)

`STORAGE_BACKEND=local` remains the default development adapter. Multi-replica production **must** explicitly use `STORAGE_BACKEND=s3` and a private bucket whose existence/read permissions are verified during application startup. The S3-compatible backend stores immutable files under `S3_OBJECT_PREFIX/objects/<storedName>` and upload parts under `S3_OBJECT_PREFIX/parts/<session>/<storedName>`, so every replica sees exactly the same objects. It uses bounded streaming writes and multipart uploads, S3 byte-range reads, conditionally create-only object keys, server-side encryption, and idempotent deletes. Content integrity is still checked by the existing SHA-256 completion and download contracts. Object encryption, transport TLS, versioning and least-privilege IAM/bucket policy must be configured on the storage provider.

Configuration: `S3_BUCKET` and `S3_REGION` are required, `S3_ENDPOINT` is optional for third-party compatible storage, `S3_FORCE_PATH_STYLE=true` for providers needing path-style requests, `S3_OBJECT_PREFIX` defaults to `vaultbox`, `S3_SERVER_SIDE_ENCRYPTION` defaults to `AES256`. Use the AWS SDK credential chain (workload identity preferred); do not embed keys in a repository or process logs. Grant only `s3:HeadBucket`/bucket-head equivalent, `s3:ListBucket` on the managed prefix, and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, multipart abort/list permissions for the prefix. Verify the provider enforces conditional `If-None-Match: *` for single and multipart object creation; keys are random and preflight HEAD is a second safeguard, not a substitute for atomic conditional storage operations.

**No automatic production migration.** Existing Render local-file data may be ephemeral; restore any missing bytes from backups *before* the cutover. A mixed local/S3 deployment cannot safely handle active uploads. Freeze all writes (including background workers), finish or abort resumable sessions, drain upload reservations and the file-deletion outbox, and take consistent database + local-object backups. From a host with access to the existing local upload tree and private S3 bucket, run the following without disclosing credentials:

```bash
# Dry-run: hashes committed local files and reports missing S3 targets; writes nothing
node scripts/migrate-local-to-s3.js --limit=500
# After approval and reliable backup: copy + verify every file checksum
node scripts/migrate-local-to-s3.js --apply --limit=500
# Repeat with --after=<lastId> from each batch until scanned < limit
# Independent full remote read/rehash; refuses missing or mismatched objects
node scripts/migrate-local-to-s3.js --verify-only --limit=500
```

The tool rejects active upload sessions, pending quota reservations and unfinished/dead byte-deletion outbox entries, and never overwrites existing S3 keys, deletes original bytes or mutates the File table. Existing S3 objects are rehashed before accepting resumed runs. It processes keyset-ordered, bounded file pages. Use `--user-id=<id>` for an authorized per-user migration; still freeze all writes globally. Ensure **all** active File rows are copied and verified before setting `STORAGE_BACKEND=s3`; test upload from one replica and download/range/HEAD from a second replica, delete/retry and restart. Confirm no unmatched objects or unsettled reservations. Preserve the local backup until the S3 deployment has passed smoke tests and the rollback window closes.

**Rollback:** before new S3 writes, restore the old runtime and `STORAGE_BACKEND=local` with the untouched local filesystem and database snapshot. Once new files have been written to S3, switching back without a reverse verified copy would lose user data; freeze writes and explicitly copy/checksum the new objects back, then restore a compatible database state. Never delete source data during a rollback. For provider portability, exercise the optional `VAULTBOX_S3_TEST_ENDPOINT` integration tests against a disposable compatible endpoint with controlled credentials; no test credentials or test-only emulator are part of the production image.

### Explicit release promotion (draft #62)

Release publishing no longer runs automatically after any push or successful CI. Only a deliberate GitHub Actions `workflow_dispatch` invocation of `.github/workflows/release-v2.yml` with an exact **stable version** and **full SHA** can publish. The workflow requires a completed, successful **push CI on protected main at exactly that SHA**, a matching `package.json` version, matching release notes and title, and the same current main HEAD at the moment of publication. It refuses divergent tags or existing releases, runs under a single concurrency group, uses minimal token permissions and a `vaultbox-release` approval environment.

Before enabling the workflow, configure **required human reviewers for the `vaultbox-release` environment** in GitHub repository settings; YAML declaring an environment alone does not enforce reviewers. Keep `main` branch protection and the `VaultBox CI` required check enabled. Draft PR checks are skipped to avoid using GitHub Actions as a debugger; maintain the exact local Node/Postgres/Redis verification transcript and artifacts for each checkpoint, then mark the PR ready only after all acceptance criteria and full CI pass. Do not publish v2.5.0 or merge this draft until the user explicitly approves the release.

Rollback runbook: freeze writes, take a PostgreSQL and object-store snapshot, confirm migrations are additive and backward-compatible, migrate the staging clone first, compare authenticated health, file writes/reads and folder/listing APIs, then promote the precise verified commit. If acceptance fails, revert the application to the previous known-good SHA while leaving compatible additive columns in place; restore DB/object backups only if an incompatible data conversion occurred. A reverse migration must never delete data generated under the newer code without an independently validated export.

### Reproducible transfer and database benchmark (draft #58)

`npm run benchmark` still runs the original health-inject microbenchmark for backward comparison. `npm run benchmark:transfers` exercises **real loopback HTTP** multipart one-shot uploads, resumable session initiation, part PUT/completion, authenticated cursor file listings, download-token creation, ranged GET and file deletion, with real PostgreSQL quota/session/audit operations and the configured Redis coordination. The workload uses **1, 4, 16 and 32** concurrent transfer clients for both one-shot and resumable flows, 256 KiB objects divided into 64 KiB parts by default. It creates isolated test users and data, and purges generated users/bytes on completion. It fails on any HTTP/transfer/DB error, timeout, bad range response, or exceeded memory budget. Do not run this against production or an externally reachable host.

Environment: Node 24.22.2, a disposable PostgreSQL database and Redis. Example:

```bash
export NODE_ENV=test
export DATABASE_URL=postgresql://benchmark:benchmark@127.0.0.1:5432/benchmark
export REDIS_URL=redis://127.0.0.1:6379
export JWT_SECRET=ci-only-secret-that-is-long-enough-for-tests
npm ci
npx prisma generate && npx prisma migrate deploy
npm run benchmark:transfers > transfer-benchmark.json
# Extended local/scheduled profile; keep file sizes within configured upload limit:
BENCHMARK_FILE_BYTES=1048576 BENCHMARK_CHUNK_BYTES=65536 \
  BENCHMARK_MAX_RSS_MB=1024 npm run benchmark:transfers
```

The JSON records per-stage throughput (requests/sec and MiB/sec), p50/p95/p99 latency, errors, peak RSS, process CPU time and SQL query counts. PostgreSQL queries are *counted* using an explicit benchmark-only Prisma event hook; query text and parameters are **not logged**. The isolated performance build opts out of the **coarse 240/IP global rate cap** to measure infrastructure, while route-specific security throttles and production defaults remain in place. Production limits remain intact. Hashing and transfers are expected to take **O(file size)** time; bounded parts prevent unbounded buffering.

Benchmark thresholds are **failure=0 and peak RSS <= 1024 MiB** by default, with 20-second per-request timeout; hard microsecond latency limits are intentionally avoided due to machine/runner variance. Preserve the JSON artifact for before/after measurements, identify VM CPU, allocated memory, Node and PostgreSQL/Redis versions, and compare warmed-loopback results only with the *same* environment. Longer file/transfer stress tests should run separately; these results do not represent Render cold starts, internet latency, or production S3 throughput. If the 32-client or memory gate fails, do not publish the release.


### Indexed leased upload cleanup workers (draft #59)

The upload cleanup sweep uses an atomic PostgreSQL `UPDATE ... FROM (SELECT ... ORDER BY ... LIMIT ... FOR UPDATE SKIP LOCKED)` claim, with a per-run random fencing token and lease-expiry timestamp. Claims are committed **before** storage I/O; the session's established **User → UploadSession** lock protocol still guards quota release and stale completion recovery. This prevents two replicas deleting the same session's chunks concurrently, without holding a row lock during a potentially slow S3 operation. Expired `UPLOADING` and truly stale `COMPLETING` sessions retain the existing fenced semantics; healthy completers must never be reclaimed. Terminal-session bytes are removed separately after a one-minute grace period, and `chunksCleanedAt` marks physical cleanup completion. Terminal metadata cannot be pruned by the #57 retention worker until this flag is set, preventing loss of orphan-cleanup evidence.

Configuration (environment variables): `VAULTBOX_UPLOAD_CLEANUP_BATCH_SIZE=100` (1–250), `VAULTBOX_UPLOAD_CLEANUP_CONCURRENCY=4` (1–16), `VAULTBOX_UPLOAD_CLEANUP_LEASE_SECONDS=120` (30–600), `VAULTBOX_UPLOAD_CLEANUP_DELETE_TIMEOUT_MS=30000` (1,000–120,000). Each five-minute sweep claims at most two ordered bounded batches (expired and terminal) and includes retries for expired one-shot reservations and idempotency keys. Storage failures are recorded with only a generic category (no token, file path or provider secrets), attempted jobs are delayed exponentially (10 seconds to one hour), and crashed claims become claimable after the lease. Leases and per-job retry state are in the shared database, not Redis or process memory.

`getUploadCleanupStats()` exposes only aggregate counters: expired, recovered, terminal, failures, retries, retry backlog, pending/terminal backlog, oldest due timestamps and elapsed milliseconds. Alert if `failures` persists, if the oldest due job/terminal backlog increases for three sweeps, if the retry age is over an hour, or if worker duration approaches its five-minute schedule. No tenant identifier should appear in metrics/logs. During rollout monitor disk usage and object-store deletion errors; a failing storage adapter cannot be treated as a successful cleanup. On S3 the adapter's idempotent deletes and per-session prefixes make late completions safe to retry.

Verification: `node --test test/upload-cleanup-worker.integration.test.js` checks two independent Prisma clients, one-time claims, delayed failures, crash lease reclaim and quota release exactly once. An explicit stress gate `VAULTBOX_RUN_LARGE_CLEANUP_TEST=true node --test test/upload-cleanup-worker.integration.test.js` seeds 10,000 old terminal sessions and drains them with two workers and batch/concurrency bounds. The large stress fixture is opt-in to control recurring CI costs. The additive migration `20261111010000_upload_cleanup_claims` must be applied before starting the worker; validate EXPLAIN on the candidate-claim indexes on a representative production-like dataset. The application is not automatically switched to a separate cron worker: scheduled app instances may run simultaneously safely. Before scaling beyond two replicas, select a separately scheduled cleanup process and disable redundant timers in web processes.

Rollback: retain additive schema columns; stop the new cleanup scheduler if storage retry behavior regresses, preserve all uncleaned terminal metadata and object backups, and roll back application binaries. Do not drop the cleanup lease/cleaned columns while a worker might still hold a claim. Retain the outbox and its data until cleanup has been verified; a previous app version that ignores cleaned flags must not be allowed to prematurely prune outstanding physical-delete records.


#### Measured terminal-claim index improvement (local benchmark)

On Node 24.22.2/PostgreSQL 18.6 with 10,000 stale terminal sessions, `EXPLAIN (ANALYZE, BUFFERS)` showed the pre-index terminal claim using **Limit → LockRows → Sort → Seq Scan**, executing in **12.276 ms** for 250 rows. Adding the narrow partial index `UploadSession_cleanup_terminal_due_idx` changed the plan to **Limit → LockRows → Index Scan**, **0.681 ms** for 250 rows under the same synthetic fixture (approximately 18× faster for this one measured SQL query). Two workers drained all 10,000 sessions in **7.48 seconds / 20 paired sweeps**, with no duplicate deletion or quota release. Before adding the index, the same local stress took **8.79 seconds**, but the end-to-end comparison is subject to VM caching and scheduling variance. The partial index measured **1,351,680 bytes** after the stress run; it adds writes when terminal sessions are created/cleaned and should be reevaluated against Neon staging index bloat and production write rates. The broad `cleanupLeaseUntil` index was ~5.2 MB on this exercised test database, including historical dead tuples; that is not a production storage estimate. These are diagnostic local figures, not production SLAs.

The partial index is an additive SQL-only Prisma migration `20261111011000_upload_cleanup_terminal_index`. Its predicate covers only uncleaned terminal upload sessions, so it cannot turn active upload writes into unbounded index churn. If production plans regress, operators may drop only this optional index using a separately approved concurrent index rollback while retaining the cleanup lease columns and durable cleanup state; do not delete any session metadata as part of index rollback.

## v2.5.0 migration/review operations (not yet performed in production)

- The additive stored-name index `20261112003000_file_stored_name_idx` is created with `CREATE INDEX CONCURRENTLY` and must run outside a PostgreSQL transaction block. On staging, verify the real plan uses `File_storedName_idx` for orphan/legacy lookups before the Render cutover.
- **Recovery if the concurrent index build fails:** PostgreSQL can leave a named but **invalid** index after an interrupted `CREATE INDEX CONCURRENTLY`. `IF NOT EXISTS` alone will skip that invalid index on retry, and PostgreSQL will still incur write overhead maintaining it. Stop release rollout and check the exact state using:
  ```sql
  SELECT c.relname, i.indisready, i.indisvalid
  FROM pg_class AS c
  JOIN pg_index AS i ON i.indexrelid = c.oid
  WHERE c.oid = to_regclass('public."File_storedName_idx"');
  ```
  If `indisvalid = false`, execute **outside a transaction** (with operator approval and against the correct staging/production database):
  ```sql
  DROP INDEX CONCURRENTLY IF EXISTS "File_storedName_idx";
  ```
  If Prisma recorded migration `20261112003000_file_stored_name_idx` as failed, clear that failed migration **after** examining its error: `npx prisma migrate resolve --rolled-back 20261112003000_file_stored_name_idx`. Then rerun `npx prisma migrate deploy` and verify `indisvalid = true`. Never drop a valid index, and never mark a failed migration `--applied` just to bypass the build. Document the observed DB state and rerun outcome before promotion.
- Earlier as-yet-unreleased migrations `20261110100000_folder_aware_uploads` and `20261110110000_metadata_retention` contain ordinary index builds. **Schedule the migration stage in a low-traffic maintenance window** and monitor write locks; do not run them during high-volume uploads. Do not rewrite already applied migration checksums. Re-evaluate using standalone concurrent-index migrations if staging reveals unacceptable lock duration.
- `DownloadToken_expiresAt_id_idx` may overlap an existing single-column `expiresAt` index; measure index size, write cost and query plans before removing any old index (not in this release).
- A completed CodeQL workflow is **not** proof that no code-scanning alerts remain. Require manual inspection of open CodeQL alerts and CodeRabbit review threads; establish a repository code-scanning branch-protection/ruleset policy in GitHub Settings before approval. The connector cannot currently enforce that repository setting.
- ESLint 9.39.5 is pinned while the installed newer v10 tree had moderate npm advisories. Do not upgrade solely to satisfy a deprecation warning until an audited, clean version is available; `npm audit --audit-level=moderate` remains a blocking CI gate.
- `npm run benchmark:queries` refuses `NODE_ENV=production` and requires `VAULTBOX_QUERY_PROFILE_ALLOW_WRITES=1` on a disposable nonproduction database. Never set this variable in Render production.
- Single-instance local storage is safe only with a verified persistent, separately backed-up filesystem. No production S3 provider is configured; all provider-specific assurance is UNVERIFIED.
