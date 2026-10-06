# P3-W07C — Direct Entry save date lazy defaults hotfix (HANDOFF)

Status: `P3-W07C_DIRECT_ENTRY_SAVE_DATE_LAZY_DEFAULTS_HOTFIX_LOCAL_PASS_AWAITING_INTEGRATION`

Local SHA = remote SHA: `b0c4751940ea2ad38fa1085db0f2a34ff7d513cf` (branch
`feature/p3-w07c-direct-entry-save-date-lazy-defaults-hotfix`, rebased on
`origin/main` `6a81f56`).

## Root cause (A)

`normalizeEmployment` in `src/lib/direct-entry/full-profile-contract.ts`
collapsed `payment: null` / `employment: null` (server-generated fields the
client intentionally omits) into `BATCH_INVALID`. The guard only accepted
`undefined`. The staging pipeline built the request body with `null` for
these server-omitted fields, so the contract parser refused the row.

Fix: accept `null` as omitted (`value === undefined || value === null`).
Safe error codes (BATCH_* domain) are preserved for genuinely invalid
values. `BATCH_INVALID` is only emitted for true required-missing.

Regression test added in `full-profile-api.test.mjs` (production-shaped row
+ Postgres safe-code classification).

## Lazy defaults (B)

`defaultCells()` now returns empty cells. New flag
`SpreadsheetStagedRow.lazyDefaultsApplied` and helper
`activateSpreadsheetRowLazyDefaults(model, clientRowId, now)`.

- First user interaction (select row, open quick editor, focus/edit cell)
  inserts `today` (Asia/Ho_Chi_Minh) and `Bộ Công An` once.
- Idempotent; never overwrites user/paste/import values.
- `spreadsheetRowIsBlank` and `selectNonEmptySpreadsheetRows` accept
  optional `now` for deterministic tests; default-only rows are blank and
  are excluded from validation, batch count, and server send.
- `clear row` resets to blank + `lazyDefaultsApplied = false`.

## Date display (C)

State, payload, DB contract: ISO `YYYY-MM-DD`. Closed cells: `DD/MM/YYYY`
via pure string helpers in `direct-entry-date-format.ts`
(`parseIsoDate`, `formatDateToDDMM`, `todayInHoChiMinhAsDDMM`).
No `new Date("YYYY-MM-DD")`; no timezone leak. Date editors remain `type=date`
and receive ISO value.

## Label (D)

`date_of_birth` column label overridden to `Ngày sinh` via
`direct-entry-grid-columns.ts` (single registry). Mobile staged card and
quick editor also show `Ngày sinh`. Canonical payload key unchanged.

## Error presentation (E)

Explicit `stagedTone` state (`error | success | info | ""`) and
`setStagedMessageWithTone`. Legacy `setStagedMessage` wrapper auto-sets
tone to `error`. Save message element renders `role="alert"` + red
`.spreadsheetSaveMessageError` for errors, `role="status"` for
success/info (`.spreadsheetSaveMessageSuccess` /
`.spreadsheetSaveMessageInfo`). Vietnamese-text inference removed.

## Targeted gates

- `pnpm exec next typegen` ✓
- `pnpm typecheck` ✓
- `pnpm lint` ✓ (0 errors, 11 pre-existing warnings)
- `pnpm build` ✓
- `git diff --check` ✓
- `node --test --conditions=react-server` (direct-entry suites) 623/623
- `pnpm test:p1.6-i04c3-r3a` 111/111
- `pnpm test:p1.6-i04c3-r3b` 24/24
- `pnpm test:p1.6-i04c3-s01` 29/29

## Blocked / deferred

None. Production evidence matches safe-code fix; no migration required.
