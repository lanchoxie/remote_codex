# Large File Transfer Design

## Current behavior

The small-file browser transfer path remains intentionally simple:

```text
browser FileReader -> base64 JSON -> relay -> host-agent -> target file
host-agent file -> base64 JSON event -> relay cache -> browser download
```

The default small-file request limit is 128 MiB for file payloads. The relay JSON
body limit is 192 MiB because base64 expands binary data by roughly one third
before JSON overhead is added.

Large upload and download now have a first chunked implementation. It still uses
the existing outbound host-agent polling channel, so each chunk is JSON/base64,
but only one bounded chunk is in memory at a time.

## Goals

- Support large upload and download without holding the whole file in memory.
- Keep the relay private-network friendly and dependency-light.
- Work for local PCs, remote Linux hosts, and HPC login nodes.
- Survive flaky mobile networks with resumable progress.
- Preserve the existing small-file API for simple attachments and previews.

## Non-goals

- Replace `scp`, `rsync`, shared filesystems, or object storage for large
  datasets that already live near the target host.
- Make the relay a public internet file server.
- Stream arbitrary host filesystem paths without authorization checks.

## Implemented Upload Flow

Large upload uses a session-based chunk protocol instead of one huge JSON body.

1. The browser calls `POST /api/hosts/:hostId/files/uploads` with file metadata:
   name, size, MIME type, session id, target directory, and preferred chunk size.
2. The relay creates an upload id and enqueues `host.file_upload_begin`.
3. The host-agent creates a temporary file under the same target filesystem:
   `.codex-remote-files/uploads/<session>/<uploadId>/<name>.part`.
4. The browser sends sequential chunks with
   `POST /api/hosts/:hostId/files/uploads/:uploadId/chunks`.
5. The relay forwards one chunk at a time to the host-agent with
   `host.file_upload_chunk` commands.
6. The browser calls `POST /api/hosts/:hostId/files/uploads/:uploadId/complete`.
7. The host-agent verifies total size, renames the `.part` file atomically, and
   emits `file.uploaded`.

Recommended defaults:

- Chunk size: 4 MiB.
- Parallel chunks: not enabled in the first implementation; chunks are
  sequential so the current polling channel stays bounded.
- Upload TTL: 24 hours for incomplete uploads.
- Max active uploads per host: 3.
- Max file size: 2 GiB by default through `*_MAX_CHUNKED_FILE_TRANSFER_BYTES`.

## Implemented Download Flow

Large download streams from host-agent to relay to browser using sequential range
chunk reads.

1. The browser keeps using
   `GET /api/hosts/:hostId/files/download?path=...&sessionId=...`.
2. The relay first asks the host-agent for `host.file_download_info`.
3. Small files keep the legacy cache path.
4. Files above the chunk threshold are streamed directly to the browser.
5. For each range, the relay enqueues `host.file_download_chunk`.
6. The host-agent reads only that byte range and emits `file.download.chunk`.
7. The relay decodes the chunk and writes it into the active HTTP response.

This avoids caching large files in `tmp/received-files`. HTTP Range resume is
still future work.

## Protocol additions

Host-agent commands:

- `host.file_upload_begin`
- `host.file_upload_chunk`
- `host.file_upload_complete`
- `host.file_upload_abort`
- `host.file_download_info`
- `host.file_download_chunk`

Relay HTTP routes:

- `POST /api/hosts/:hostId/files/uploads`
- `POST /api/hosts/:hostId/files/uploads/:uploadId/chunks`
- `POST /api/hosts/:hostId/files/uploads/:uploadId/complete`
- `DELETE /api/hosts/:hostId/files/uploads/:uploadId`
- `GET /api/hosts/:hostId/files/download?path=...`

Events:

- `file.upload.ready`
- `file.upload.chunk`
- `file.uploaded`
- `file.download.info`
- `file.download.chunk`
- `file.error`

## Safety checks

- Keep all writes inside the resolved upload directory.
- Write to `.part` files and rename only after verification succeeds.
- Reject path traversal, ambiguous bare download paths, directories, symlinks
  that escape the allowed workspace, and files changing during download unless
  the user explicitly refreshes the handle.
- Rate-limit active transfers per relay and per host.
- Clean incomplete `.part` files on abort; TTL cleanup is future work.
- Keep the current 128 MiB JSON/base64 path for previews and small attachments,
  but route larger files through chunked transfer only.

## UI behavior

- Composer uploads use the chunked path and show progress on the attachment chip.
- Downloads keep the existing Open/Save buttons and stream large files on demand.
- The chat transcript should include the final file reference, not every chunk.

## Implementation sequence

1. Add HTTP Range support for resumable browser downloads.
2. Add TTL cleanup for abandoned upload `.part` files.
3. Add optional SHA-256 verification.
4. Add pause/resume/retry controls in the upload UI.
5. Add managed-session smoke tests for abort, resume, and range download.
