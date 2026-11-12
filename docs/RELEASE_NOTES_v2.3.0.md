# VaultBox v2.3.0 development grouping — Storage Reliability

**Publication status:** v2.3.0 is a planning/implementation group incorporated directly into **v2.5.0** by the consolidated PR #88. It has **not** been published as its own GitHub tag or independently deployed release. Do not invent an intermediate shipped version.

## Work included in v2.5.0

- **#53:** Optional private S3-compatible storage adapter with multipart, byte-range, checksum-aware dry-run migration utility and rollback plan. The adapter was verified against an emulator only; owner chose **no production S3 provider**, so provider/IAM/cutover/durability acceptance is **UNVERIFIED**.
- **#54:** Transactionally durable deletion outbox and lease/retry worker so physical file deletion survives storage failures and process crashes without double-refunding quota.
- **#55:** Durable temporary-byte budgets and claims, ENOSPC admission, storage reconciliation, bounded disk/parallel activity and crash-recovery protections.
- **#56:** Abortable pipeline-based part assembly, proper backpressure and failure cleanup, stream-descriptor leak regressions.
- **#57:** Indexed restartable pruning of terminal upload sessions and expired tokens with independently configured retention. Audit-log pruning is opt-in and subject to compliance approval.

All prior registration, admin, plan/quota, one-shot upload, resumable transfer and security behavior remains available. See the final cumulative [v2.5.0 notes](./RELEASE_NOTES_v2.5.0.md) and [deployment guide](./DEPLOYMENT.md).
