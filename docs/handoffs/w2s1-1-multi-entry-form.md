# W2S1.1 — Multi-worker entry form

## Status

Implementation is in a dedicated worktree on `codex/w2s1-1-multi-entry-form`, based on `main` at `7cfa0477b23deed5425f54e35a8951d7d82e62a4`. Local verification passed. No commit, push, merge, migration apply, database access, or deployment has been performed.

## Scope delivered

- Added a form-first mode for entering multiple workers, while keeping the existing spreadsheet grid available as an alternate mode.
- Each worker row captures project, HRP/Vendor, recruiter/vendor, labor type, first work date, work status, name, phone, and national ID. Optional details are expandable and include bank details, notes, and other existing profile fields.
- Each row can select a worker portrait, front/back ID images or PDFs, and one employment contract image/PDF. No new document type or upload API was added.
- Saving accepts valid rows only. Invalid rows remain editable; files associated with saved rows remain in the current browser session and continue through the existing document upload components.
- Portraits continue through the W2S1 staging contract and are attached only to the matching valid row. Upload/recovery and cleanup remain delegated to the shared portrait-stage controller.

## Reuse decisions

- Reuses the existing spreadsheet row model, validation, catalog, date input, full-profile batch request, and worker portrait stage controller/slot.
- Reuses `DirectEntryCccdManager` for CCCD front/back and `DirectEntryDocumentEditor` for `EMPLOYMENT_CONTRACT`, including their existing authorization, upload, finalization, version, and retry behavior.
- Adds only the form surface, an in-memory queue to carry selected documents across initial worker creation, row-to-entry mapping, and focused tests. No new dependency, API route, RPC, schema, or migration.

## Important behavior / limits

- Selected files are held in browser memory until the worker row is saved and the existing document uploader accepts them. Closing/reloading the tab before upload completes can lose the local file selection; the UI warns before leaving while files remain.
- Existing upload permissions and draft lifecycle remain authoritative. If the newly-created entry cannot be edited in the current actor/scope/state, the file cannot be uploaded from this flow; the UI explains the state and links to the existing document surface where available.
- `EMPLOYMENT_CONTRACT` is the only contract/document type added to this form, as directed. AI extraction from CCCD is out of scope.
- The legacy grid remains available. The form does not introduce a separate business write path.

## Verification

- `pnpm test:p1.6-i04c3-r3a`: 181/181 pass.
- `pnpm test:w2-s1-worker-portrait-ui`: 81/81 pass.
- `pnpm test`: completed successfully across the repository test chain; no failures or skips were reported.
- `pnpm typecheck`: pass.
- `pnpm lint`: pass, 0 errors; 12 warnings in existing files.
- `pnpm build`: pass.
- `pnpm docs:check`: 6/6 pass.
- `git diff --check`: pass.
- `pnpm secrets:check`: not run; required external `C:\CodeApp\supabase-bi.txt` is absent in this workspace.
- Real-device UAT, screen-reader testing, contrast review, and touch-target verification remain outstanding.
- Malformed success-response handling is fail-closed: rows the server confirmed as saved are removed from the editable queue even if returned entry IDs cannot be mapped, preventing duplicate creation; files must then be attached from the existing worker documents surface after reload.

## Reaper schedule status

The repository already has `.github/workflows/w2s1-staging-portrait-stage-reaper.yml`: hourly schedule, staging-only guard, and 24-hour expiry policy. The workflow is disabled unless repository variable `W2S1_STAGING_REAPER_ENABLED` is exactly `true` and requires these secrets in the `w2s1-staging-reaper` GitHub environment: `W2S1_STAGING_SUPABASE_URL`, `W2S1_STAGING_SUPABASE_SECRET_KEY`, `W2S1_STAGING_R2_ACCOUNT_ID`, `W2S1_STAGING_R2_BUCKET_NAME`, `W2S1_STAGING_R2_ACCESS_KEY_ID`, and `W2S1_STAGING_R2_SECRET_ACCESS_KEY`.

Read-only inspection found no repository Actions variables and no `w2s1-staging-reaper` environment yet. The Vercel `mini-bi` Preview environment lists the required staging/preview variable names, but Vercel CLI reports secret values cannot be pulled. Therefore no GitHub secret or variable has been created, and the reaper has not been enabled or run. Do not substitute repository-wide generic R2 credentials: their target bucket has not been verified as the preview bucket. Complete environment secret provisioning from the authorized staging/preview settings, verify the exact Supabase ref `oyykqfxkyqhxgrfntokl` and R2 bucket `hrp-bi-preview`, then set repository variable `W2S1_STAGING_REAPER_ENABLED=true` to enable the workflow. Never use Production/VPS credentials or buckets.

## Manual UAT checklist before closing S1.1

1. On desktop and phone, switch between form and grid without losing entered values; add/remove multiple workers and verify row-specific fields/files stay with the correct worker.
2. Enter one valid and one invalid row; save and verify only the valid worker is created, the invalid row remains, and no success is shown for a failed row.
3. Upload a portrait, both CCCD sides, and an employment contract; verify each document appears on the intended worker and can be retried after a transient failure without changing worker association.
4. Verify draft/edit permissions, version conflict, retry, skip-CCCD path, and contract continuation; ensure unauthorized rows do not gain an upload path.
5. Keyboard-only: reach every field/action in logical order, operate native selects/file inputs, identify required fields/errors, and confirm visible focus. At 200% zoom and narrow viewport, confirm no clipped controls or horizontal page overflow.
6. Screen reader and contrast check: labels, required markers, per-row errors, upload status, save/retry announcements, and touch targets. Record device/browser and results.
