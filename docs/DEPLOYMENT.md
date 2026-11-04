# VaultBox production deployment

VaultBox v2.1.1 is deployed with **Render + Neon PostgreSQL + Upstash Redis**.

## Production contract

Render tracks the repository `main` branch with auto-deploy enabled.

The service start command is `npm start`. In v2.1.x that script deliberately performs:

```text
prisma migrate deploy
node src/server.js
```

The API therefore does not bind its public port until committed Prisma migrations have been applied to Neon.

This is important because the existing Render build command installs production dependencies but does not itself run `prisma migrate deploy`.

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

**Guarantee.** Authentication reads the account's status, role and *session version* (`User.authVersion`) from PostgreSQL on every request; nothing about authorization is cached in Redis or in process memory. Once a suspension, deletion, demotion or session revocation has committed, the **next request on every instance is rejected** — revocation latency is zero and does not depend on Redis being up. Requests that already passed authentication before the change are covered by the commit-time account check (#45).

**How tokens are bound.** Every JWT carries the session version it was issued under (claim `av`). Suspending, reactivating, deleting or changing the role of an account increments `authVersion` in the same statement as the change, so all tokens issued earlier are rejected with `401 Session is no longer valid` — including after reactivation or demotion: affected users must sign in again. A login that races a suspension signs the version it read together with the status it checked, so the token it mints is already stale if the account changed in between. Tokens issued before this release have no claim and are treated as version 0, so existing sessions keep working until the account is revoked. JWT expiry is unchanged.

**Changing roles or revoking sessions by hand.** Use `src/lib/account.js` (`setAccountStatus`, `setAccountRole`, `revokeSessions`) or, in SQL, bump the version with the change so existing tokens die:

```sql
UPDATE "User" SET "role" = 'USER', "authVersion" = "authVersion" + 1 WHERE "email" = 'former-admin@example.com';
```

(A role changed without the bump still takes effect immediately, because the role is read from the database on each request, but the account's older tokens stay valid at the new privilege.)

**Cost.** One primary-key lookup per authenticated request, replacing the previous 10-second Redis cache.

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

**Idempotency now lives in PostgreSQL.** Folder-creation idempotency no longer uses Redis, so Redis outages, restarts and multiple replicas cannot cause duplicate execution; Redis is used only for the auth cache and throttling. Records expire after 24 hours and are pruned by the shared 5-minute sweeper. Identical in-flight requests are serialised by a transaction-scoped advisory lock and only that wait is bounded by `IDEMPOTENCY_LOCK_TIMEOUT_MS`, so the timeout never fires because of an unrelated lock on the user row. Each process lets at most `IDEMPOTENCY_MAX_CONCURRENT` idempotent transactions hold a pooled connection; further duplicates queue in memory (holding no connection) and replay once they run, so a burst of duplicates behind a slow original cannot exhaust the Prisma pool. Keep `IDEMPOTENCY_MAX_CONCURRENT` below the pool size configured on `DATABASE_URL` (`connection_limit`, Prisma's default is `num_cpus * 2 + 1`). A committed, unexpired record is replayed with a plain read and no transaction.

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

v2.1.1 itself contained no schema change. Releases after it add only additive schema (plan entitlements, upload completion leases, upload reservations): leave those migrations in place on rollback, as older builds ignore the new tables and columns. Do **not** roll back to a build that runs Node.js `24.19.0` (it lacks the October 2026 security fixes). Roll back to a patched build instead: redeploy the previous commit with the `.node-version` pin kept at `24.22.2` or later.

Builds that predate the plan-entitlement release do not check entitlements: rolling back to one re-enables unrestricted paid-plan self-selection. Roll back only to a build that includes entitlement checks, or keep the current release running and fix forward. The new tables are additive and safe to leave in place on rollback.

Builds that predate upload reservations cannot reconcile `PENDING` `UploadReservation` rows, so a rollback to one can leave `reservedUploadBytes` held for uploads that were in flight or had crashed. After such a rollback, run the quota-leak query from the schema section above when no uploads are in flight and investigate any rows it returns before correcting values.
