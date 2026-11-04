# VaultBox API v2.1.1 — Node.js Security Maintenance Release

Out-of-band patch release (issue #67). No API, behavior, or database schema changes.

## Security

- **Node.js runtime 24.19.0 → 24.22.2** (Node.js 24 LTS). Includes the 2026-10-21 security release (24.22.1) covering, among others, CVE-2026-111497 (Brotli), CVE-2026-105482 (DNS `resolve*` NUL-byte truncation), CVE-2026-105483 / CVE-2026-106069 / CVE-2026-106072 (TLS / IP normalization and validation), CVE-2026-105481 (HTTP agent) and CVE-2026-106074 (crypto random cache). Minimum security-fixed baseline: `24.22.1`.
  - Exploitability of each CVE in VaultBox depends on whether the affected API is reachable; no exploitation is asserted.
- **Dependency refresh (lockfile only).** `npm audit --audit-level=high` had begun failing on the v2.1.0 lockfile (advisories for `fast-jwt`, `fastify`, `@fastify/busboy`, `fast-uri`, `brace-expansion`). In-range updates were applied with `npm audit fix`; `package.json` ranges are unchanged. Two moderate dev-tool-only findings (`nodemon` → `minimatch`) remain; the only fix is a breaking downgrade of nodemon and they do not affect the production runtime.

## Operational changes

- CI asserts `node --version` equals `.node-version`.
- The release workflow is no longer hardcoded to v2.1.0: it reads the version from `package.json`, requires `docs/RELEASE_NOTES_vX.Y.Z.md`, and runs only after CI succeeded on the exact commit. (Full release hardening remains tracked in #62.)

## Upgrade requirements

- Render: ensure no `NODE_VERSION` environment override pins an older Node; verify the effective version after deploy.
- No migrations.

## Rollback

No data rollback is needed. Do not return to Node 24.19.0; roll back to a previous commit with the `.node-version` pin kept at `24.22.2` or later.
