# VaultBox production deployment

VaultBox v2.1.0 is deployed with **Render + Neon PostgreSQL + Upstash Redis**.

## Production contract

Render tracks the repository `main` branch with auto-deploy enabled.

The service start command is `npm start`. In v2.1.0 that script deliberately performs:

```text
prisma migrate deploy
node src/server.js
```

The API therefore does not bind its public port until committed Prisma migrations have been applied to Neon.

This is important because the existing Render build command installs production dependencies but does not itself run `prisma migrate deploy`.

## Required environment

At minimum production must provide:

- `DATABASE_URL`
- `JWT_SECRET`
- `REDIS_URL`
- `CORS_ORIGINS`

Upload/download controls can be tuned with:

- `MAX_UPLOAD_BYTES`
- `UPLOAD_CHUNK_BYTES`
- `UPLOAD_SESSION_EXPIRES_MINUTES`
- `UPLOAD_MAX_PARTS`
- `UPLOAD_SUGGESTED_PARALLEL_PARTS`
- `DOWNLOAD_TOKEN_EXPIRES_MINUTES`
- `DOWNLOAD_MAX_RANGES`
- `DOWNLOAD_SUGGESTED_PART_BYTES`

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

## v2.1.0 schema expectation

The production database must include migrations through:

```text
20260909051000_resumable_upload_sessions
```

That migration introduces durable upload session state and the user's `reservedUploadBytes` counter.

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
