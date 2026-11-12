# VaultBox v2.5.0

**Version:** v2.5.0. Production deployment and source commit must be verified independently via [live health](https://vaultbox-api-ucff.onrender.com/health) and the Render dashboard; a published tag alone does not establish durable file storage. v2.3.0 and v2.4.0 were implementation groupings and were not separately tagged.

## Cumulative changes since v2.2.0

- v2.3 reliability: S3-compatible shared adapter and checksum-safe dry-run migration tooling (#53); durable physical-deletion outbox (#54); bounded, crash-recoverable temporary-byte admission and orphan reconciliation (#55); cancel-safe storage streams (#56); retention and pruning of terminal session metadata (#57).
- v2.4 scalability and security: real HTTP/database load profiles (#58); ordered, fenced, leased cleanup workers and measured terminal-session indexing (#59); keyset/summarized 10,000-part progress (#60); independent-process, SIGKILL, BOLA, fuzz, audit and secret scanning gates (#61); exact-SHA/manual release approval and pinned migration stage (#62); profiled PostgreSQL count-free optional pages (#63).
- Developer tooling: replace vulnerable nodemon/minimatch with native Node 24 watch mode.
- v2.5 API: secure folder-assigned one-shot/resumable uploads and moves (#64); reserved quota and actually allocatable bytes reported to clients (#65).

All existing v2.2.0 security, account, rate-limit, audit and quota contracts remain mandatory.

## Render Free compatibility

The existing free Render service can deploy the complete v2.5.0 code using `npm install --omit=dev`, Render-only `postinstall` Prisma generation/verification and opt-in `VAULTBOX_RENDER_FREE_MODE=1` migration before `npm start`. The version-specific API and security features are unchanged. The Free service has one instance, no pre-deploy command and no persistent disk; it loses local file bytes on restarts, redeploys and idle spin-down. Database metadata may remain even if bytes disappear. This deployment is an ephemeral-file **demo**, not verified durable user storage. See [deployment guide](./DEPLOYMENT.md).

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

## Performance evidence

The exact PR-head CI benchmark results (Node 24.22.2, PostgreSQL 16.15, Redis 7, local storage) include **26,711.43 in-process health requests/s** with **0 errors**, **37.704 MiB/s one-shot uploads at concurrency 32**, and **8,000-file count-free pagination p50 0.225 ms**, compared with 1.182 ms when obtaining the exact count. See [complete scores, p95/p99, raw artifact and replication commands](./BENCHMARKS_v2.5.0.md). These are **not** public production benchmarks. Actual historical v1.0.0–v2.2.0 checkout scores (health/system/plans), including the restored legacy v1 runner, and current v2.5.0 capability measurements are documented with reproducible evidence in the [full benchmark report](./BENCHMARKS_v2.5.0.md).

## Release verification evidence and operator acceptance

- Verify complete local Node 24.22.2, PostgreSQL 16, Redis 7, lint, audit, integration, fault, performance and rollback/forward compatibility evidence on the exact final commit.
- Run CodeQL v4 security-extended analysis on the exact reviewed commit; this is configured in the existing single CI verify runner and skipped while the PR is draft (CodeQL cannot be accurately claimed as locally executed). Complete CodeRabbit/human review and reconcile every linked issue's acceptance criteria except the explicitly documented provider exception.
- Configure Render's separate build-time Prisma generate and approved migration stage before any merge (current production uses `npm start` migrations).
- Configure required human reviewers for the GitHub `vaultbox-release` environment, disable unintended automatic deployment for this migration, take backups, rehearse rollback and live smoke tests.
- After explicit approval: merge, run protected-main CI at the exact SHA, intentionally dispatch the release gate, verify production deployment and record evidence in epic #66 and tracker #68. No automated publishing from a draft PR.

## Full protected-main CI verification

The consolidated PR workflow on its exact head runs Node 24.22.2, PostgreSQL 16, Redis 7, locked npm ci, moderate-severity-or-higher npm dependency audit, Prisma schema validation and migrations, strict TypeScript checking of generated data-model contracts plus checked security JavaScript, a real Prisma/runtime module build smoke, ESLint, syntax checking, static secret scanning, the full integration suite with coverage, explicit independent-process/BOLA/failure corpus, 10k-session cleanup stress, three benchmark suites and CodeQL security-extended. One runner handles verification and CodeQL; redundant SHA runs are cancelled. The final green CI run, review threads and any operational exceptions must be inspected before merge approval.

The complete CI workflow is part of this release. A one-time GitHub Actions workflow can publish **only v2.5.0**, after the exact merged-main SHA passes CI and the public Render health endpoints report v2.5.0 with PostgreSQL/Redis operational. The manual exact-SHA release gate remains available for future releases. The user explicitly selected Render Free ephemeral-storage deployment, not a durable S3 or persistent-disk provider.

## Historical version notes

[v1.0.0](./RELEASE_NOTES_v1.0.0.md) · [v2.0.0](./RELEASE_NOTES_v2.0.0.md) · [v2.1.0](./RELEASE_NOTES_v2.1.0.md) · [v2.1.1](./RELEASE_NOTES_v2.1.1.md) · [v2.2.0](./RELEASE_NOTES_v2.2.0.md) · [v2.3 grouping](./RELEASE_NOTES_v2.3.0.md) · [v2.4 grouping](./RELEASE_NOTES_v2.4.0.md). All original core APIs remain, subject to documented security and operational compatibility changes.
