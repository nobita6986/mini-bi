# P3-W07C-R6-R1 — Close review findings (rebased on R5)

**Status:** `P3-W07C-R6-R1_REVIEW_FINDINGS_CLOSED_LOCAL_PASS_AWAITING_T0_REVIEW`

Base `origin/main@ebb82174ab5c31d75de1c96d142feee0992c4568` (contains R5).

## How R5 was brought in

Worktree `BI-p3-w07c-r6-r1-close-review` was created **from `origin/main@ebb8217`**, which already
contains R5's 17-column test-truth fix, then R6 was replayed onto it with
`git cherry-pick -x 6408945` → `476cc33`. R6 `6408945` on its own branch is untouched (no amend,
no rebase, no delete). Final branch: `feature/p3-w07c-r6-r1-close-review`.

## Findings closed

**1 — catalog still loaded per `first_work_date`.** `direct-entry-live.tsx` still built a
`neededDates` set from draft rows and ran `Promise.all(neededDates.map(ensureCatalog))`. Removed
entirely. The audit also found the same pattern in **`direct-entry-change-request-reviewer.tsx`**
(`catalogDates` ref + `[...dates].map((date) => ensureCatalog(date))`) and in
**`direct-entry-change-request-proposer.tsx`** — both replaced with the current page catalog.

**2 — change-request surface.** `proposer` replaced its `<input type="date">` for
`first_work_date` with `DdmmDateInput` (DD/MM/YYYY, ISO commit, invalid/Escape keep the old date).
Its project/recruiter label lookup, bank-id set and bank list now read `catalogFor(hcmTodayDate())`
instead of `catalogFor(entry.first_work_date)`, so editing the date cannot change or clear
project/recruiter/provider. `status-date` ("Ngày hiệu lực") is a different business field and was
**not** touched. Reviewer label resolution and its load now use the same current catalog.

**3 — DD/MM input committed only once.** `settled.current = true` was never reset. The rule is now
a pure reducer (`reduceDdmmSettle` / `canDdmmSettle` / `DDMM_SETTLE_IDLE`): focus, edit and
Escape open a new interaction; a settle blocks a second settle in the same interaction, so
Enter→blur commits once while a second edit, an invalid-then-correct edit, or an Escape-then-edit
all commit normally.

## `ensureCatalog` inventory — 3 call sites, all page-date

| File | Call |
| --- | --- |
| `direct-entry-live.tsx` | `ensureCatalog(today)` |
| `direct-entry-change-request-proposer.tsx` | `ensureCatalog(hcmTodayDate())` |
| `direct-entry-change-request-reviewer.tsx` | `ensureCatalog(hcmTodayDate())` |

No row-date argument, no `.map(ensureCatalog)`, no `neededDates`/`catalogDates` date set.

## Production-reachable `first_work_date` surfaces (all DD/MM, no native date input)

grid `DateCellEditor` · mobile staged card · quick editor · persisted draft drawer · legacy shell
(cell editor + inline row) · change-request proposer. `status-date` remains a native date input by
design.

## Tests / gates

New `direct-entry-w07c-r6-r1-review-findings.test.mjs` (6): a scanner proven to flag the old
patterns (`neededDates`, date-set, `.map(ensureCatalog)`, direct row-date call) and clean on
current source; only the page catalog is loaded; proposer has no native date input and its date does
not drive the catalog; the settle lifecycle (two commits, invalid→fix→commit, Enter→blur once,
Escape→next commit); no native date input on any surface.

- R6-R1 6/6 · R6 + R4 targeted 29/29 · **Direct Entry sweep 255/255, 0 fail**
- `pnpm typecheck` PASS · targeted ESLint **0 errors** (2 pre-existing warnings) · `pnpm build` PASS
- `git diff --check` PASS

No migration, dependency, permission, API contract, deploy or Production change.
