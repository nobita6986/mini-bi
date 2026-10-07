# P2 Direct Entry reporting dimension classification hotfix (Handoff)

**Status:** `P2_DIRECT_ENTRY_REPORTING_DIMENSION_CLASSIFICATION_HOTFIX_LOCAL_PASS_AWAITING_T0_REVIEW`
**Base:** `origin/main@054d54360c6b94f4a8173bb8d0248019fe8d3fc9` (via P3-W05A-I01-R2 `d153f3c`)
**Branch:** `feature/p2-de-reporting-dimension-classification-hotfix`

## Symptom

The Dashboard showed "Không xác định" for the HRP/Vendor split and for Người tuyển
of the 17 imported Direct Entry rows.

## Root cause (read-only Production evidence, counts/booleans only)

| Fact | Value |
|---|---|
| reporting window (SUBMITTED, `>= cutoff 2026-09-30`) | 17 rows, work dates 2026-10-02..2026-10-05 |
| stored `direct_entries.provider_type` | hrp 6 / vendor 11 (canonical, matches the source table) |
| resolved `provider_type_key` | `__unknown__` 17/17 |
| resolved `recruiter_key` | `__unknown__` 17/17 |
| recruiter_provider_memberships | 7 recruiters, 1 row each, `valid_from = 2026-10-06` (after every work date) |
| recruiter_aliases | 0 rows for those recruiters |

`direct_entry_reporting_facts_v01` builds both dimension keys with
`direct_entry_reporting_recruiter_provider_key(recruiter_id, first_work_date)` and
`direct_entry_reporting_recruiter_alias_key(recruiter_id, first_work_date)`. Both read
the date-effective identity timeline, so an import that stored the membership period
starting on the import date and never wrote an alias row makes the whole batch fall
into the sentinel bucket. The entries themselves are NOT wrong: their provider_type
was validated at write time and still equals the membership provider in 17/17 rows.

## Source of truth (decided, not assumed)

- Provider: the entry's own stored, write-time-validated `provider_type` is the fact;
  `recruiter_provider_memberships` is the recruiter timeline that must COVER the fact.
  The timeline is wrong here (re-dated to the import date), so it is repaired.
- Recruiter: the reporting vocabulary is `recruiter_aliases.reporting_key`. It is empty,
  so the repair derives the key from the DB's own canonical code columns:
  `recruiters.personnel_code` for HRP, `recruiter_provider_memberships.vendor_id`
  (FK `vendors.vendor_id`) for Vendor.
- A read-only schema scan proves those are the ONLY places in the whole database that
  carry the reporting codes: `recruiters.display_name` is never code-shaped, no jsonb
  payload contains them and `daily_recruitment_breakdown` (legacy vocabulary) is empty.
- No projection fallback was added: a "use the stored value when the timeline misses"
  shortcut would hide genuinely missing metadata for every other consumer (W04A facts,
  W05A scoped facts/options/filters, AI engine, exports) and could mis-group recruiters.
  The projection keeps its date-effective semantics and its `__unknown__` fail-closed.

## Change

- `scripts/lib/p2-de-reporting-dimension-repair.mjs` (new): the plan SQL, the pure
  `deriveRepairPlan()` guards, the parameterised statements, the audit statements and
  the in-transaction acceptance check. Shared by the CLI and the DB regression test.
- `scripts/p2-de-reporting-dimension-hotfix-repair.mjs` (new): `--check` (read only,
  always rolled back), `--dry-run` (runs the exact statements + acceptance check, then
  rolls back) and `--apply` (requires `P2_DE_DIM_REPAIR_CONFIRM=P2_DE_DIM_REPAIR_APPLY`,
  refuses BEFORE connecting without it, all-or-nothing when any row is refused, commits
  ONLY after the in-transaction acceptance check). Each repaired recruiter gets a
  `direct_entry_audit_events` row (`p2_de_reporting_dimension_repair`, APPLIED).
- `scripts/p2-de-reporting-dimension-hotfix-check.mjs` and `-code-scan.mjs` (new): the
  read-only evidence tools used above (counts/booleans only, never an email/UUID/name).
- Tests: `scripts/p2-de-reporting-dimension-hotfix-db.test.mjs` (8 PGlite cases) and
  `-safety.test.mjs` (5 offline cases), wired as `test:p2-de-dim-hotfix` in `pnpm test`.
- NO schema change and NO new migration.

## Acceptance fixture (derived from Production evidence, matched exactly)

| Dimension | Expected | Derived by the plan |
|---|---|---|
| provider | HRP 6 / Vendor 11 | hrp 6 / vendor 11 |
| Jahwa | 8 Vendor | 8 vendor |
| Compal | 3 HRP | 3 hrp |
| Dongyang | 3 Vendor + 3 HRP | 3 vendor + 3 hrp |
| recruiter | tu.vd 1, thinhvuong.vd 7, anhhn.td 3, dhr.vd 2, hainq.td 1, nhieunt.td 2, hao.vd 1 | identical |

