# W2S1.1 — Multi-worker entry form

## Status

The form-first entry and card-grid UI were merged through PRs #64 and #65. This handoff does not declare W2S1.1 closed: real-device UAT and accessibility checks remain outstanding. No migration was applied and no database was accessed by those PRs. CI created Vercel Preview deployments; no Production deployment was performed.

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
- `pnpm secrets:check`: not run as part of this documentation-only reaper decision update.
- Real-device UAT, screen-reader testing, contrast review, and touch-target verification remain outstanding.
- Malformed success-response handling is fail-closed: rows the server confirmed as saved are removed from the editable queue even if returned entry IDs cannot be mapped, preventing duplicate creation; files must then be attached from the existing worker documents surface after reload.

## Reaper schedule status

Owner decision (2026-10-19): do not configure or run a reaper for Vercel Preview. Leave `.github/workflows/w2s1-staging-portrait-stage-reaper.yml` disabled and do not provision a Vercel-target GitHub environment, secrets, or enablement variable. W2S1.1 upload/save remains functional without the schedule; abandoned stage objects in the test bucket will not be removed automatically, which is accepted for this low-volume test environment. Do not use a broad bucket purge as a substitute.

VPS deployment requirement: before enabling W2S1 staged document uploads on a persistent VPS, deploy a dedicated scheduled reaper there. Preferred host arrangement is a separate `systemd` oneshot service plus an hourly `systemd` timer, independent of web requests. Run it as a restricted service account with environment credentials stored outside the repository and readable only by that account. The job claims only `STAGED` items older than the 24-hour TTL, deletes the corresponding temporary object, and records cleanup completion; `CLAIMED` and `ATTACHED` stages and worker/business records must never be reaped. Failed cleanup must remain retryable and observable in logs/monitoring.

The current runner and target guard are staging-only: they require Supabase ref `oyykqfxkyqhxgrfntokl` and bucket `hrp-bi-preview`. They are not production/VPS-ready and must fail closed on other targets. Before any VPS activation, add and test an explicit environment-specific target allowlist for that VPS's exact Supabase ref and R2 bucket, with separate credentials and timer configuration for `bi-test` versus Production. Never share or substitute credentials/buckets across environments. Enable the timer only after the matching release/migrations are installed and a controlled run confirms the expected target and cleanup result.

## Manual UAT checklist before closing S1.1

1. On desktop and phone, switch between form and grid without losing entered values; add/remove multiple workers and verify row-specific fields/files stay with the correct worker.
2. Enter one valid and one invalid row; save and verify only the valid worker is created, the invalid row remains, and no success is shown for a failed row.
3. Upload a portrait, both CCCD sides, and an employment contract; verify each document appears on the intended worker and can be retried after a transient failure without changing worker association.
4. Verify draft/edit permissions, version conflict, retry, skip-CCCD path, and contract continuation; ensure unauthorized rows do not gain an upload path.
5. Keyboard-only: reach every field/action in logical order, operate native selects/file inputs, identify required fields/errors, and confirm visible focus. At 200% zoom and narrow viewport, confirm no clipped controls or horizontal page overflow.
6. Screen reader and contrast check: labels, required markers, per-row errors, upload status, save/retry announcements, and touch targets. Record device/browser and results.

## Revision log

- 2026-10-19 — Owner decision: Vercel Preview does not need a configured reaper; its staging-only scheduled workflow remains disabled. Added VPS release requirement for a separate hourly `systemd` timer and explicit per-environment target guards. The existing runner remains staging-only and cannot be pointed at Production. No database access, migration apply, or deployment was performed for this documentation change.
