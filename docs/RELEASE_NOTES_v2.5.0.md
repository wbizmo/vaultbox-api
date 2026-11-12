# VaultBox v2.5.0

**Status:** DRAFT RELEASE NOTES — engineering implementation in review in PR #88. No release tag has been published and production has not been switched to this version.

## Cumulative changes since v2.2.0

- v2.3 reliability: S3-compatible shared adapter and checksum-safe dry-run migration tooling (#53); durable physical-deletion outbox (#54); bounded, crash-recoverable temporary-byte admission and orphan reconciliation (#55); cancel-safe storage streams (#56); retention and pruning of terminal session metadata (#57).
- v2.4 scalability and security: real HTTP/database load profiles (#58); ordered, fenced, leased cleanup workers and measured terminal-session indexing (#59); keyset/summarized 10,000-part progress (#60); independent-process, SIGKILL, BOLA, fuzz, audit and secret scanning gates (#61); exact-SHA/manual release approval and pinned migration stage (#62); profiled PostgreSQL count-free optional pages (#63).
- Developer tooling: replace vulnerable nodemon/minimatch with native Node 24 watch mode.
- v2.5 API: secure folder-assigned one-shot/resumable uploads and moves (#64); reserved quota and actually allocatable bytes reported to clients (#65).

All existing v2.2.0 security, account, rate-limit, audit and quota contracts remain mandatory.

## Compatibility

- `GET /files`, `GET /folders`, admin pagination preserve original count responses unless the caller requests `includeTotal=false`.
- Upload progress preserves the legacy response by default; bounded summary/page modes are opt-in.
- Uploads can specify an owned folder; cross-user folder/file identifiers remain rejected.
- One-shot writes may now return HTTP 507 if temporary/disk capacity cannot safely admit them; declared and headerless limits are enforced.
- Run additive Prisma migrations *before* starting the new API and execute Prisma generation at build time. The runtime startup no longer downloads executables or runs database migration.

## CodeRabbit review remediations

The review corrective batch addresses temporary ASSEMBLY concurrency-slot deadlocks, S3 orphan-claim fencing and deferred remote verification, stable legacy File ID + stored-name hashing for optional S3 migration (with dry-run File ID reporting), deterministic conditional-write readiness tests, accurate ranged-download throughput accounting, and documentation/.env examples. S3 remains optional and unconfigured, and production-specific S3 acceptance remains **UNVERIFIED**. Added the CodeQL flagged fixed-field file sorting, production-safe profiling opt-in, release-heading validation, credential scanner hardening, guaranteed raw CI-log deletion and a concurrent stored-name index; operational index-window and code-scanning ruleset requirements remain documented in the deployment guide.

## Explicit unverified provider exception

**No production S3 provider is configured or planned for this review.** The optional S3 adapter was tested only against a disposable emulator; production IAM, checksum migration/cutover, S3 multipart concurrency guarantees and real multi-host durability remain **UNVERIFIED**. Continue single-instance local storage only with a genuinely persistent, separately backed-up volume; Render's ephemeral disk must never be described as durable object storage. This is a deliberate review-scope exception, not a completed #53 provider acceptance.

## Release gates (not yet signed off)

- Verify complete local Node 24.22.2, PostgreSQL 16, Redis 7, lint, audit, integration, fault, performance and rollback/forward compatibility evidence on the exact final commit.
- Run CodeQL v4 security-extended analysis on the exact reviewed commit; this is configured in the existing single CI verify runner and skipped while the PR is draft (CodeQL cannot be accurately claimed as locally executed). Complete CodeRabbit/human review and reconcile every linked issue's acceptance criteria except the explicitly documented provider exception.
- Configure Render's separate build-time Prisma generate and approved migration stage before any merge (current production uses `npm start` migrations).
- Configure required human reviewers for the GitHub `vaultbox-release` environment, disable unintended automatic deployment for this migration, take backups, rehearse rollback and live smoke tests.
- After explicit approval: merge, run protected-main CI at the exact SHA, intentionally dispatch the release gate, verify production deployment and record evidence in epic #66 and tracker #68. No automated publishing from a draft PR.

## Review-ready CI gate (not a production release)

The consolidated PR workflow on its exact head runs Node 24.22.2, PostgreSQL 16, Redis 7, locked npm ci, moderate-severity-or-higher npm dependency audit, Prisma schema validation and migrations, strict TypeScript checking of generated data-model contracts plus checked security JavaScript, a real Prisma/runtime module build smoke, ESLint, syntax checking, static secret scanning, the full integration suite with coverage, explicit independent-process/BOLA/failure corpus, 10k-session cleanup stress, three benchmark suites and CodeQL security-extended. One runner handles verification and CodeQL; redundant SHA runs are cancelled. The final green CI run, review threads and any operational exceptions must be inspected before merge approval.

Main currently runs the prior version's CI until this review PR is merged. Do not push a standalone version/CI update to main merely to obtain a green check: Render currently auto-deploys main, and pushing would risk an unapproved production deployment. The full CI workflow is committed in this PR and will replace the old main workflow as part of the reviewed merge. CodeRabbit and human reviewers should review the full consolidated diff, not just the latest commit.
