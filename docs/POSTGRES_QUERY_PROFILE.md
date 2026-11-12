# VaultBox PostgreSQL Query Profiling: #63

## Scope and method

This draft change improves costly page-number listing without altering existing clients. Page-mode routes `GET /files`, `GET /folders` and admin-only `GET /admin/users` accept `includeTotal=false`. Their default **remains true**, returning the original exact `total` and `pages`; opt-out returns `total: null`, `pages: null` and a bounded `hasMore` Boolean, using `limit+1` rows. Cursor mode is unchanged and still uses stable sort-plus-ID keysets. Owner, active-status, folder and search filters are identical in both modes. For performance, prefer cursors over high page-number offsets; offset pagination is inherently O(offset).

The repeatable profile is `npm run benchmark:queries`. It creates and cleans up synthetic tenant datasets with 100, 2,000 and 8,000 files, skewed names and statuses (20% deleted), fixed timestamp ties, wide size distribution, and common/rare search terms. Queries use owner/status predicates, supported ordering, root folder, case-insensitive substring search, short-term search and exact totals. Every query is parameterized, runs five warm-ups then **20 measurements by default**, configurable with `VAULTBOX_QUERY_PROFILE_ITERATIONS` (the results below were captured with **10 measurements**), and captures `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with actual chosen index/scan nodes. The script runs `ANALYZE "File"` after each dataset insertion. It exports per-query p50/p95, plans, index sizes, and legacy exact-count vs count-free page-mode p50/p95. The script refuses production when NODE_ENV=production and requires an explicit opt-in VAULTBOX_QUERY_PROFILE_ALLOW_WRITES=1 on disposable local/CI databases because it seeds and deletes rows. Do not export this opt-in with production credentials.

## Observed local results

Measured on November 10–11, 2026, Node 24.22.2, PostgreSQL **18.6** in an isolated VM with local disk, ten timed samples after warm-up. These are diagnostic benchmarks, **not production Neon 16 data or SLA claims**.

| Tenant files | Legacy page + exact count p50 / p95 (ms) | Count-free page p50 / p95 (ms) | Count-free p50 reduction |
|---|---:|---:|---:|
| 100 | 1.169 / 2.045 | 0.617 / 0.968 | 47% |
| 2,000 | 1.441 / 2.745 | 0.702 / 1.796 | 51% |
| 8,000 | 2.546 / 4.822 | 0.450 / 0.527 | 82% |

At 8,000 rows the cursor-style createdAt query measured **0.456 ms p50 / 0.901 ms p95**, size sort **0.423 / 0.585 ms**, root-filtered **0.424 / 1.248 ms**, and case-insensitive `quarterly` search **1.171 / 2.087 ms**. Existing `File_userId_status_createdAt_id_idx` and `File_userId_status_size_id_idx` support ordered bounded retrieval; the plan can use a selective tenant index and filter a searched name, rather than always using the trigram GIN. For 100-row tenants, PostgreSQL correctly favors cheap sequential scans. Exact count was observed scanning qualifying rows, confirming why an optional skip helps. The 2-letter `re` search is insufficiently selective for the trigram index and must remain capped to bounded result pages.

**No additional indexes are proposed.** Existing indexes already occupy substantial space and are updated on insert/delete; an unmeasured extra partial index would penalize uploads and deletions. Index-specific pg_relation_size bytes and plan nodes are emitted by the benchmark. Review any new index only after representative Neon workloads and write amplification data justify it.

## Verification and rollout

- Tests cover identical first-page results and owner/status/search filters, root/folder handling, page 2, original count compatibility, and admin-only authorization for `/admin/users` and owner-scoped authorization for `/files` and `/folders`.
- Execute `node --test test/file-count-optional.integration.test.js test/postgres-query-profile.test.js`, then the full Node24 CI-equivalent suite and `npm run benchmark:queries`. Save benchmark JSON as an engineering artifact.
- Default clients need **no change**. High-volume clients should opt in to `includeTotal=false` or use cursor pagination; do not interpret `null` as a zero total.
- For rollback, revert the additive query parameter and new branch code. No schema migration is required and all original indexes remain. If an unexpected query-plan regression occurs, disable the optional parameter in clients and compare cold/warmed plan artifacts.
- Re-run the same measurement on a staging clone of the intended PostgreSQL 16/Neon environment, including production-like tenant sizes, skew, index bloat and latency. The local results do not establish production acceptance.
