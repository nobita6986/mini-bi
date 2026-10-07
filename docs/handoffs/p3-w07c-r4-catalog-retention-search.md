# P3-W07C-R4 — Direct Entry catalog retention + searchable dropdowns

**Status:** `P3-W07C-R4_LOCAL_PASS_AWAITING_T0_REVIEW`

## Base

- Baseline: `origin/main@04fb8c52ac41676e424fdfb5c5d3a5ea7ec56757` (W07C R1/R2/R3 already merged).
- Branch: `feature/p3-w07c-r4-catalog-retention-search`. Worktree clean at start.
- All W07C dependencies used here are already on baseline; nothing was taken from an unmerged branch.

## Root causes and fixes

**1. Date change lost the selected recruiter.** Two call sites patched `first_work_date`
together with an explicit `recruiter_id: ""`, wiping the selection:
`onSpreadsheetCellsChange` (desktop/staged patch) and `onMobileStagedChange` (quick edit).
Both now patch only the field the user edited.

**2. Date change lost the dropdown list.** The per-row catalog was resolved as
`catalogs[dateKey] ?? null`. While the new date's catalog was still loading this returned
`null`, so the Dự án / Người tuyển dropdown rendered empty, and the derived `providerType`
fell back to `""` which disabled the recruiter dropdown entirely. It now falls back to an
already-loaded catalog (`?? fallbackCatalog`); the date-specific catalog replaces it on the
next render once loaded. This is a state/catalog-layer fix, not a UI mask.

**3. No search in dropdowns.** `Dự án` and `Người tuyển / Vendor` now use a searchable
combobox (`SearchableCatalogCellEditor`) built on the existing `typeahead.ts` helpers and a
new pure `filterCatalogSearchOptions` in `src/lib/direct-entry/catalog-search.ts`. It matches
case-insensitively on the displayed label, on the option id/code, and on extra keywords
(`personnel_code`, `vendor_id`), using the same NFC + `toLocaleLowerCase("vi")` normalization.

Keyboard: type to filter, ArrowUp/Down to move within the filtered list, Enter to confirm the
highlighted option, Escape to close without changing the value. Tab keeps its default grid
behaviour and blur commits the unchanged row, so no value is lost and no option is auto-selected:
the editor only auto-confirms when the filter narrows to exactly one option.

Provider/project scoping, the stored value shape (Dự án stores the label, Người tuyển stores the
stable id) and the existing commit contract are unchanged. No dependency was added.

## Tests

New `direct-entry-catalog-retention-search.test.mjs` (10 tests): date change retains the
recruiter in the row model; `live.tsx` no longer emits the wiping patch; the catalog falls back
instead of returning null; case-insensitive search by label, id/code and keywords; empty query
returns every option; arrow movement over the filtered list; commit-contract assertions; both
columns use the searchable editor; provider scoping stays tight.

Gates: new suite 10/10 PASS; full `src/components/direct-entry` sweep 235/236; `pnpm typecheck`
PASS; targeted ESLint 0 errors (3 pre-existing warnings in `direct-entry-live.tsx`);
`git diff --check` PASS.

## Blocker / deferred

- **Pre-existing failure, not caused by this change:**
  `direct-entry-h03-ui-reorganization.test.mjs` → "only the approved 18 data columns render"
  fails identically at baseline `04fb8c5` (verified by stashing this work). Its expected column
  order differs from `DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS` and it expects an 18th column
  (`national_id_issued_place`) that the registry does not currently expose. Untouched here —
  the column registry is outside this task's scope.
- Full suite intentionally not run (targeted scope only), per the task.
- No Owner UI verification was performed; this is a local pass only.

## Stop point

Pushed for T0 review. No merge, no deploy, no Production apply. Schema, migration, RPC, catalog
data, permissions, auth and API contracts are untouched.
