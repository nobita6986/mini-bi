# W2S1.1 — Multi-worker entry form

## Status

The form-first entry and card-grid UI were merged through PRs #64 and #65. The latest main snapshot also includes immediate private staging for portrait, CCCD front/back, and employment contract through migrations #117–#119. This handoff does not declare W2S1.1 closed: real-device UAT and accessibility checks remain outstanding. Hotfix migration #120 has been merged through PR #68 but has not yet been applied to the authorized staging database. No Production database access or deployment was performed for this reaper-policy update.

## Scope delivered

- Added a form-first mode for entering multiple workers, while keeping the existing spreadsheet grid available as an alternate mode.
- Each worker row captures project, HRP/Vendor, recruiter/vendor, labor type, first work date, work status, name, phone, and national ID. Optional details are expandable and include bank details, notes, and other existing profile fields.
- Each row can select a worker portrait, front/back ID images or PDFs, and one employment contract image/PDF. Selecting a file immediately uploads it to a private server-side draft stage; the batch request carries only typed stage IDs, never file bytes or storage keys.
- Saving accepts valid rows only. In the same save operation, matching staged documents are claimed with the worker row and promoted through the existing document reserve/finalize pipeline. There are no separate post-save “upload front/back/contract” steps.
- Stage-to-row binding, cancellation, stale-response cleanup, retry with the same file and idempotency key, and late-response orphan cleanup use the shared stage controller. Replacing a staged file preserves the prior stage ID for cleanup.
- The form keeps the requested status choices (`Đang làm` and `Đang chờ việc`) and defaults new rows to `Đang làm`.

## Reuse decisions

- Reuses the existing spreadsheet row model, validation, catalog, date input, full-profile batch request, private stage storage, stage lifecycle, and document reserve/finalize pipeline.
- Reuses existing document type allow-lists, content-signature inspection, actor/session capability, entry scope, OCC, and worker detail/read projections. The staging route is extended for the three existing document types; it does not add a second upload route.
- Adds typed stage references to the existing full-profile payload and append-only migrations #117–#119 for the bounded worker-detail read audience, typed private stages, and the four-document-per-row bound. `EMPLOYMENT_CONTRACT` remains the only contract type. No new third-party dependency beyond the Supabase CLI already requested for the migration workflow.

## Important behavior / limits

- During an upload retry the same selected `File` and idempotency key are retained in browser memory. If the page is closed before a stage ID is known, server-side TTL cleanup is still required; if a known stage is abandoned, the controller attempts cancellation and the reaper remains the backstop.
- Existing upload permissions and draft lifecycle remain authoritative. Stage creation and claim require the server-resolved upload capability; row association is checked against the authenticated actor and the full-profile batch contract.
- `EMPLOYMENT_CONTRACT` is the only contract/document type added to this form, as directed. AI extraction from CCCD is out of scope.
- The legacy grid remains available. The form does not introduce a separate business write path.

## Verification

- Canonical `migrationChecksum()` (SHA-256 over LF-normalized SQL): #117 `ded61507914c82f823b04f3db02e6c72b90887ffe27826333bd7406a5829f83e`, #118 `242d7c6a8e908526ea818bc5dd8278578c401dcf5a7f033040f08f18179feb3c`, #119 `6fa105b36ceb519d6b274e8844dce4a1df82ca9de9884bb042086126b7ef505f`.
- `pnpm test:p1.6-i04c3-r3a`: 181/181 pass.
- `pnpm test:w2-s1-worker-portrait-ui`: 84/84 pass.
- `pnpm test:w2-s1-backend`: 89/89 pass, including offline PGlite migration and stage recovery/concurrency tests.
- `pnpm test:p1.6-i04c3-s01`: 52/52 pass, including current migration/RPC inventory assertions.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build`: pass on the current source snapshot; this continuation changed test assertions and this handoff only.
- Canonical `pnpm test` chain: every lane has passed in ordered segments after repairing stale migration-order/count and source assertions. The final segment completed through `pnpm test:w2-s1-backend` and `pnpm test:w2-s1-worker-portrait-ui`; it was not one uninterrupted final `pnpm test` invocation.
- Additional repaired legacy lanes passed individually: P3.1 W01D-A1b1 leader-read, W03A lifecycle, W02B vendor catalog, W02C-R2 labor-type display, and W02C-R3 own-draft display. These were assertion updates for the append-only 119-migration ledger; no application behavior or migration SQL was changed by the repairs.
- `pnpm docs:check`: 6/6 pass.
- `git diff --check`: pass for the documentation update and merge resolution.
- Real-device UAT, screen-reader testing, contrast review, and touch-target verification remain outstanding.
- Malformed success-response handling is fail-closed: rows the server confirmed as saved are removed from the editable queue even if returned entry IDs cannot be mapped, preventing duplicate creation; files must then be attached from the existing worker documents surface after reload.

## Reaper schedule status

Owner decision (2026-10-19): do not configure or run a reaper for Vercel Preview. Leave `.github/workflows/w2s1-staging-portrait-stage-reaper.yml` disabled and do not provision a Vercel-target GitHub environment, secrets, or enablement variable. W2S1.1 upload/save remains functional without the schedule; abandoned stage objects in the test bucket will not be removed automatically, which is accepted for this low-volume test environment. Do not use a broad bucket purge as a substitute.

T0 operations check on 2026-10-19: the authorized Vercel staging DB ref is `oyykqfxkyqhxgrfntokl`; the Preview URL/key claims and `hrp-bi-preview` bucket were verified without connecting to the DB. The GitHub reaper environment and variable remain absent, and no R2 credentials were copied to GitHub. This check preceded the Owner decision above; the Preview reaper stays disabled.

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

- 2026-10-19 — T0 continuation: documented immediate server-side draft staging for portrait, CCCD front/back, and employment contract; same-batch attachment of valid rows; migrations #117–#119; same-key retry and replacement-stage cleanup. Repaired stale ledger assertions; canonical test lanes passed in ordered segments. The authorized Vercel staging ref and Preview variables were checked without a DB connection. The GitHub reaper environment/variable remain absent; no R2 credentials were copied to GitHub. Owner later decided not to enable the Preview reaper.
- 2026-10-19 — Owner decision: Vercel Preview does not need a configured reaper; its scheduled workflow remains disabled. Added the VPS release requirement for a separate hourly `systemd` timer and explicit per-environment target guards. The existing runner remains staging-only and cannot be pointed at Production. No database access, migration apply, or deployment was performed for this reaper-policy change.
