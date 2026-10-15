# Pre-W2-HF — Direct Entry reporting: decouple from cutoff + recruiter/provider `valid_from` (preflight / BLOCKED)

> Status: `PRE_W2_HF_DE_REPORTING_DECOUPLE_BLOCKED_PREFLIGHT_AWAITING_T0`
> Base: `origin/main@785bafc` (94 migrations). Branch: `codex/pre-w2-hf-direct-entry-reporting-decouple` (off `origin/main`). Isolated worktree; primary checkout untouched.
> Kind: read-only preflight. No source/SQL/test change, no migration apply, no DB access, no deploy, no UAT. Only this handoff is written.
> Next append-only slot would be **#95 (NOT reserved)**.

## 1. Executive conclusion — STOP for T0

The functional root causes are **confirmed by code**, and the `provider_type` snapshot **is trustworthy**. However two of the task's explicit stop-conditions are met, so this hotfix is **not safe to implement yet**:

1. **Legacy↔Direct Entry ownership/overlap cannot be established from code+contract.** Contract item 6 requires proof that the legacy aggregate is empty (or a source-ownership rule) before any cutoff change. That is a **live-data** question; DB access is forbidden here. The last *release-time* evidence (W04B #44 preflight, W04C #47) asserted `legacy = 0` and `active non-test sources = 0`, and #89 set the cutoff to `2000-01-01` — which *silently drops* any legacy rows that still exist. So today's state may already be dropping legacy data with no ownership rule. → **BLOCKED** (contract 6; "nếu không thể xác định ownership/overlap … dừng tại phân tích blocker và báo T0").
2. **The stable recruiter key is a contract decision.** Contract item 3 says group by a "stable server identity" and stop if that key can't be kept safe once the date-scoped alias lookup is dropped (item 7). The only key that stays in the legacy key space (`recruitment_dimension_key`-normalized text) is `recruiter_aliases.reporting_key` resolved **date-agnostically**. Whether that (vs. another stable identity) is the contract key must be locked by T0. → **BLOCKED** (contract 3/7).
3. **Gates are not runnable in this isolated worktree** (no `node_modules`): `pnpm db:migrate -- --offline` and `pnpm docs:check` cannot run. A security-critical service-role view/RPC change must not ship unvalidated.

`provider_type` trustworthiness is **NOT** a blocker (§4).

## 2. Current-state call graph (Direct Entry reporting)

```
Dashboard / team report
  src/app/dashboard/**            ─────────────────────────────┐
  src/lib/reporting/p2-w04a-reporting-server.ts  fetchCutoverReporting(actor)
  src/lib/reporting/p3-w06d-team-report-server.ts                 │
      └─ RPC direct_entry_reporting_scoped_facts(auth,app,filters)│  (DB-authoritative, actor-scoped)
           └─ reads view public.direct_entry_reporting_facts_v01  │
  src/lib/reporting/p2-w04a-options-server.ts                    │
      └─ RPC direct_entry_reporting_scoped_options(auth,app)      │
           └─ public.direct_entry_reporting_de_options_scoped(...)│
           └─ public.reporting_dimension_options_v01 (legacy)     │
                                                                  ▼
DE fact projection (all re-created/patch by 20261011120000_p3_1_w02c_labor_type_catalog.sql):
  view public.direct_entry_reporting_facts_v01
      recruiter_key          = public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date)   ← date-scoped alias
      recruiter_display      = r.display_name (current catalog)                                                        ✅ already OK
      provider_type_key      = public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) ← live membership lookup
      provider_type_display  = CASE e.provider_type …                                                                   ← STORED column
      employment_*           = helpers
      eligibility            = s.state='SUBMITTED' AND e.deleted_at IS NULL AND e.first_work_date >= cutoff()
  view public.direct_entry_reporting_dimension_options_v01     (project/recruiter/provider/employment)
  function public.direct_entry_reporting_de_options_scoped()   (same 4 dimensions, actor-scoped)
  helpers: direct_entry_reporting_recruiter_alias_key(uuid,date) / _recruiter_provider_key(uuid,date)
  cutoff: public.direct_entry_reporting_cutoff() = date '2000-01-01'   (set by #89 P2-W04D)
Legacy fact table daily_recruitment_breakdown: mask business_date < cutoff  → with 2000-01-01 ⇒ 0 rows
```

## 3. Confirmed root causes

| # | Defect | Evidence |
|---|---|---|
| C1 | **Provider key ≠ provider display.** `provider_type_key` is looked up **live** from `recruiter_provider_memberships` at `first_work_date` (`__unknown__` when no membership covers it), while `provider_type_display` reads the **stored** `e.provider_type`. When a membership does not cover `first_work_date`, the key is `__unknown__` but the display is HRP/Vendor → chart/filter drift. | `direct_entry_reporting_facts_v01` (view), `direct_entry_reporting_de_options_scoped()` |
| C2 | **Recruiter key is date-scoped.** `recruiter_key` = `direct_entry_reporting_recruiter_alias_key(recruiter_id, first_work_date)` → `__unknown__` whenever no alias interval covers `first_work_date`, so a real recruiter is classified "Không xác định". | same view + helper |
| C3 | **Cutoff is a magic neutraliser.** #89 set the cutoff to `2000-01-01`; the DE side (`first_work_date >= 2000-01-01`) is then a no-op, but the legacy side (`business_date < 2000-01-01`) silently drops **all** legacy rows. `first_work_date` is still formally a cutoff filter. | `20261014150000_p2_w04d_cutoff_2000_01_01.sql`; view filter |
| C4 | **The `provider_type_display` CASE is already the "unknown" rule.** Contract 4 (unknown only for genuinely missing/invalid) is satisfied by the stored column; only the key must switch to the stored value. | view |

## 4. `provider_type` reliability — VERIFIED TRUSTWORTHY (not a blocker)

- `direct_entries.provider_type` is `text not null check (provider_type in ('hrp','vendor'))` (foundation `20261002170000:219`).
- The write guard trigger `direct_entry_validate_identity` (BEFORE INSERT OR UPDATE of `project_id, first_work_date, recruiter_id, team_id, provider_type`) requires `provider_type` to equal the recruiter's provider membership effective at `first_work_date` (exactly one, unambiguous), else `23514` (`foundation …:560-615`).
- Therefore the stored column is a **valid, write-time-validated snapshot** and equals the live lookup **at write time**. It only diverges from the live lookup if a membership is later added/back-dated — which is exactly the case the contract says must use the stored snapshot.
- Update rules: it is set by the entry create/correction RPCs from the recruiter's effective membership; the guard re-validates on every relevant update. No other path writes it.
- Conclusion: **use `e.provider_type` (stored) for `provider_type_key`** — reliable and contract-correct.

## 5. Legacy → Direct Entry ownership / overlap — UNRESOLVED (blocker)

- The reporting union splits legacy (`daily_recruitment_breakdown`, `business_date < cutoff`) from DE (`first_work_date >= cutoff`). #89 moved the cutoff to `2000-01-01`.
- Consequence: **legacy is masked to 0** and DE takes all dates. If `daily_recruitment_breakdown` still holds rows, they are silently dropped with no ownership rule and no fail-closed guard.
- Available (release-time only) evidence: W04B #44 self-protection asserted `legacy = 0`, `active non-test sources = 0`; W04C #47 asserted `legacy = 0`. No current-state evidence can be gathered here (DB access forbidden).
- Per contract 6, removing/neutralising the cutoff requires either (a) proof that legacy has no rows/active source, or (b) a clear source-ownership rule to merge. **Neither can be established from code+contract alone.** → stop.

## 6. Reuse / change matrix

| Asset | Action |
|---|---|
| `direct_entry_reporting_cutoff()` (#89) | **Owner/T0 decision** — retire or keep as a no-op (see §5) |
| `direct_entry_reporting_recruiter_alias_key(uuid,date)` | **Change** → resolve the recruiter's canonical alias **date-agnostically** (contract 3), `__unknown__` only when the recruiter has no alias at all |
| `direct_entry_reporting_recruiter_provider_key(uuid,date)` | **Replace usage** in projections by a stored-snapshot key; helper itself stays for compatibility |
| `direct_entry_reporting_facts_v01` | **Re-create** (`create or replace view`) — provider key from `e.provider_type`; recruiter via redefined helper; drop the `first_work_date >= cutoff` filter (pending §5) |
| `direct_entry_reporting_dimension_options_v01` | Same as above |
| `direct_entry_reporting_de_options_scoped()` | Same provider/recruiter-key change |
| `direct_entry_reporting_scoped_facts` / `_scoped_options` | **Unchanged** (they read the view / call the helper) — verify no inline key logic |
| `recruiters`, `recruiter_aliases`, `recruiter_provider_memberships`, `direct_entries.provider_type` | **No change** (contract 5) |
| `daily_recruitment_breakdown` | **No change** (keep data) |
| Legacy/DE read-path TS (`p2-w04a-*`) | Likely **no change** — the projection moves at the DB boundary; verify the TS date masks |
| Tests | Update the projection/route tests that pin the old key expressions; add the acceptance fixtures from the task |

## 7. Proposed minimal contract (for T0 to lock)

1. **Eligibility (DE):** `submission.state = 'SUBMITTED' AND deleted_at IS NULL`. `first_work_date` is the **statistics date only** — never a filter (contract 1). Remove `first_work_date >= cutoff` from both projections.
2. **Provider:** `provider_type_key = e.provider_type` (stored snapshot, `'hrp'`/`'vendor'`), `provider_type_display` from the same column; `__unknown__`/`Không xác định` only when the stored value is NULL/outside the domain (can't happen today, but fail-closed). (contract 2/4)
3. **Recruiter:** `recruiter_key` = the recruiter's **canonical alias `reporting_key`, resolved date-agnostically** (the recruiter's stable reporting identity, one per recruiter after #73); `recruiter_display = recruiters.display_name` (current catalog). `__unknown__` only when the recruiter truly has no alias. (contract 3/4) — **T0 must confirm this is the intended "stable identity" or name the alternative.**
4. **No auth/PII leak:** unchanged projection (no `auth_subject`/`app_user_id`/raw UUID to the browser). (contract 7)
5. **Legacy:** keep the table and any rows; **decision required** on the cutoff (§5). If legacy can still hold rows, add a fail-closed guard (or a documented source-ownership rule) rather than silently masking.

## 8. Migration / data-preservation plan

- One append-only migration, `create or replace` (view + helper + `de_options_scoped`); no `data_sources` row; no write path.
- **No** `UPDATE`/`DELETE`/`TRUNCATE`; **no** back-dating of aliases/memberships; **no** business-row change.
- Preserve the service-role-only ACLs and the `security_invoker = false` posture; keep all self-checks (column layout, grants, helper privileges, `SECURITY DEFINER` on table-reading helpers).
- Rollout: migration → read-path/option consumers unchanged → tests. Rollback: re-`create or replace` the prior view/helper definitions (append-only forward fix).

## 9. Test / mutation plan (proposed)

- Fixture: SUBMITTED, non-deleted entries with `first_work_date` **before** the (former) cutoff and before any alias/membership `valid_from` → still counted; provider from the stored column; recruiter from the stable key + current display.
- Change a `provider` membership / add a future `valid_from` / extend alias history → **no** change to the classification of existing facts.
- Genuinely missing provider/recruiter → still unknown.
- Totals unchanged by the classification change; no dropped/duplicated rows.
- Legacy empty vs non-empty: non-empty must **fail closed** if no ownership rule.
- Mutation probes: reintroduce the cutoff; look up membership/alias by date; drop/duplicate a row.
- Gates: focused + regression, `pnpm db:migrate -- --offline`, typecheck, lint, build, `docs:check`, `secrets:check`, `git diff --check`. (DB-dependent gates need `node_modules` — see §10.)

## 10. Gates status

| Gate | Result |
|---|---|
| `git diff --check` | PASS (docs-only) |
| `pnpm secrets:check` | PASS |
| `pnpm docs:check` | **not runnable** — isolated worktree has no `node_modules` |
| `pnpm db:migrate -- --offline` | **not runnable** — no `node_modules` |
| typecheck / lint / build | not applicable (no source change in this preflight) |

## 11. Owner UAT checklist (checklist only; T1 does not UAT)

- [ ] With the image's figures, the dashboard totals read **416 / 405 / 11** as the expected check (recorded from the image; **not** hard-coded in migration/test).
- [ ] A SUBMITTED entry whose `first_work_date` predates the old cutoff is still counted.
- [ ] Provider grouping matches the entry's stored provider (HRP/Vendor), consistent with the displayed label.
- [ ] A recruiter whose alias/membership history does not cover `first_work_date` is still grouped under the recruiter, not "Không xác định".
- [ ] Genuinely missing provider/recruiter still show unknown.
- [ ] Totals are unchanged by the classification change; no dropped/duplicated rows.
- [ ] Filters, charts, group-by reports and export all agree.

## 12. Open decisions (Owner/T0 must lock before implementation)

| ID | Decision |
|---|---|
| **OPEN-1** | The **stable recruiter key** when dropping the date-scoped alias lookup (contract 3/7): canonical `recruiter_aliases.reporting_key` (date-agnostic) vs another stable identity. |
| **OPEN-2** | Legacy **ownership/cutoff**: retire the cutoff and merge (needs proof legacy is empty / an ownership rule) vs keep a fail-closed guard when legacy is non-empty. Requires current-state DB evidence (not obtainable here). |
| **OPEN-3** | Whether to keep `direct_entry_reporting_cutoff()` at all (and its `#89` `2000-01-01` value) or formally retire it. |
| **OPEN-4** | Confirm the image expectation `416/405/11` is the post-fix UAT baseline (and which of the three figures maps to which metric). |

## 13. Boundary

Read-only preflight. No source/SQL/test change, no DB access, no migration apply, no merge, no deploy, no UAT. Primary checkout untouched. Only this handoff is written.
