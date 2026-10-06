# P3-W07C-R1 — Direct Entry save date lazy defaults (HANDOFF)
Status: `P3-W07C-R1_LAZY_DEFAULT_ENTRYPOINTS_CLOSED_LOCAL_PASS_AWAITING_INTEGRATION`
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

## Lazy defaults (B) — R1 entry points closed
`defaultCells()` empty. `updateSpreadsheetRowCells` and
`updateSpreadsheetRowProviderType` activate BEFORE patch
(idempotent; `now` thread). Activation guaranteed on: click/select;
addQuick (empty OR new append; `setQuickEditClientRowId` outside
`setStagedModel` updater); quick editor open; mobile `<details>`
onToggle when open; mobile field change; HRP/Vendor; paste/import.
User/paste always win (patch AFTER activation). Default-only rows
stay blank (no validate/batch/server). `clear row` resets EMPTY +
`lazyDefaultsApplied: false`. New
`direct-entry-live-lazy-default-entrypoints.test.mjs` (10 tests);
`spreadsheet-row-model.test.mjs` +3 R1; h08 file drops "inherit
defaults from row factory".

## Date display / label / error presentation (C/D/E)
Unchanged. See `a8a02ce` HANDOFF.

## Gates
`spreadsheet-row-model` 19/19 · `direct-entry-date-format` 6/6 ·
`full-profile-api` 9/9 · `pnpm test:p1.6-i04c3-r3a` 129/129 ·
`typecheck` ✓ · `lint` ✓ (0e/11w) · `build` ✓ · `git diff --check` ✓
· direct-entry 635/635. Deferred: None.
