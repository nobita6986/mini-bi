# P3-W07C-R6 — Decouple work date from catalog; DD/MM date editor

**Status:** `P3-W07C-R6_DECOUPLED_WORK_DATE_CATALOG_DDMM_LOCAL_PASS_AWAITING_T0_REVIEW`

Base `origin/main@549d2f4d75467fd81060d88e85df33c630db7b62` (main had not advanced past W07C-R4-R2).

## Root causes

1. **MM/DD/YYYY.** Every `first_work_date` editor was a native `<input type="date">`, whose display
   format follows the browser/OS locale, not the product contract.
2. **Catalog churn on date change.** `first_work_date` was used as the catalog selector in ~15
   places: the per-row `ensureCatalog(row.firstWorkDate)` effect (which also **wiped
   `recruiterId`** when that date's catalog lacked the recruiter), `stagedCatalogSource(date)`,
   the staged-validation `catalogDates` loop, per-row `catalogOptions`, `displayProject`/
   `displayRecruiter`, the drawer/quick-editor catalog, and Excel-import recruiter resolution.
   A historical date with no loaded catalog produced an empty list, a lost label and
   `PASTE_CATALOG_MISSING`; the raw id then surfaced as a UUID.

## Fix

**A. One shared DD/MM editor** — `direct-entry-ddmm-date-input.tsx`: text input,
`inputMode="numeric"`, placeholder `DD/MM/YYYY`, local draft state, commit to ISO only via
`parseDDMMToIso`. New pure `decideDdmmCommit` keeps the old value on invalid/empty input.
Wired into all five surfaces: grid `DateCellEditor`, mobile staged card, quick editor, persisted
drawer, and the legacy shell (cell editor + inline row). No `type="date"` remains.

**B. Single catalog.** `currentCatalog` (the page's HCM-date catalog, actor-scoped) is now the
only catalog. `stagedCatalogSource` ignores its date argument; the per-row-date effect, the
`catalogDates` loop and every `ensureCatalog(<row date>)` call are gone — `ensureCatalog(today)`
at mount is the only remaining call. Changing `first_work_date` no longer touches
`project_id`, `recruiter_id` or `providerType`, and no longer fetches a catalog.

Unchanged: provider scoping, stored value shapes (project = label, recruiter = stable UUID),
W07B project authorization, the R4-R2 searchable combobox and its `document.body` portal,
keyboard/click selection, Excel import, batch save, lazy defaults. No dependency, migration,
API or permission change.

## Tests / gates

`direct-entry-w07c-r6-decouple-date-catalog.test.mjs` (9 tests): no `type="date"` on any surface;
ISO→DD/MM open; DD/MM and `2-10-2026` commit to ISO; invalid input never overwrites; date change
keeps project/recruiter/providerType; no catalog call for a new date; historical `02/10/2026`
resolves labels from the current catalog with no `PASTE_CATALOG_MISSING`; provider scoping intact;
R4-R2 popup still portals to `document.body`.

Six existing tests that encoded the old date↔catalog contract were rewritten to the new contract
(incl. replacing the `type="date"` assertion). Nothing was weakened or deleted.

- R6 suite 9/9 · R4 catalog retention/search 14/14
- Direct Entry sweep **248/249**
- `pnpm typecheck` PASS · targeted ESLint **0 errors** (3 pre-existing warnings)
- `pnpm build` PASS · `git diff --check` PASS

**Known baseline failure (pre-existing, unchanged by this task):**
`direct-entry-h03-ui-reorganization.test.mjs` → "only the approved 18 data columns render". It
still expects 18 columns in the old order incl. `national_id_issued_place`; fixed separately on
`feature/p3-w07c-r5-column-contract-test-truth`, not on this base. Not touched here.

## Stop point

Local pass only. No merge to main, no deploy, no Production apply, no migration or RPC change.
If the server later requires recruiter membership keyed by `first_work_date`, stop and ask T0
before any migration — no such dependency was found.
