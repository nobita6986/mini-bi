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

## R4-R1 follow-up — type-to-search on a cell that already has a value

The combobox seeded its query with the selected label but did not select the text on focus, so
typing appended to the old label ("Compal" + "C" = "CompalC") and the filter came back empty.

- The input now selects all text on mount and on focus, so the first keystroke replaces the label.
- While the query still equals the original label the list shows **all** options, so opening a
  filled cell lets the user browse and re-pick instead of being narrowed to one row.
- The single-match auto-commit was removed: Enter commits only when the user has highlighted an
  option with the arrow keys, or clicked one. Escape closes without changing the value, and
  blur/Tab keep the stored value. Provider scoping and stored value shapes are unchanged.

Regression tests added (suite now 11/11): opening a filled cell and typing a letter filters
correctly and the concatenated label would have matched nothing; closing without choosing keeps
the previous value and never auto-commits.

## R4-R2 follow-up — suggestion list was clipped by the grid cell

Root cause: the suggestion list rendered **inside** the react-data-grid cell editor. The cell
rule in `react-data-grid/lib/styles.css` sets `overflow: clip` (inside `@layer rdg.Cell`;
the class name is hashed, so it is not a literal `.rdg-cell` selector), so the popup was cut off
at the cell boundary even when the filter matched.

- The list is now rendered through `createPortal` into `document.body` and positioned with
  `position: fixed` anchored to the input being edited, so no cell ancestor can clip it.
- Position comes from the new pure `computeSearchPopupPosition` in `catalog-search.ts`: it flips
  above the cell when there is not enough room below, clamps horizontally inside the viewport
  margin, caps the height, and caps height against the viewport itself even when the anchor has
  scrolled out of view.
- Position is recomputed on `scroll` (capture, so the grid's own scroller is seen) and on
  `resize`; listeners are removed on unmount.
- The option buttons keep `onMouseDown` `preventDefault` so clicking an option does not blur the
  input and close the editor before the click lands.
- Unchanged: provider/project scoping, stored value shapes, the existing search, click or
  arrow+Enter selection, Escape/blur/Tab keeping the value, and no first-option auto-select.

Regression tests added (suite now 14/14): the stylesheet really does clip cell content, and the
list is rendered through the portal to `document.body` rather than inside the cell — a
source-only assertion would not have caught this, so the check is tied to the actual CSS rule and
to the portal call structure. Geometry tests cover below/above flip, horizontal clamping, height
capping and a short viewport with the anchor outside it.

## Stop point

Pushed for T0 review. No merge, no deploy, no Production apply. Schema, migration, RPC, catalog
data, permissions, auth and API contracts are untouched.
