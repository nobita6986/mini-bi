# P3.1-W02C UI cutover — dynamic Labor Type catalog

**Status:** `P3_1_W02C_UI_DYNAMIC_CATALOG_LOCAL_PASS_AWAITING_T0_REVIEW`

## Base and scope

- Base: `a44a9e18085a9d7e096aef14e508fee8704f7659`.
- Branch: `feature/p3-1-w02c-labor-type-catalog`.
- This reopens the earlier UI-only cutover. The older blocked memo
  [`p3-1-w02c-labor-type-ui.md`](./p3-1-w02c-labor-type-ui.md) remains history; its missing-label
  finding is superseded by the locked R2 `labor_type_display` projection documented in
  [`p3-1-w02c-labor-type-catalog.md`](./p3-1-w02c-labor-type-catalog.md).
- No backend, RPC, route, schema, migration, permission, or dependency was changed.

## UI behavior

- Grid, mobile editor, quick editor, worker operations, and change-request proposer build choices
  from the active Input Catalog. Values and mutation payloads retain the canonical
  `labor_type_key`; labels come from `display_name`. Choices sort by `sort_order`, then
  `display_name`.
- A newly activated spreadsheet row receives the first sorted active key deterministically. The
  model tracks that preselection separately so an untouched placeholder remains blank. Reloading
  the catalog does not replace a selected key. If its key is no longer active, it remains in the
  row state and is visibly marked unavailable rather than remapped.
- With no active catalog option, the staged-save action is disabled and the page reports that no
  active Labor Type is available. No legacy key is substituted.
- Worker history and change-request before/after labels use the server-projected
  `labor_type_display`. Edit selectors contain active options only; an inactive baseline remains
  visible but cannot be selected as a new value. The client does not query Admin Catalog or infer
  labels for history.
- Excel paste and worker-profile paste receive the active labor-type projection from Input Catalog
  for preview and validation. A canonical key such as `PROBATION` is accepted only when the loaded
  active catalog contains it. Existing legacy aliases remain accepted by import parsers.
- New XLSX templates no longer embed the retired two-value dropdown list. Import accepts canonical
  keys and preserves legacy aliases; the guide points operators to the active catalog.

## Test coverage and evidence

- Added `test:p3-1-w02c-ui-dynamic-catalog`, registered once in `package.json` and called once by
  canonical `pnpm test`.
- The focused lane covers deterministic ordering/default, empty catalogs, no silent remap on
  reload, `PROBATION`, legacy aliases, active-only validation, XLSX template validation removal,
  Direct Entry consumers, and authoritative history-label projections.
- Mutation probe replaced the spreadsheet Labor Type options with fixed `TEMPORARY`/`PERMANENT`
  choices. The focused lane failed on its dynamic-consumer assertion. The source was restored and
  verified byte-identical to its pre-probe bytes.
- Focused UI lane: 175/175 tests pass. Existing W02C catalog lane and R2 display-projection lane
  also pass; R2 projection lane: 11/11 tests.
- Canonical `pnpm test` passes and invokes `test:p3-1-w02c-ui-dynamic-catalog` exactly once.
- `pnpm exec next typegen`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm docs:check`,
  `pnpm secrets:check`, `pnpm db:migrate -- --offline`, and `git diff --check` pass.
  Lint reports 13 warnings and no errors.

## Boundaries

- Active status/existence remains a server/DB authority. Browser-side catalog data only controls
  which options are offered; it is not an authorization decision.
- Inactive keys are never offered for new writes. Existing history is rendered only from the
  authoritative `labor_type_display` projection.
- No Production query/apply, deployment, browser automation, UAT, or merge was performed.
