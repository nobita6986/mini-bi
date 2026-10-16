# W2-S1 Backend API Contract

This contract is for T1A/T1C integration. It extends the existing direct-entry document flow; it does not introduce a second storage or upload pipeline.

## Portrait upload

Use the existing endpoints:

1. `POST /api/direct-entry/entries/{entryId}/documents` with `document_type: "WORKER_PORTRAIT"`, `mime_type: "image/jpeg" | "image/png"`, `size_bytes`, `expected_entry_version`, and the existing idempotency header.
2. PUT the bytes to the returned presigned upload URL using its returned headers.
3. `POST /api/direct-entry/entries/{entryId}/documents/{documentId}/finalize` with `expected_entry_version`.

The normal document upload capability, entry/submission scope, lifecycle, optimistic concurrency, audit, and idempotency checks still apply. The server decodes and re-encodes portraits before promotion, stripping EXIF and other source metadata. The database checksum and size identify the sanitized final bytes, not the uploaded source bytes. PDF is not accepted for portraits.

## Read projection

`GET /api/direct-entry/entries/{entryId}` adds `worker_portrait` without changing the generic `documents` projection:

```json
{
  "origin": "ENROLLMENT | LEGACY_ADDED | null",
  "added_at": "ISO-8601 timestamp | null",
  "status": "MISSING | QUEUED | UPLOADING | QUARANTINED | SCANNING | READY | FAILED | SUPERSEDED",
  "current": {
    "document_id": "uuid",
    "version": 1,
    "checksum_sha256": "64 lowercase hex characters",
    "mime_type": "image/jpeg | image/png",
    "size_bytes": 1
  }
}
```

`current` is `null` when no accepted current version exists. `origin` is set by the server only after a portrait is accepted: `ENROLLMENT` when the first accepted version is finalized in a `DRAFT` submission; otherwise `LEGACY_ADDED`, with server time in `added_at`. Replacements do not change the original origin. The object reports the latest upload lifecycle status separately from the last accepted `current` version.

When the actor lacks `document_view`, `worker_portrait` is `null`; portrait data is not copied into the generic `documents` array.

## Private portrait bytes

Read the portrait from:

`GET /api/direct-entry/entries/{entryId}/documents/{documentId}/preview`

The route returns the image bytes directly (JPEG or PNG), not a storage key or signed URL. It requires the authenticated session, `document_view`, the existing server-side entry read scope or exact `entry_privileged_edit` scope, and a current accepted portrait. The server checks lifecycle, size, content signature, and SHA-256 before returning `private, no-store` bytes.

The generic `/download` route deliberately does not issue portrait signed URLs. Clients should use the `current.document_id` from the entry projection and the private `/preview` route.

## Snapshot

Entry revision snapshots now include portrait origin and the accepted current `(document_id, version, checksum_sha256, mime_type, size_bytes)` tuple. These values are server-derived and are not accepted from client payloads.

## Changed files

- `supabase/migrations/20261017100000_pre_w2_s1_worker_portrait_private_projection.sql` — append-only DB changes for portrait lifecycle/projection/snapshot and the narrowly scoped privileged-edit read fallback.
- `src/app/api/direct-entry/entries/[entryId]/documents/[documentId]/preview/route.ts` — private portrait preview route.
- `src/lib/contracts/direct-entry-v1.ts` — direct-entry portrait document type.
- `src/lib/direct-entry/document-api.ts`, `document-upload-contract.ts`, `document-r2-contract.ts`, `r2-document-storage.ts`, `document-finalize-api.ts`, `write-api.ts`, and `write-repository.ts` — existing upload/finalize/read pipeline integration, sanitized storage promotion, and preview.
- `src/lib/direct-entry/worker-portrait-sanitizer.ts` — server-side image decode/re-encode and metadata stripping.
- `src/lib/direct-entry/document-api.test.mjs`, `document-repository.test.mjs`, `r2-document-storage.test.mjs`, `write-api.test.mjs`, `worker-portrait-sanitizer.test.mjs`, and `scripts/w2-s1-backend-db.test.mjs` — API, repository, storage, sanitizer, migration, and authorization regressions.
- `package.json` and `pnpm-lock.yaml` — Sharp dependency and focused W2-S1 backend test command.
- `docs/handoffs/w2-s1-backend-api-contract.md` — this integration contract.
