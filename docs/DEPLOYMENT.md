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
- `UPLOAD_MAX_PARTS`
- `UPLOAD_SUGGESTED_PARALLEL_PARTS`
- `DOWNLOAD_TOKEN_EXPIRES_MINUTES`
- `DOWNLOAD_MAX_RANGES`
- `DOWNLOAD_SUGGESTED_PART_BYTES`

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
20261104210000_plan_entitlements
```

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

v2.1.1 contains no schema change, so a rollback needs no database action. Do **not** roll back to a build that runs Node.js `24.19.0` (it lacks the October 2026 security fixes). Roll back to a patched build instead: redeploy the previous commit with the `.node-version` pin kept at `24.22.2` or later.

Builds that predate the plan-entitlement release do not check entitlements: rolling back to one re-enables unrestricted paid-plan self-selection. Roll back only to a build that includes entitlement checks, or keep the current release running and fix forward. The new tables are additive and safe to leave in place on rollback.
