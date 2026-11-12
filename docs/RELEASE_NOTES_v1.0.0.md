# VaultBox API v1.0.0 — Initial Production Release

**Published:** 2026-06-18. [Original GitHub release](https://github.com/wbizmo/vaultbox-api/releases/tag/v1.0.0). These are historical notes, not a claim that the v1 implementation remains deployed unmodified.

VaultBox first introduced JWT registration/login, bcrypt password hashing, role-based access control, storage plans, subscriptions, quota enforcement and usage reporting. It supported uploading, listing and deleting files, checksums, upload audits; folder create/list/update/delete; expiring download tokens; administrative user lifecycle, storage reports, audit records, billing failure simulation, health/infrastructure checks, rate limiting and Swagger/OpenAPI.

The initial production stack used Render, Neon PostgreSQL and Upstash Redis. The 2.x releases retain these high-level capabilities while strengthening security, transfer durability, concurrency and operational behavior. See [v2.0.0](./RELEASE_NOTES_v2.0.0.md) onward for changes.

**Credential hygiene:** The historical release description included sample demo credentials. Do not reuse those values or treat them as valid production secrets. Rotate any matching real credentials and seed demos only in isolated environments.
