# P3-W07C-R1 — Direct Entry save date lazy defaults (HANDOFF)
Status: `P3-W07C-R1_LAZY_DEFAULT_ENTRYPOINTS_GRID_ZOOM_CLOSED_LOCAL_PASS_AWAITING_INTEGRATION`
R1 commit `20b570b` on
`feature/p3-w07c-direct-entry-save-date-lazy-defaults-hotfix`
(base `origin/main@6a81f56`; sits on W07C hotfix `a8a02ce`).

## Root cause (A) — corrected
`normalizePayment` already accepted `null`. Defect was in
`normalizeEmployment` (`full-profile-contract.ts`): guard `if (value
=== undefined)` rejected `payment: null` / `employment: null`,
emitting `BATCH_INVALID`. Fix: `value === undefined || value ===
null`. Code is the umbrella required-missing (shape + required-
field) — NOT reserved solely for required-missing. Safe codes
preserved; tests in `full-profile-api.test.mjs` lock propagation.

## Lazy defaults (B) + grid zoom (F)
`defaultCells()` empty. `updateSpreadsheetRowCells` and
`updateSpreadsheetRowProviderType` activate BEFORE patch
(idempotent; `now` thread). Activation on: click/select; addQuick
(empty OR new append; `setQuickEditClientRowId` outside updater);
quick editor open; mobile `<details>` onToggle when open; mobile
field change; HRP/Vendor; paste/import. User/paste always win
(patch AFTER activation). Default-only rows stay blank.
Grid zoom: `−`/`Đặt lại`/`+`, levels 80/90/100/110/120 (mặc
định 100), disabled tại 80/120, `aria-live="polite"`. Scale
width (clamp ≥32px), row/header height, font + padding qua CSS
vars. KHÔNG `transform: scale()` / CSS `zoom` / browser zoom;
không mutate cells/selection/paste/save. Registry tái sử dụng
`DIRECT_ENTRY_GRID_COLUMNS`. Tests: lazy 10, model +3 R1,
zoom 17. h08 drops "inherit defaults from row factory".

## Date display / label / error presentation (C/D/E)
Unchanged. See `a8a02ce` HANDOFF.

## Gates
`spreadsheet-row-model` 19/19 · `direct-entry-date-format` 6/6 ·
`full-profile-api` 9/9 · `pnpm test:p1.6-i04c3-r3a` 146/146 ·
`typecheck` ✓ · `lint` ✓ (0e/11w) · `build` ✓ · `git diff --check` ✓
· direct-entry 652/652. Deferred: None.

## R2 raw-text dates — local takeover
Status: `P3-W07C-R2_RAW_TEXT_DOB_CCCD_LOCAL_PASS_AWAITING_INTEGRATION`.
DOB + CCCD issue date remain ordinary bounded text (≤10 chars): UI, paste, payload, JSONB, and read display preserve the exact value; no ISO conversion, calendar validation, future-date check, or cross-field comparison. `first_work_date` remains ISO.
Migration `20261008050000_p3_w07c_r2_raw_text_dates.sql` safely removes only the known lexical-check block from the existing batch RPC; no new DB helper or column. W07C branch count: 45; after W05A migration #45 integrates, this becomes #46.
Targeted direct-entry tests 109/109 (includes PGlite 6/6); P2 migration 8/8; P2 reconcile 4/4; impacted S04C migration tests 28/28.
Gates: full `pnpm test` exit 0; typegen, typecheck, build ✓; lint 0 errors / 11 warnings; `git diff --check` clean.
No Production DB query/apply. Main push is authorized and may trigger Vercel deployment; the migration remains pending for a separately controlled DB apply. Preserve the pre-existing untracked `test_output.txt`.
