# W2S1.1 — Multi-worker entry form

## Status

T0 tiếp tục W2S1.1 trên checkout `main` hiện tại tại `e75a778`; chưa tạo commit, push hay merge cho phần tiếp tục này. Các thay đổi cục bộ có sẵn được giữ nguyên. Phần WIP hiện có ba migration append-only #117–#119: #117 mở rộng đúng các audience đọc chi tiết đã có trong danh sách NLĐ; #118 mở rộng stage có kiểu cho CCCD/hợp đồng; #119 giới hạn số stage theo batch. Chúng và kiểm thử mới chỉ được kiểm tra offline/PGlite, không kết nối hoặc apply lên DB thật nào. Không deploy.

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
- `git -c core.whitespace=cr-at-eol diff --check`: pass. Plain local `git diff --check` reports only the CRLF terminators on two changed lines in `src/lib/direct-entry/r2-document-storage.ts`; the source file uses CRLF and has no trailing spaces.
- Real-device UAT, screen-reader testing, contrast review, and touch-target verification remain outstanding.
- Malformed success-response handling is fail-closed: rows the server confirmed as saved are removed from the editable queue even if returned entry IDs cannot be mapped, preventing duplicate creation; files must then be attached from the existing worker documents surface after reload.

## Reaper schedule status

The repository already has `.github/workflows/w2s1-staging-portrait-stage-reaper.yml`: hourly schedule, staging-only guard, and 24-hour expiry policy. The workflow is disabled unless repository variable `W2S1_STAGING_REAPER_ENABLED` is exactly `true` and requires these secrets in the `w2s1-staging-reaper` GitHub environment: `W2S1_STAGING_SUPABASE_URL`, `W2S1_STAGING_SUPABASE_SECRET_KEY`, `W2S1_STAGING_R2_ACCOUNT_ID`, `W2S1_STAGING_R2_BUCKET_NAME`, `W2S1_STAGING_R2_ACCESS_KEY_ID`, and `W2S1_STAGING_R2_SECRET_ACCESS_KEY`.

The workflow remains disabled until the staging-only GitHub Environment secrets and repository variable are configured. Owner must provision the exact staging Supabase target `oyykqfxkyqhxgrfntokl` and preview bucket `hrp-bi-preview`, then enable `W2S1_STAGING_REAPER_ENABLED=true`. Never substitute Production/VPS credentials or buckets.

T0 operations check on 2026-10-19: Owner reconfirmed the authorized Vercel staging DB ref is `oyykqfxkyqhxgrfntokl`. T0 updated only the `mini-bi` Preview variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` using the keys validated for that ref. A subsequent Vercel Preview environment run confirmed the URL host and publishable-key claim match the authorized ref and `R2_BUCKET_NAME` remains `hrp-bi-preview`; no DB connection was made. This affects future Preview deployments; T0 did not redeploy the current Preview. The GitHub environment `w2s1-staging-reaper` and repository variable are still absent. Vercel CLI does not permit pulling its seven secret values, so the R2 access credentials were not copied to GitHub. Reaper remains disabled; provision only staging R2/Supabase secrets in the dedicated GitHub environment and set `W2S1_STAGING_REAPER_ENABLED=true` after its required secrets exist.

## Manual UAT checklist before closing S1.1

1. On desktop and phone, switch between form and grid without losing entered values; add/remove multiple workers and verify row-specific fields/files stay with the correct worker.
2. Enter one valid and one invalid row; save and verify only the valid worker is created, the invalid row remains, and no success is shown for a failed row.
3. Upload a portrait, both CCCD sides, and an employment contract; verify each document appears on the intended worker and can be retried after a transient failure without changing worker association.
4. Verify draft/edit permissions, version conflict, retry, skip-CCCD path, and contract continuation; ensure unauthorized rows do not gain an upload path.
5. Keyboard-only: reach every field/action in logical order, operate native selects/file inputs, identify required fields/errors, and confirm visible focus. At 200% zoom and narrow viewport, confirm no clipped controls or horizontal page overflow.
6. Screen reader and contrast check: labels, required markers, per-row errors, upload status, save/retry announcements, and touch targets. Record device/browser and results.

## Revision log

- 2026-10-19 — T0 continuation: documented immediate server-side draft staging for portrait, CCCD front/back, and employment contract; same-batch attachment of valid rows; migrations #117–#119; same-key retry and replacement-stage cleanup. Repaired stale test assertions affected by the append-only migration ledger; canonical test lanes passed in ordered segments. Owner reconfirmed the authorized Vercel staging ref; T0 updated and verified only the three Preview Supabase variables. No DB was contacted and no deployment was triggered. The GitHub reaper environment/variable remain absent; Vercel CLI cannot retrieve existing secret values, so no R2 credentials were copied to GitHub and the reaper remains disabled. No commit, push, or merge. Remaining: provision matching staging R2 secrets and enable the isolated GitHub schedule, then perform real-device/accessibility UAT.
