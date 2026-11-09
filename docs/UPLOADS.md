# VaultBox upload protocols

VaultBox v2.1.0 supports both compatible one-shot uploads and durable resumable uploads. Both paths stream bytes, keep memory bounded, hash while data is moving, and enforce quota against persistent PostgreSQL state.

## Choose a protocol

| Use case | Protocol |
| --- | --- |
| Small/simple upload, client can retry whole file | `POST /files/upload` |
| Small/simple upload with known exact size | `POST /files/upload` + `x-upload-size` |
| Large file, unstable network, pause/resume, partial retry | resumable upload session |

## One-shot upload

`POST /files/upload` accepts one multipart file.

### Early quota admission

Clients that know the exact file byte count should send:

```http
x-upload-size: 8388608
```

`x-upload-size` is the exact **file payload** size in bytes, not the multipart request `Content-Length`.

When present, VaultBox atomically reserves that amount against the user's current plan before reading the multipart file or opening a storage file. If the plan cannot admit the declared bytes, the request returns `413` before full network, hashing, and disk work is spent.

The declaration never replaces server measurement. The streamed byte count remains authoritative.

| Condition | Result |
| --- | --- |
| Declared size exceeds configured max | `400` |
| Declared bytes cannot fit current quota | `413` before storage write |
| Stream is shorter than declaration | `422`, temporary bytes deleted, reservation released |
| Stream exceeds declaration | bounded/truncated, `413`, temporary bytes deleted, reservation released |
| Parser/pipeline/database failure | reservation released; partial bytes removed when created |
| Success | reservation converted to `storageUsed` atomically with `File` creation |

Clients that omit `x-upload-size` keep the compatibility behavior: VaultBox streams the file first, measures it, then performs the authoritative atomic final quota check.

### Durable reservations and crash recovery

With `x-upload-size`, the pending quota is owned by a durable `UploadReservation` row (`PENDING` → `COMMITTED` | `RELEASED`) created **in the same transaction** as the quota increment, so a crash can never leave one without the other. While the body streams, a heartbeat renews the row's lease every third of `UPLOAD_RESERVATION_LEASE_SECONDS` (default 120). The measured upload is committed in one transaction that moves the row `PENDING → COMMITTED` by compare-and-set, converts the reserved bytes into `storageUsed`, and creates the `File`.

Commit and release are each a compare-and-set on the row, and quota is only adjusted by the actor whose transition applied: duplicate or concurrent attempts cannot double-adjust counters, and a worker that stalled long enough to be swept gets a `409` at commit instead of consuming someone else's reserved bytes. If a worker is killed (SIGKILL, OOM, redeploy) at any point, its reservation stays held until the lease lapses; the shared sweeper (the same 5-minute job that expires upload sessions) then releases it exactly once, on any instance. Bytes already written to storage for a crashed upload are orphans; reconciling them is tracked in #55.

Clients without `x-upload-size` are unchanged: nothing is held across the stream, so there is nothing to leak.

**Rolling deploys.** Instances running the previous build still reserve in process memory with no durable row; if one of those is killed, its reservation cannot be recovered by this sweeper. Finish the rollout promptly, and see `docs/DEPLOYMENT.md` for how to check for pre-existing leaked reservations.

## Resumable upload

For large or interruption-prone transfers use:

- `POST /upload-sessions`
- `PUT /upload-sessions/:id/parts/:partNumber`
- `GET /upload-sessions/:id`
- `POST /upload-sessions/:id/complete`
- `DELETE /upload-sessions/:id`

### 1. Create a session

Send file metadata including:

- `originalName`
- `mimeType`
- `expectedSize`
- optional whole-file SHA-256 `checksum`

VaultBox atomically reserves `expectedSize` and returns:

- session ID
- fixed chunk size
- part count
- expiry
- suggested parallelism

The default recommendation is **8 MiB parts** and **4 parallel part requests** unless configuration overrides it.

### 2. Upload parts

Each part uses a stable zero-based `partNumber` and exact range geometry:

```http
Content-Range: bytes <start>-<end>/<total>
x-chunk-sha256: <optional sha256>
```

VaultBox validates that the supplied range matches the part number, configured chunk size, and expected total size. Parts are streamed directly to temporary storage while SHA-256 and byte counts are calculated.

The database uniqueness constraint on `(sessionId, partNumber)` prevents duplicate accepted parts. Replaying an identical part is idempotent; a conflicting retry is rejected.

### 3. Inspect and resume

`GET /upload-sessions/:id` (default `view=legacy`) reports uploaded and missing part numbers. After interruption, clients resend only missing parts rather than retransmitting the complete file.

For large uploads, use `GET /upload-sessions/:id?view=summary` for `uploadedCount` and `missingCount` without allocating a manifest. Use `?view=page&limit=100&afterPart=-1` for bounded, indexed pages of uploaded parts; advance the exclusive cursor using `partsPage.nextAfterPart` while `hasMore` is true. Each page is a consistent snapshot limited to 100 entries. New concurrent uploads may appear in later polls; completion always revalidates the authoritative database manifest. The default legacy response remains unchanged.

