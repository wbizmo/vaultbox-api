# Upload protocols

VaultBox supports both compatible one-shot uploads and durable resumable uploads.

## One-shot upload

`POST /files/upload` accepts one multipart file.

Clients that know the exact file byte count should send:

```http
x-upload-size: 8388608
```

`x-upload-size` is the exact file payload size in bytes, not the multipart request `Content-Length`. When present, VaultBox atomically reserves that amount against the user's current plan **before reading or writing the multipart file body**. If the plan cannot admit the declared bytes, the request returns `413` without creating a storage file.

The streamed byte count remains authoritative. A body shorter than the declaration returns `422`; a body larger than the declaration is truncated at the declared boundary and returns `413`. Both paths delete temporary bytes and release the reservation. Pipeline/parser failures also release it. On success the same transaction that creates the `File` record converts reserved bytes to `storageUsed`.

Clients that omit `x-upload-size` keep the compatibility behavior: VaultBox streams the file first, measures it, then performs the existing atomic final quota check. This path remains supported for clients that cannot know the file size in advance.

## Resumable upload

For large or interruption-prone transfers use:

- `POST /upload-sessions`
- `PUT /upload-sessions/:id/parts/:partNumber`
- `GET /upload-sessions/:id`
- `POST /upload-sessions/:id/complete`
- `DELETE /upload-sessions/:id`

The resumable protocol reserves the full expected size at session creation, uses fixed non-overlapping byte ranges, hashes every part while streaming, assembles without whole-file buffering, verifies final size/checksum, and charges quota exactly once on completion. See the Swagger documentation for the route schemas and `README.md` for the recommended chunk size and concurrency.
