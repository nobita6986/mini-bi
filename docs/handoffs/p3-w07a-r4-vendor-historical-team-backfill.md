# P3-W07A-R4 — historical Vendor team backfill (#66) — R1 review-evidence closure

Status: `P3_W07A_R4_R1_LOCAL_PASS_AWAITING_T0_REVIEW`. Same branch, fast-forward from `35e3664`. Labels corrected: **#66 = P3-W07A-R4**, **#65 = P3-W07A-R3**, ledger now **66 migrations**.

## FIX 1 — real hidden-team evidence (dimension assertion was vacuous)

The legacy `reporting_dimension_options_v01` view only ever carries project/recruiter/provider/employment, so `dimension='team' and display='Vendor'` was always 0 and proved nothing. It is no longer used as hidden-team evidence.

- Migration postconditions now check the real reporting contract: `public.direct_entry_reporting_dimension_options_v01` must emit no `dimension='team'` row, and the reserved team id must never appear as an option key. The direct checks stay: 0 membership, 0 team scope, 0 Vendor outside the reserved team, 0 non-Vendor inside it.
- Regression asserts the real read surfaces after #66: `direct_entry_input_catalog` for a valid actor still lists the Vendor recruiter with `provider_type='vendor'`, `team_id=null`, `team_display_name=null`; no catalog row carries the reserved team id or the reserved label; the reserved code never reaches the payload; the real reporting view emits no team dimension and still yields `provider='Vendor'` for a submitted Vendor row.

## FIX 2 — fail-all-or-nothing now runs on real rows

The previous abort test had zero Vendor entries, so "no partial change" was vacuous. It now seeds a real Vendor row pending backfill on a business team (+ an already-correct Vendor row and an HRP control row), captures versions, then makes the existing reserved row non-canonical/inactive before applying #66. After the rejection: both pending Vendor rows are still on the original business team with unchanged versions, the HRP row is unchanged, the backfill audit count is 0, and no Vendor row moved anywhere — which fails if the canonical preflight is dropped or the UPDATE were allowed to run first.

## Gates

`pnpm test:p3-w07a-r4` 2/2; P3-W07A-R2/R3 + P3-W05A reporting/authority suites green; `pnpm test` 0 fail; typegen + typecheck clean; lint **0 errors** (14 pre-existing warnings); build ok; `docs:check` 6/6; `secrets:check` ĐẠT; `db:migrate -- --offline` **66 valid**; `git diff --check` clean. No Production apply, no deploy, no browser/UAT, no new migration, #66 slot/name unchanged, #1-#65 byte-identical.
