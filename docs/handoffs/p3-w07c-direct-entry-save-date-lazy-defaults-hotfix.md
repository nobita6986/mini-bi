# P3-W07C-R1 — Direct Entry save date lazy defaults (HANDOFF update)

Status: `P3-W07C-R1_LAZY_DEFAULT_ENTRYPOINTS_CLOSED_LOCAL_PASS_AWAITING_INTEGRATION`

Local SHA = remote SHA: `24d99d13ad605789b92f11a076d72932ea5ff279` (branch
`feature/p3-w07c-direct-entry-save-date-lazy-defaults-hotfix`, rebased on
`origin/main` `6a81f5637d61bdd66d09c835ba613482609b8ea8`). Sits on top of
W07C hotfix commit `a8a02ce`; code commit `20b570b`.

## Root cause (A) — corrected

`normalizePayment` already accepted `null` as omitted. The defect lived
in `normalizeEmployment` (`src/lib/direct-entry/full-profile-contract.ts`):
its guard `if (value === undefined)` rejected `payment: null` and
`employment: null` payloads the staging pipeline intentionally omits, and
the contract parser emitted `BATCH_INVALID` for the whole batch.

Fix: treat `null` as omitted (`value === undefined || value === null`).
Safe error codes remain for genuinely invalid values; `BATCH_INVALID` is
the umbrella required-missing code and continues to cover shape and
required-field gaps — it is NOT reserved solely for required-missing.

Regression tests in `full-profile-api.test.mjs` (production-shaped row +
Postgres safe-code classification) lock the safe-code propagation.

## Lazy defaults (B) — R1 entry points closed

`defaultCells()` stays empty. `updateSpreadsheetRowCells` and
`updateSpreadsheetRowProviderType` now activate lazy defaults BEFORE
applying the user/patch (idempotent; `now` thread for deterministic
tests). Activation is therefore guaranteed on:

- click/select row (grid `onSelectedClientRowChange` → wrapper
  `setSelectedClientRowId` activates);
- `addQuickStagedRow` (activates the empty row OR appends a new one then
  selects; `setQuickEditClientRowId` is called outside the
  `setStagedModel` updater);
- quick editor open (`openQuickEditor` activates before
  `setQuickEditClientRowId`);
- mobile `<details>` open (`onToggle` activates when
  `event.currentTarget.open`);
- mobile field change (still routes through `updateSpreadsheetRowCells`);
- HRP/Vendor selection (activates inside `updateSpreadsheetRowProviderType`);
- paste/import (`updateSpreadsheetRowCells` is the single write path;
  user/paste values always win because the patch is applied AFTER
  activation).

Default-only rows remain blank, are excluded from validation, batch
count, and server send. `clear row` resets to EMPTY +
`lazyDefaultsApplied: false`. New behavioral regression file
`direct-entry-live-lazy-default-entrypoints.test.mjs` covers every
entry point; `spreadsheet-row-model.test.mjs` got three new R1 tests
covering `updateSpreadsheetRowCells` activation, provider activation,
and default-only blank exclusion. The h08 R1 structural file is updated
to drop "inherit defaults from row factory" wording.

## Date display / label / error presentation (C/D/E)

Unchanged from the W07C hotfix commit. See `a8a02ce` HANDOFF ancestor.

## Targeted gates (delta)

- `node --test src/lib/direct-entry/spreadsheet-row-model.test.mjs` ✓
- `node --test src/lib/direct-entry/direct-entry-date-format.test.mjs` ✓
- `node --conditions=react-server --test src/lib/direct-entry/full-profile-api.test.mjs` ✓
- `pnpm test:p1.6-i04c3-r3a` 129/129 ✓
- `pnpm typecheck` ✓
- `pnpm lint` ✓ (0 errors, 11 pre-existing warnings)
- `pnpm build` ✓
- `git diff --check` ✓
- direct-entry suites 635/635 ✓

## Blocked / deferred

None. No migration; no Production mutation; reporting/cutover/W04B
untouched.
