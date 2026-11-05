# VaultBox API v2.2.0 — Authorization, Concurrency and Abuse-Resistance Release

Phase 1 of the v2.5.0 program (issues #39–#52). Security and correctness hardening of the existing API: no endpoint was removed or renamed and no stored data is rewritten. Seven additive migrations. Several behaviors are **stricter** than v2.1.x (listed below) — read "Behavior changes" before upgrading clients.

## What changed

**Authorization and account state**
- **Cross-tenant regression matrix (#50).** Two-tenant tests prove that another user's files, folders, upload sessions/parts and download sessions are indistinguishable from unknown IDs, that admin routes reject ordinary accounts and forged tokens, and that suspended/deleted accounts are blocked.
- **Plan entitlements (#39).** Selecting a paid plan requires a server-side entitlement granted by an HMAC-signed, idempotent `POST /billing/webhook` event; the entitlement check, quota fit and plan switch are one statement under a per-user row lock.
- **Immediate revocation (#44).** Authentication reads status, role and a per-account session version from PostgreSQL on every request (the 10-second Redis cache is gone). Suspension, deletion, demotion and session revocation take effect on the next request on every instance, independent of Redis.
- **Commit-time account fence (#45).** Every transaction that creates usage re-checks the owner is `ACTIVE` under the owner's row lock, so a request authenticated before a suspension cannot finish creating data afterwards.

**Upload and quota integrity**
- **Completion vs expiry (#40)** uses a renewable, fenced lease; **part writes (#41)** are fenced against completion/abort/expiry; **one-shot reservations (#42)** are durable and recovered after worker crashes (tested with SIGKILL injection). Lock order is always user, then upload session.
- **Idempotency (#43)** for `POST /folders` is actor-scoped, durable in PostgreSQL and fair per account.

**Abuse resistance and operations**
- **Rate limits (#46)** for login, registration and download-token issuance stay global across replicas through a PostgreSQL fallback and **fail closed** (`503` + `Retry-After`) when neither Redis nor PostgreSQL can answer; login also has per-account and per-address caps.
- **Client IP (#47)** comes only from an explicit trusted-proxy policy (`TRUST_PROXY`), not from a client-controlled `X-Forwarded-For`; new admin `GET /admin/network-diagnostics` shows how an address was derived.
- **Audit (#48).** Audit rows are written in the same transaction as the change they describe (no more committed-change/500 ambiguity); details of **new** rows contain identifiers and sizes, never file names or e-mail addresses. Existing audit rows are not rewritten and may still contain file names or e-mail addresses.
- **Password verification (#49).** Uniform login failures (no account enumeration by response), and one bcrypt comparison per attempt at cost 12 in a bounded worker-thread pool (`503` + `Retry-After` when saturated instead of stalling the API). Timing is uniform for accounts whose stored hash is cost 12 (the dummy hash used for unknown e-mails is cost 12); an account with an older, lower-cost hash still verifies faster, so such accounts should be re-seeded or have their passwords reset (the hash format is unchanged and hashes are not upgraded on login).
- **Download sessions (#51, #52).** Revocable (`DELETE /download-sessions/:id`, `DELETE /files/:id/download-sessions`, and revoked by "log out everywhere"); revoked/expired sessions cannot begin transfers (`410`) while open streams finish; the bearer value never reaches logs, audit rows or metrics; every response, including refusals, is `no-store` with `Referrer-Policy: no-referrer`. `HEAD` no longer starts a session, and refusals that used to surface as `500` (missing bytes, unsatisfiable range) are proper `404`/`416` JSON errors.

## Behavior changes (client and operator impact)

| Change | Impact |
| --- | --- |
| Paid plans need an entitlement | `POST` plan selection for paid plans is refused without one. Set `PLAN_SWITCH_MODE=demo` to keep the old self-service behavior explicitly (e.g. a public demo). |
| Malformed `Idempotency-Key` | `400` (was silently truncated). Valid keys: 1–128 chars of `A-Za-z0-9._:~-`. |
| Older tokens after reactivation/demotion | `401`, sign in again. Tokens issued before v2.2.0 stay valid until the account is next revoked. |
| In-flight writes by a suspended account | `403 ACCOUNT_NOT_ACTIVE`; bytes removed, reservation returned. |
| Busy `POST /folders` for an account | `429 IDEMPOTENCY_BUSY` (identical in-flight request is still `409`). |
| Login failures | One `401` for unknown e-mail, wrong password, and suspended/deleted account with a wrong password; `403` only after a correct password. New caps (30 per account / 15 min, 120 per address / 5 min); `503` when rate-limit storage is unavailable. |
| Download first use | Only a `GET` that opened its stream sets `usedAt` / emits `DOWNLOAD_SESSION_STARTED`. |
| Download session creation | Response includes the non-secret session `id`; a request authenticated before a revocation gets `401 SESSION_REVOKED`. |
| `npm test` | Runs files serially (shared database); about 40 s. |

## Operator actions before/after deploy

1. **`TRUST_PROXY` (important).** Unset in production means "private-network proxies". After deploying, call `GET /admin/network-diagnostics` as an admin: if `clientIp` is a proxy address, add the proxy's range to `TRUST_PROXY`, otherwise all clients share one rate-limit bucket (including the 120 / 5 min login cap).
2. Decide `PLAN_SWITCH_MODE` (`demo` for the public demo) and set `BILLING_WEBHOOK_SECRET` if you will grant entitlements (the webhook answers `503` while it is unset).
3. Optionally tune `PASSWORD_HASH_CONCURRENCY` / `_QUEUE` / `_WAIT_MS` (defaults 2 / 64 / 5000) and `IDEMPOTENCY_*`.
4. Configure your edge/CDN/APM to mask the path after `/download/` (see `docs/DEPLOYMENT.md`, "Download token lifecycle and URL exposure").
5. Runtime stays Node.js 24.22.2 (`.node-version`); keep any `NODE_VERSION` override off.

## Migrations (all additive; run automatically by `npm start`)

`20261104210000_plan_entitlements`, `20261104220000_upload_completion_lease`, `20261104230000_upload_reservations`, `20261104240000_idempotency_keys`, `20261104250000_user_auth_version`, `20261105100000_rate_limit_windows`, `20261105200000_download_token_revocation`. Tables/columns added only; no existing data is rewritten.

## Rollback

Leave the migrations in place: older builds ignore the new tables and columns. Do **not** roll back to a build with Node.js `24.19.0`. Builds before this release lack the entitlement check (paid plans become self-selectable again), the commit-time account fence, the DB-authoritative authentication and download-session revocation (a URL revoked under v2.2.0 works again until its stored expiry, for as long as the older build runs; lowering `DOWNLOAD_TOKEN_EXPIRES_MINUTES` does not shorten URLs that already exist, see the rollback section of `docs/DEPLOYMENT.md`); roll back only if you accept that, otherwise fix forward.

## Verification

Every change merged with `verify` green on its exact head and review findings answered on-thread. On `main` (`9645b28`): `npm test` 201/201 on two consecutive runs against real PostgreSQL and Redis (deterministic interleavings, held row locks, SIGKILL crash injection, multi-process workers, per-guard mutation checks), `npm audit --audit-level=high` clean (two moderate dev-only `nodemon` → `minimatch` advisories remain), all 14 migrations apply to a fresh database, benchmark 0 errors. See issue #68 for per-PR evidence.
