# P3-UI-COMPANY-DISPLAY-NAMES — Short company/project display names

**Status:** `P3-UI-COMPANY-DISPLAY-NAMES_LOCAL_PASS_AWAITING_T0_REVIEW`

Base `origin/main@786a57e72a1271b3854bcc54baa4f97f2132dc74`.

## Scope audit (done before editing)

Surfaces that render a project/company name:

| Surface | File | Changed |
| --- | --- | --- |
| Direct Entry project dropdown (grid + mobile + quick editor) | `direct-entry-live.tsx` (`spreadsheetCatalogOptions`) | yes |
| Direct Entry project dropdown (change-request proposer) | `direct-entry-change-request-proposer.tsx` | uses the same catalog labels |
| Dashboard project filter `<select>` | `dashboard-filters.tsx` | yes |
| Project donut chart labels/tooltip | `p1-chart-data.ts` (`buildProjectDonutData`) | yes |
| Project × provider chart labels | `p1-chart-data.ts` (`buildProjectMixRows`) | yes |
| Recruiter lists/charts | recruiter names, **not** company names | not in scope |
| Source status bar/table | sheet/file names | not in scope |
| Excel export / stored rows / API payloads | legal name stays the data | **explicitly untouched** |

## Design

New pure module `src/lib/display/company-display-name.ts`:

- `shortCompanyName(fullName, displayName?)` — prefers an explicit "Tên hiển thị" when the caller
  supplies one (the catalog does **not** expose such a field today: `projects` is projected with
  exactly `{project_id, display_name}` and `hasExactKeys` enforces it), otherwise strips a known
  legal prefix. Longest prefix first, case-insensitive, requires a separator and a non-empty
  remainder, so the proper name is never truncated and never becomes empty.
- `buildCompanyDisplayNames(items)` — maps `key → display`. When two different keys resolve to the
  same short name, **both fall back to the full legal name** so the user can still tell them apart.
- Sentinel keys (`__unknown__`, `__invalid__`, other `__`-prefixed read-model keys) are left as-is.

Prefixes covered: `Công ty TNHH MTV`, `Công ty trách nhiệm hữu hạn (một thành viên)`,
`Công ty TNHH`, `Công ty Cổ phần`, `Công ty CP`, `Công ty Hợp danh`, `Công ty`, `Tập đoàn`,
`Tổng công ty`, `CTCP`, `CT TNHH`, `TNHH MTV`, `TNHH`, `Co., Ltd`, `Corporation`, `Corp.`,
`JSC`, `Ltd.`

IDs and link keys are never modified: the dashboard filter still submits the project **key**, and
the Direct Entry option value is still `project_id`.

## Tests / gates

`src/lib/display/company-display-name.test.mjs` (8): each prefix form; case-insensitivity and
proper-name preservation; already-short names (`Compal`, `CDL`, `alpha_x`, `CtyABC`, bare
`Công ty`) returned unchanged; empty/whitespace and sentinel safety; alias value preferred; two
companies with the same short name both fall back to the full legal name; alias collision; and
"never returns empty for a non-empty name".

- display-name suite 8/8 · reporting suites (chart-data, dashboard, provider-mix, reporting) 79/79
- Direct Entry sweep 255/255
- `pnpm typecheck` PASS · targeted ESLint 0 errors (2 pre-existing warnings) · `pnpm build` PASS
- `git diff --check` PASS

## Still needed (not built — reported, not invented)

1. **Optional "Tên hiển thị" field in the catalog.** Today the project projection is exactly
   `{project_id, display_name}` and is validated with `hasExactKeys`, so a real alias field needs a
   migration adding a nullable column (e.g. `display_short_name`), the RPC/projection change, and
   the strict-projection allow-list update. `shortCompanyName` already accepts and prefers it, so
   wiring it later is a one-line change per surface.
2. **Admin UI to set that field** — no such screen exists; out of scope here.
3. Recruiter/team labels and the legacy shell were reviewed and are either not company names or
   already covered by the same catalog labels.
4. No legal-name change, no export change, no stored-value change, no migration applied.
