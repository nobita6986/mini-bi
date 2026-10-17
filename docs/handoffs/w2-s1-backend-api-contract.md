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

The route returns the image bytes directly (JPEG or PNG), not a storage key or signed URL. It requires the authenticated session, `document_view`, the existing server-side entry read scope or (only for portrait preview) the exact `entry_privileged_edit` capability and matching entry scope, and a current accepted portrait. `download` always remains guarded by `direct_entry_assert_draft_access`; project-manager read scope does not grant CCCD/contract download. The server checks lifecycle, size, content signature, and SHA-256 before returning `private, no-store` bytes.

The generic `/download` route deliberately does not issue portrait signed URLs. Clients should use the `current.document_id` from the entry projection and the private `/preview` route.

## Snapshot

Entry revision snapshots now include portrait origin and the accepted current `(document_id, version, checksum_sha256, mime_type, size_bytes)` tuple. These values are server-derived and are not accepted from client payloads.

## Migration ledger and authorization repair

Migration checksums below use the repository's `migrationChecksum()` from `scripts/lib/migration-validation.mjs` (SHA-256 after LF newline normalization), not the hash of raw checkout bytes:

- #111 `20261017100000_pre_w2_s1_worker_portrait_private_projection.sql`: `7e19aecfb9417645a80120704be790d67a13986788a777cac30c7b62de8c66ff`
- #112 `20261017110000_pre_w2_s1_document_direct_context_access_guard.sql`: `82607beb7157d90e6aeea0e667715e1ae1ca73ed76e801f15d32cffe4dcba8cd`

Migration #111 remains unchanged. Append-only migration #112 reasserts the `document_direct_context` authorization on databases where the previously published #111 body may already have been applied: every `download` uses `direct_entry_assert_draft_access`; only `preview` of a `WORKER_PORTRAIT` can use the scoped `entry_privileged_edit` fallback. The migration fails closed on unexpected function-source drift; offline PGlite regressions cover repair of the earlier #111 function body and rollback on a `55000` drift failure.

Validation status for the follow-up commit: the full `pnpm test` chain, PostgreSQL targets, and `pnpm build` have not been rerun at this commit. They passed on parent commit `26324596d5929d305077b3ef37f191dea181fbab` (`pnpm test`: 3,354/3,354; PostgreSQL: 2/2; build: pass). No real database migration or deployment was performed.

## Changed files

- `supabase/migrations/20261017100000_pre_w2_s1_worker_portrait_private_projection.sql` — immutable migration #111 for portrait lifecycle/projection/snapshot; its reviewed checksum is retained.
- `supabase/migrations/20261017110000_pre_w2_s1_document_direct_context_access_guard.sql` — append-only migration #112 to ensure download and portrait-preview authorization remains correctly scoped.
- `src/app/api/direct-entry/entries/[entryId]/documents/[documentId]/preview/route.ts` — private portrait preview route.
- `src/lib/contracts/direct-entry-v1.ts` — direct-entry portrait document type.
- `src/lib/direct-entry/document-api.ts`, `document-upload-contract.ts`, `document-r2-contract.ts`, `r2-document-storage.ts`, `document-finalize-api.ts`, `write-api.ts`, and `write-repository.ts` — existing upload/finalize/read pipeline integration, sanitized storage promotion, and preview.
- `src/lib/direct-entry/worker-portrait-sanitizer.ts` — server-side image decode/re-encode and metadata stripping.
- `src/lib/direct-entry/document-api.test.mjs`, `document-repository.test.mjs`, `r2-document-storage.test.mjs`, `write-api.test.mjs`, `worker-portrait-sanitizer.test.mjs`, `scripts/w2-s1-backend-db.test.mjs`, and `scripts/w2-s1-migration-112.test.mjs` — API, repository, storage, sanitizer, migration, and authorization regressions.
- `package.json` and `pnpm-lock.yaml` — Sharp dependency and focused W2-S1 backend test command.
- `docs/handoffs/w2-s1-backend-api-contract.md` — this integration contract.