`--check` on Production reports 7 recruiters to repair, 17 facts covered, 7 membership
`valid_from` re-dates, 7 alias inserts, 0 refusals, and the code split above.

## Gates

- `pnpm test:p2-de-dim-hotfix` — 13/13 (8 PGlite + 5 offline safety).
- `pnpm test:p3-w05a` — 53/53 (actor scope, filters, multi-team regression).
- `pnpm test` (canonical) — see report; `next typegen`, `typecheck`, `lint`, `build`,
  `docs:check`, `secrets:check`, `git diff --check`.
- `pnpm db:migrate --offline` / `--dry-run` — unchanged ledger (no new migration).

## Migration ordering

This branch carries 48 migrations: P2-W04C #47 (`20261008070000`) and P3-W05A #48
(`20261008080000`). This task adds none, so the count stays 48; when the pending W07D
migration (`20261008080000_p3_w07d_draft_scope_precedence.sql`, not touched here) is
integrated the ledger becomes 49 and T0 must resolve the two files sharing the
`20261008080000` timestamp.

## Remaining limits / T0 decisions

- `--apply` was NOT executed anywhere. Production still shows the 17 rows as
  "Không xác định" until T0 runs it (or approves the release lane).
- `--apply` is all-or-nothing: any refused recruiter blocks the whole operation.
  Genuinely unmapped recruiters (no membership, expired alias history, contradicting
  membership, duplicate code) stay refused and keep resolving to `__unknown__` by design.
- Only recruiters with NO alias history are repaired; an existing alias history is never
  extended with a derived code.
- The repair anchors `valid_from` on the earliest non-deleted entry work date of each
  recruiter; it does not attempt to reconstruct exact employment start dates.

## R1 (T0 static review of `d8d5caa`) - findings closed

Same branch, new commit on top; `d8d5caa` is untouched (no amend/rebase/force-push).

1. **Anchor date (finding 1).** `target_from` is now `min(first_work_date)` over the
   recruiter's facts INSIDE the reporting window (SUBMITTED, not deleted, `>=` cutoff).
   The old `targets` CTE - every non-deleted entry, Draft and pre-cutoff included - is
   gone (`min(f.first_work_date) as target_from` on the `facts` CTE). Regression:
   `R1: an older Draft or pre-cutoff row never pulls the anchor back` seeds a Draft and a
   pre-cutoff SUBMITTED row at 2026-09-25 and asserts every anchor stays 2026-10-02 and
   that the repaired membership/alias `valid_from` is exactly `2026-10-02`.
   Production `--check` reports `anchor_from_min = 2026-10-02`,
   `anchor_from_max = 2026-10-05`, 0 refusals.
2. **Reporting-key collision with an existing alias (finding 2).** The plan now counts,
   per recruiter, `recruiter_aliases` rows of OTHER recruiters that carry the derived key
   and are still effective after the anchor (`al.valid_to is null or target < al.valid_to`,
   because the new alias is open-ended). Any conflict refuses that recruiter with
   `reporting code is already used by another recruiter`. Regressions: the conflict case
   (foreign open-ended alias) and the time-bounded case (foreign alias closed before the
   anchor must NOT block). The in-batch duplicate guard is kept (reason now reads
   `... in this batch`).
3. **Audit actor and reason (finding 3).** `--apply` and `--dry-run` now require
   `--actor <app_user_id>` and `--reason <text>` (8..400 chars, refusing text that embeds an
   identifier). Both are validated OFFLINE before any connection. The actor must be an
   enabled `direct_entry_app_users` account holding an effective `recruiter_master_manage`
   or `entry_admin` grant (resolved with `direct_entry_authorization_date()`), otherwise the
   run fails closed with `ACTOR_NOT_AUTHORIZED` before touching data. The reason is created
   through the existing `direct_entry_reason()` / `direct_entry_restricted_reasons`
   mechanism, and every audit row now carries `auth_subject`, `app_user_id`, the capability
   actually held and `reason_id`. No actor is invented and no worker PII is logged.
4. **Acceptance and safe re-run (finding 4).** Acceptance now compares the WHOLE window
   against the expected post-repair distribution (`expectedDistribution()`: only the
   currently unresolved facts move to their derived key), plus fact-count invariance and the
   exact sentinel delta. A second run therefore plans nothing, writes nothing (0 statements,
   no duplicate alias, audit or reason) and still passes acceptance. Regression:
   `R1: the second run is a no-op with no duplicate alias or audit`.

R1 test evidence: `scripts/p2-de-reporting-dimension-hotfix-db.test.mjs` 12/12 (8 original
+ 4 new R1 cases) and `-safety.test.mjs` 7/7 (new operator/audit/no-op source guards).
No schema, migration, auth, permission, cutoff or reporting-scope change; the projection
still has no `direct_entries.provider_type` fallback. Production `--apply` was NOT run.
