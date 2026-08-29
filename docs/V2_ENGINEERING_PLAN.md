# VaultBox v2 Engineering Plan

## Goal

Evolve VaultBox from a compact storage API into a production-oriented transfer service without replacing the current deployment providers: Render, Neon PostgreSQL, and Upstash Redis.

## Audit summary

The current API has a clear Fastify/Prisma foundation, but several v1 design choices limit reliability and scale:

- Redis lifecycle wiring regressed after the TLS refactor and health checks do not interrogate the exported client correctly.
- Uploads are written to local disk and then reread completely to calculate SHA-256, doubling disk I/O and creating avoidable memory pressure for large files.
- Quota checks and storage usage updates are not atomic, so concurrent uploads can race.
- Download tokens are plaintext, one-use records that are consumed before the stream completes.
- Downloads do not support HTTP byte ranges, ETags, HEAD requests, or resumability.
- File and administrative listings are unbounded.
- Authentication trusts JWT claims for account state after issuance; suspended users can reach routes that do not re-check the database.
- Production can fall back to a development JWT secret.
- CORS accepts every origin.
- There is no automated test, benchmark, or CI pipeline.
- The local filesystem storage backend is ephemeral on many Render configurations and is not horizontally shareable.

## Provider-preserving architecture

### Render

Keep Render as the application runtime. The v2 server remains stateless with respect to sessions and rate-limit state where possible. Local file storage is wrapped behind a storage adapter so the current deployment continues to work while making a future durable object-store migration non-invasive.

### Neon PostgreSQL

Keep Neon as the source of truth for users, plans, metadata, transfer sessions, audit records, and quota accounting. Add indexes for ownership and time-ordered access patterns. Use transactions for quota and metadata state transitions.

### Upstash Redis

Keep Upstash Redis for low-latency ephemeral coordination: distributed auth throttling, download metadata cache, idempotency state, transfer capability caching, and operational health telemetry. Redis failures must degrade safely rather than corrupt persistent state.

## Transfer engine

### Resumable downloads

VaultBox v2 uses standard HTTP range semantics:

- `Accept-Ranges: bytes`
- `Range: bytes=start-end`
- `206 Partial Content`
- `Content-Range`
- strong ETags derived from stored SHA-256
- `If-Range` support
- `HEAD` requests for size, type, ETag, and range capability discovery

A short-lived download session may be reused for range requests until expiry. Clients can split a file into independent byte segments and download several segments concurrently. If the network disconnects, completed segments remain valid and the client can request only missing ranges.

### Fast path

The API streams directly from storage to the response. It does not buffer whole files in application memory. Upload hashing is performed incrementally while bytes are written, eliminating the v1 full-file reread.

### Safety

Range parsing is strict and bounded. Invalid or unsatisfiable ranges return `416 Range Not Satisfiable`. Download credentials are stored as hashes rather than plaintext secrets. Every transfer remains ownership-checked and account-state-aware.

## Reliability work

- explicit Redis startup and graceful shutdown
- readiness and liveness separation
- dependency latency measurements
- fail-closed production configuration
- standardized errors and request IDs
- atomic quota accounting
- bounded pagination
- plan downgrade safety
- folder deletion semantics that do not strand files
- active-account enforcement on every authenticated request
- idempotency primitives for mutation endpoints

## Security work

- no production JWT fallback secret
- normalized email identities
- stronger password policy
- configurable CORS allowlist
- defensive response headers
- hashed download credentials
- route-specific distributed authentication throttling
- audit records for security-sensitive operations
- safer file naming and content-disposition handling

## Observability and engineering evidence

The repository will include repeatable benchmarks rather than hand-written marketing numbers. Benchmark output records runtime version, request count, concurrency, p50/p95/p99 latency, requests per second, and error count. README performance figures are updated only from reproducible benchmark results and must state the benchmark environment.

## Upgrade order

1. Repair Redis and runtime lifecycle.
2. Harden configuration and authentication boundaries.
3. Introduce common utilities, error handling, request timing, and metrics.
4. Introduce a storage adapter and streaming upload path.
5. Make quota and metadata transitions atomic.
6. Replace one-shot downloads with resumable range-capable download sessions.
7. Add Redis-backed coordination and caching with safe fallbacks.
8. Bound and index all list/report paths.
9. Add automated tests, CI, and benchmark evidence.
10. Update OpenAPI and README with measured capabilities and migration notes.

## Non-goals for this provider-preserving release

- Replacing Render, Neon, or Upstash.
- Claiming CDN-grade global edge throughput while bytes originate from a single Render service.
- Pretending local Render storage is equivalent to durable multi-region object storage.

Those are infrastructure choices that can be added later through the storage adapter without redesigning the API surface.