### 4. Complete

`POST /upload-sessions/:id/complete`:

1. atomically claims completion;
2. verifies that every expected part exists exactly once;
3. streams parts into final storage in deterministic order;
4. computes final SHA-256 while assembling;
5. verifies final byte count and optional client checksum;
6. creates one `File` record;
7. converts reserved bytes into committed storage exactly once.

The complete file is never concatenated in Node memory.

Concurrent completion requests cannot create two files or charge quota twice. A second request either observes the completed result or receives a conflict while another completion owns the state transition.

### 5. Abort and expiry

`DELETE /upload-sessions/:id` aborts unfinished work, removes temporary part bytes, and releases the quota reservation.

Expired/stale sessions are reconciled by cleanup so process interruption does not permanently leak reserved capacity.

### Session state machine and completion lease

```text
UPLOADING --claim--> COMPLETING --commit--> COMPLETED
    |  ^                 |
    |  +--relinquish/----+   (completer failed, or its lease lapsed and was recovered)
    |     recover
    +--abort--> ABORTED          UPLOADING --expiry--> EXPIRED
                                 COMPLETING --lease lapsed AND session expired--> EXPIRED
```

Every transition is a database-conditional update (compare-and-set on `status`), so exactly one actor wins each one.

**Completion lease and fencing.** Claiming `COMPLETING` stores a random `completionToken`, a `completionLeaseUntil` (default 120 s, `UPLOAD_COMPLETION_LEASE_SECONDS`) and increments `completionGeneration`. While assembling, the completer renews the lease every third of its duration. The final commit — quota conversion, `File` creation and the `COMPLETED` transition — is one transaction that requires the session to still be `COMPLETING` **with this request's token**. A completer that stalled and was recovered ("zombie") therefore cannot publish a file or charge quota, even if a newer completer is mid-assembly; its assembled bytes are deleted and it receives `409`. Assembly that merely takes longer than any fixed timeout is never reclaimed while heartbeats continue.

**Recovery.** Only sessions whose lease has *lapsed* are recovered (by the 5-minute cleanup sweep, or inline when the client retries `complete`). The token is cleared; a session still within its expiry returns to `UPLOADING` (its parts and reservation are kept so the client can retry), otherwise it becomes `EXPIRED` and its reservation is released exactly once.

**Lock acquisition order.** Every transaction that touches both tables locks rows in this order, which makes a lock cycle impossible:

1. the `User` row (`SELECT ... FOR UPDATE`), then
2. the `UploadSession` row.

This applies to the completion commit, abort, expiry and stale-completion recovery. Units of work that can still be chosen as a deadlock or serialization victim are retried a bounded number of times (4 attempts) with jittered exponential backoff; they are idempotent by construction.

### Part admission fence

A part body is streamed to storage *before* any database lock is taken, so no transaction is held across a network stream. The part only becomes visible in a short transaction that locks the session row `FOR SHARE`, re-checks that the session is still `UPLOADING` and unexpired, and inserts the `UploadPart` row.

Claiming completion, aborting and expiring all `UPDATE` the session row, which conflicts with `FOR SHARE`. So a part either commits before the session closes — and is then part of the frozen set completion reads *after* its claim — or it is rejected: `409` if the session was aborted/completing/completed, `410` if it expired. A rejected part's stored bytes are deleted immediately; any that remain (for example after a crash) are removed with the session's chunk directory by the terminal-session sweep. A writer whose chunk directory disappears mid-stream because the session closed also receives `409` rather than a server error.

Completion re-reads the part set after claiming the session and asserts it complete before assembling, and its missing-object repair deletes only the exact row/object pair that was found missing, so a part concurrently re-uploaded is never removed.

## Ownership and abuse boundaries

- Authentication is required for every upload operation.
- Every session query is constrained by the authenticated user ID.
- User-controlled filenames are metadata only and never storage paths.
- Total file size, chunk size, part count, and session lifetime are server-bounded.
- Parallelism recommendations do not override global/route throttling.
- PostgreSQL is the source of truth for session/quota state; Redis is not required for durability.
- A suspended or deleted account cannot create new usage even from a request that was already in flight: session creation, part storage, completion and the one-shot commit re-check `ACTIVE` under the owner's row lock and answer `403 ACCOUNT_NOT_ACTIVE` (bytes removed, reservation returned). Abort, expiry and reservation release always work (see `docs/DEPLOYMENT.md`).

## Storage-adapter boundary

The current deployed adapter stores final and temporary bytes on Render-local storage. The upload-session/part model is intentionally compatible with a future multipart object-storage adapter so the public protocol can remain stable when the byte-storage provider changes.

### Optional folder destination (draft #64)

An owned folder can be supplied at upload start (`x-folder-id` header for `POST /files/upload`, `folderId` JSON field for `POST /upload-sessions`). All ownership checks occur inside the transaction recording the file or session. When the destination folder is deleted while a resumable upload is pending, the session is retargeted to root; its eventual completion never writes a dangling folder reference. `PATCH /files/:id` accepts `folderId` to move an already stored file, including `null` for root. File moves never change quotas or object bytes.
