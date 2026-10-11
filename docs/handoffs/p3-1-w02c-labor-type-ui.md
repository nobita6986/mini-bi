# P3.1-W02C — Labor Type dynamic UI cutover: blocked on inactive-label projection

**Status:** `P3_1_W02C_UI_DYNAMIC_CATALOG_BLOCKED_T0_PROJECTION`

## Checkout and scope

- Required base: `12a859df7a22bd0bac5bb7e357135435c3087f94`.
- Branch: `feature/p3-1-w02c-labor-type-catalog`.
- The requested branch already existed as a clean worktree at the exact required base and tracked the same remote tip; that isolated checkout was reused rather than changing or deleting it.
- UI implementation stopped after contract inspection found the blocker below. No component, model, test, API, schema, migration, package, or dependency was changed.
- No Production query/apply, deploy, browser, UAT, merge, rebase, amend, or force-push was performed.

## Blocking contract gap — inactive historical display name

The UI must show a catalog `display_name` for an inactive labor-type key in worker history and change-request history, without a static map or an Admin Catalog client call. No existing Direct Entry read projection provides that data:

| Surface | Existing authoritative shape | Evidence |
|---|---|---|
| Input Catalog | `labor_types` options contain exactly `labor_type_key`, `display_name`, and `sort_order`; migration #79's `direct_entry_labor_type_options()` filters `WHERE t.active`. It cannot resolve a deactivated key. | `src/lib/direct-entry/write-repository.ts` (`DraftCatalogLaborType`, `projectDraftCatalog`); `supabase/migrations/20261011120000_p3_1_w02c_labor_type_catalog.sql` (`direct_entry_labor_type_options`) |
| Worker history/directory | `direct_entry_list_workers` selects `e.labor_type` and emits only `'labor_type', t.labor_type`. `WORKER_DIRECTORY_ROW_KEYS` and `WorkerDirectoryRow` have `labor_type`, but no display field. | `supabase/migrations/20261008120000_p2_5_w03_worker_directory_projection.sql`; `src/lib/direct-entry/worker-directory-contract.ts` |
| Change-request history/review | The server proposal projection allowlists `labor_type` as a raw key; the strict `READ_PROPOSAL_KEYS.ENTRY_FIELD` contract also has `labor_type` but no display field. | `supabase/migrations/20261005030000_p1_6_w04_s04c_s03b3_r1_change_policy_closure.sql` (`direct_entry_change_request_proposal_projection`); `src/lib/direct-entry/change-request-read-contract.ts` |
| Entry edit baseline | The current UI baseline consumes a raw `labor_type` key and accepts the retired two-key set; it has no authoritative inactive label alongside that key. | `src/components/direct-entry/worker-operations.tsx` (`EntryBaseline`, `fetchBaseline`) |

**Exact field/RPC gap for T0:** add an authoritative Direct Entry read projection field such as `labor_type_display` for the stored key to the worker-directory row and the ENTRY_FIELD change-request proposal/read projection (and any entry baseline projection used by worker edit). The underlying server projection must resolve both active and inactive catalog rows by canonical key. There is currently no Direct Entry read RPC/API contract that returns the display name for an inactive key.

`direct_entry_labor_type_options()` is deliberately active-only. The Admin catalog GET/list can include inactive items under Admin authority, but calling that from Direct Entry is outside the locked boundary and is not a workaround. The internal reporting display lookup is not part of the Direct Entry worker/change-request response contracts and likewise cannot supply this UI projection.

Until T0 supplies and locks the safe server projection, changing a historical key to a legacy key or displaying “Không xác định” would violate the request. The UI cutover therefore stops here.

## UI consumer inventory — not cut over

The following surfaces still contain closed-set UI behavior and require a follow-up after the projection contract is resolved:

- Direct Entry grid/live controller, staged rows, quick add, and date-specific catalog reload.
- Worker operations/edit baseline, current history display, and edit selector.
- Change-request proposer selector and reviewer before/after display.
- Excel paste dialog labels, paste/import validation and preview.
- Worker-profile paste preview and XLSX template/import validation.
- Grid, catalog-retention, paste, XLSX, worker-operation, and change-request regressions.

No UI consumer is claimed as dynamic in this handoff. Once unblocked, new writes must keep the canonical key, select from the active date-specific Input Catalog only, order options by `sort_order` then `display_name`, and preserve the user's selected key across catalog/date reloads. Inactive historical keys must remain unchanged and display the authoritative projected name.

## Validation and handoff state

- No implementation tests or mutation probes were run because the requested implementation is blocked before source changes.
- `pnpm test`, typegen, typecheck, lint, build, secrets, and offline migrations were not run for the same reason.
- Documentation-only checks (`pnpm docs:check`, `git diff --check`) are run for this blocker handoff.
- This is a T0 contract blocker, **not** `P3_1_W02C_UI_DYNAMIC_CATALOG_LOCAL_PASS_AWAITING_T0_REVIEW`.
