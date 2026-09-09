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

`GET /upload-sessions/:id` reports uploaded and missing part numbers. After interruption, clients resend only missing parts rather than retransmitting the complete file.

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

## Ownership and abuse boundaries

- Authentication is required for every upload operation.
- Every session query is constrained by the authenticated user ID.
- User-controlled filenames are metadata only and never storage paths.
- Total file size, chunk size, part count, and session lifetime are server-bounded.
- Parallelism recommendations do not override global/route throttling.
- PostgreSQL is the source of truth for session/quota state; Redis is not required for durability.

## Storage-adapter boundary

The current deployed adapter stores final and temporary bytes on Render-local storage. The upload-session/part model is intentionally compatible with a future multipart object-storage adapter so the public protocol can remain stable when the byte-storage provider changes.
