# P3.1-J00 — Security matrix and migration blast-radius baseline

> Status: `P3_1_J00_R2_SECURITY_BASELINE_PASS_AWAITING_T0`
> Base: `origin/main@7a8aa40a7a2604c76ab4c522a9050bdedfa7b2e2` (66 migrations). Design-only baseline: no source, migration, dependency, Production query or deploy in this task.
> Inputs: `docs/P3.1.md`, `docs/handoffs/p3-1-c01-catalog-policy-survey.md`, `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`, and the current auth/catalog/project migrations + test lanes on main.

## 1. Evidence

| # | Evidence | Fact that drives the baseline |
|---|---|---|
| E1 | `src/lib/auth/direct-entry-v2.ts` `CAPABILITIES`, `DIRECT_ENTRY_AUTH_CONTRACT_VERSION = "direct-entry-auth/1.2"` | 21 tokens, contract 1.2. **`catalog_master_manage` and `team_manager_assign` exist only in docs** (12 + 3 references, all inside `docs/P3.1.md` and the C01 handoff) — no code, no DB, no grant. |
| E2 | `scripts/p3-first-owner-bootstrap.mjs:300` | Hard fail closed on `capabilities.length !== 21` — the owner bootstrap breaks the moment the registry grows. |
| E3 | `src/lib/contracts/direct-entry-v1.ts` `Capability` union | A second 21-token copy that must stay in lockstep with E1. |
| E4 | `20261008110000_p2_5_w02_...sql:394` `direct_entry_assert_project_admin` | Today's only project guard: `entry_admin` + effective `all` scope; called by all 7 P2.5 project RPCs and by the W06A candidate list. |
| E5 | `scripts/p2-5-accounting-project-admin-provision.mjs:31-39` | The live Accounting operator plan **grants `entry_admin`** (reviewer bundle `change_review,pii_view,payment_view` + `entry_admin`) and forbids `payment_edit`, `employment_status.apply`, `entry_privileged_edit`, `document_*`, `pii_export`. This is the exact broad authority C01 replaces with `catalog_master_manage`. |
| E6 | `20261002170000_p1_6_direct_entry_foundation.sql:220` | `check (labor_type in ('TEMPORARY','PERMANENT'))` — `OUTSOURCED` is rejected at the DB boundary today. |
| E7 | `src/lib/contracts/direct-entry-v1.ts:20,518` | `LaborType` union + `LABOR_TYPE_INVALID` repeat the closed two-key set in TypeScript. |
| E8 | `20261008000000_p3_w07a_...sql:72` / `20261008080000_p3_w05a_...sql:649` | `personnel_position` is display-only; leader `team` scope exists only as a fail-closed seed — **no runtime designate/revoke, no one-leader-per-team constraint**. |
| E9 | `src/lib/navigation/registry-capability.ts:5,65` | Nav comments still say "21 token" and describe the admin predicate as `entry_admin` + all scope — both must be re-baselined. |
| E10 | `20261008000000` `direct_entry_input_catalog` | Vendor recruiters already project `provider_type='vendor'`, `team_id=null`, `team_display_name=null`; labor type is not yet a catalog projection. |
| E12 | `20261002170000_p1_6_direct_entry_foundation.sql:77-83` | `direct_entry_capability_grants.capability` carries an inline **CHECK over exactly the 21 tokens**. An unknown token is rejected by PostgreSQL with **SQLSTATE 23514** — grants are *not* free-form text. W01A (#67) must drop/recreate this constraint as 23 tokens while preserving all 21 existing tokens and every existing grant row. |
| E13 | `20261002170000_p1_6_direct_entry_foundation.sql:220` vs E12 | Two different CHECKs on two different columns: the **capability** CHECK is W01A (#67); the **`labor_type`** CHECK is W02C — the two must not be bundled. |
| E11 | `package.json:62` lane `test:p2.5-w02` | One lane only — `node --test` runs **both** `scripts/p2-5-w02-multi-manager-authority-db.test.mjs` **and** `scripts/p2-5-w02-r1-project-authority-occ-db.test.mjs`; there is **no** separate `test:p2.5-w02-r1` lane. Also reusable today: `test:p2.5-w06a`, `test:p2.5-w05`, `test:p2.5-reviewer-hotfix`, `test:p2.5-w03`, `test:p3-w07b-project-scope`, `test:p3-w05a`, `test:p3-w07a-r4`. No P3.1 lane exists. |

## 2. Blast radius of the capability expansion (21 to 23)

| Surface | Exact location | Required change on the contract bump | Risk if missed |
|---|---|---|---|
| DB CHECK constraints | **Capability**: inline CHECK over 21 tokens at `direct_entry_capability_grants.capability` (E12). **Labor type**: `labor_type in ('TEMPORARY','PERMANENT')` (E6) | W01A (#67) drops/recreates the capability CHECK as 23 tokens, keeping all 21 existing tokens and every grant row intact; an unknown token stays rejected with SQLSTATE 23514. The labor-type CHECK is a **separate W02C** migration, not part of the capability bump | Shipping the tokens only in TypeScript leaves every grant insert failing with 23514; bundling the labor-type change into #67 breaks the single-purpose contract bump |
| TypeScript unions / registries | `CAPABILITIES` (E1) + `Capability` (E3) → **W01A**; `LaborType` (E7) → **W02C** | **W01A only** adds `catalog_master_manage` and `team_manager_assign` to **both** capability registries/unions and keeps the two lists identical. **W02C — separately and later —** adds `OUTSOURCED` to `LaborType` and updates its validators. W01A changes no labor type | v1/v2 drift — the exact defect the C01-R2 matrix retracted; or a labor-type change smuggled into the single-purpose W01A contract bump |
| Auth contract version | `DIRECT_ENTRY_AUTH_CONTRACT_VERSION` (E1) + its assertion in `direct-entry-v2.test.mjs:22` | Bump to `1.3` and update the assertion | Old sessions/actors claim a contract they no longer satisfy |
| Actor / session projections | `direct-entry-v2.ts` `isValidAuthorizationRecord`, `auth-session-core.ts` `actorProjection` | No shape change needed: capabilities are already a validated array; confirm unknown tokens still fail closed | A malformed/unknown token silently widening an actor |
| Bootstrap / provisioning fixtures | `p3-first-owner-bootstrap.mjs:300` (E2), `p2-5-accounting-project-admin-provision.mjs` (E5), `p3-w07b-access-bootstrap.mjs`, `p3-w07a-catalog-bootstrap.mjs` | **W01A** updates the owner bootstrap 21 → 23 and the *desired* Accounting plan/tests to `catalog_master_manage` (code + tests only — no Production grant change). **W02** performs the actual Accounting transition (grant new → verify → revoke `entry_admin`) as one controlled, rollbackable step | Owner bootstrap fails closed on the 23-token registry; Accounting is switched before the guards support the new token, or left holding both authorities |
| Navigation predicates / comments | `registry-capability.ts:5,65` (E9) | Re-baseline the comment and add catalog/leader predicates only after the tokens exist | UI hidden/shown on a stale predicate; docs claim authority that is gone |
| Exact-token / count / parity tests | `direct-entry-v2.test.mjs` (version, capability set), any `length !== 21` assertion | Update count + parity; add an explicit "no unknown token" case | Green suite that proves the wrong contract |
| Canonical package test registration | `package.json` `test` chain | Register each new P3.1 lane **exactly once** | Lane silently unrun (the failure mode already seen in this repo) |

## 3. Allowed / denied matrix (minimum J01 set)

| Surface | Full Admin | Accounting (catalog operator) | Team leader | Project manager | Ordinary staff | Disabled / unmapped / ambiguous |
|---|---|---|---|---|---|---|
| Personnel / team / leader catalog mutate | allow (`catalog_master_manage@all` + admin triple) | allow (`catalog_master_manage@all`) | deny | deny | deny | deny |
| Team membership interval assign/move/unassign | allow | allow | deny | deny | deny | deny |
| Designate / revoke team leader | allow | allow | deny | deny | deny | deny |
| Project master create/update/set-active | allow | allow | **deny** | deny | deny | deny |
| Assign/unassign project manager (any active project) | allow | allow | own effective team only | deny | deny | deny |
| Manager candidate list | all projects | all projects | own team only, no cross-team ids | deny | deny | deny |
| Vendor create/rename/set-active | allow | allow | deny | deny | deny | deny |
| Labor-type catalog mutate | allow | allow | deny | deny | deny | deny |
| Account enable/disable | allow | deny | deny | deny | deny | deny |
| Capability / scope grants | allow | deny | deny | deny | deny | deny |
| App-user ↔ recruiter links | allow | deny | deny | deny | deny | deny |
| `entry_restore` | allow | **deny** | deny | deny | deny | deny |
| Audit explorer | bounded full audit | catalog + worker events per policy (no security-admin audit) | **own manager-assignment events only**, surfaced inside project operations — no global audit explorer | **deny** in P3.1 | **deny** in P3.1 | deny |
| Direct Entry write / submit | per existing capability | unchanged | unchanged | assignment-scoped | own scope | deny |

Undefined actor categories (disabled, missing mapping, ambiguous recruiter link, ambiguous team membership) mirror the existing repository reasons and must fail closed **before** any catalog path is evaluated.

## 4. Test inventory (reuse first)

| Existing test / fixture | Reuse for |
|---|---|
| `scripts/p2-5-w02-multi-manager-authority-db.test.mjs` | assignment history, unassign closes history, admin guard, no-overlap |
| `scripts/p2-5-w02-r1-project-authority-occ-db.test.mjs` | project-version OCC, anti-ABA, revision shape |
| `scripts/p2-5-w06a-r2-manager-candidates-db.test.mjs` | candidate projection shape/scoping |
| `scripts/p2-5-accounting-project-admin-provision.test.mjs` | Accounting bundle plan; the fixture to invert for the new narrow token |
| `scripts/p2-5-w05-review-authority-db.test.mjs`, `p2-5-reviewer-hotfix-db.test.mjs` | reviewer/Accounting split, reason/OCC/audit on decisions |
| `scripts/p3-w07b-project-manager-scope.test.mjs`, `p3-w07e-project-manager-change-requests.test.mjs` | project-scope read/propose boundaries |
| `scripts/p3-w05a-*.test.mjs` (actor-scoped reporting, multi-team regression, team-scope seed) | team audience isolation + leader scope seed |
| `src/lib/auth/direct-entry-v2.test.mjs` | capability registry, contract version, malformed-record fail-closed |
| `scripts/p2-5-hf-r5-session-identity-db.test.mjs` | migration fail-closed + version/audit patterns to copy for W01/W02 |

No new fixture framework is needed: PGlite + the existing migration ledger, actor seeds and RPC harnesses cover every case below.

## 5. Missing tests by wave (to be added later, not now)

**W01 (personnel / team / leader)**
1. Assign → move → unassign membership keeps half-open intervals and never rewrites history.
2. **Leader replacement is one atomic mutation**: designating a new leader for a team that already has one, in the same transaction, closes the outgoing leader's `team` scope and `team_manager_assign` intervals **and** opens the incoming leader's, carrying one reason, one OCC check, one idempotency key and one immutable audit trail. The post-state never has two effective leaders and never has a gap where the team is unintentionally leaderless.
3. **Designation `team` scope + `team_manager_assign` write atomically**; a failure at any step (scope, capability, audit, idempotency) rolls the whole replacement back with zero residue — no half-closed outgoing interval, no half-open incoming one. A separate, explicitly-invoked **revoke** path is still required so a team may be temporarily leaderless, and revoke must not create a replacement.
4. Revocation removes both intervals immediately and the leader loses list/assign/detail on the next call.
5. Designation fails closed for: disabled app user, no verified link, ambiguous link, no membership, membership in a different team, inactive team.
6. `personnel_position='TEAM_LEADER'` alone grants nothing.

**W02 (project / vendor / labor type)**
7. Leader candidate list returns own-team effective members only; a forged candidate id from another team is denied and never echoed.
8. Assign to an **active** project succeeds; assign to an inactive project is denied.
9. **Unassign still works after the project is deactivated**, and can cancel a future-dated open assignment.
10. Cross-team assign/unassign denied for a leader; allowed for Admin/Accounting.
11. Manager moves team: existing assignments unchanged; the old leader loses unassign authority; the new team's leader gains it.
12. Vendor create/rename/set-active keeps history resolvable, never creates a team membership, and `vendor_id` is immutable.
13. Labor-type catalog: three seeded keys with orders 10/20/30, keys immutable, label rename allowed, deactivate removes it from new writes but historical rows still read.
14. `OUTSOURCED` accepted by Direct Entry create, change request, import/template and filters; unknown key fails closed; `Gia công` implies no Vendor/team/provider.
14b. **Accounting capability transition (controlled):** after W02, Accounting holds `catalog_master_manage@all` and **no** `entry_admin`; catalog/project operations still succeed; the transition is idempotent, rollbackable, and a partly-applied run leaves the account with its original working authority (never both tokens long-term, never neither).

**W03 (accounts / grants / links)**
15. Admin-only enable/disable, grant/scope interval mutation, recruiter-link change; Accounting and leader denied on every one of them.
16. `entry_restore` Admin-only; Accounting denied (locked rule).
17. Stale-session revocation follows the W08A behaviour after disable/revoke.
18. Audit projection is bounded and redacts PII/free text; ids only where policy allows. Separate cases: Full Admin sees the bounded full audit; Accounting sees catalog + worker events only and **no** security-admin audit; a team leader sees **only own manager-assignment events**, inside project operations, and **cannot open a global audit explorer**; project manager and ordinary staff are **denied** the audit explorer in P3.1.

**W04/W05 (non-browser structural)**
19. Nav predicates (settled expectation): a **team leader does not see the `/admin` catalog navigation at all**, and sees the **existing `/direct-entry/projects`** entry only when it holds `team_manager_assign` **and** an effective `team` scope. **Accounting sees exactly one top-level `/admin` entry** plus the existing project-operations entry. Security-admin pages stay Admin-only. No client-side authority inference anywhere.
20. Component-level: reason + OCC conflict + idempotency replay messaging; own-team-only candidate rendering; mobile/a11y attributes present.
21. No duplicate validation framework: UI reuses the server contract projections.

**J01**
22. Full allowed/denied replay against the Production-shaped ledger, migration rollback, combined Direct Entry/Dashboard regression, and a single consolidated Owner UAT checklist (Owner-executed only).

## 6. Production preflight requirements (counts/booleans only; not run in this task)

Run read-only, inside a transaction that always rolls back, and print **only**:
1. `schema_migrations` applied count and pending set (boolean: exactly one expected pending, or zero).
2. Count of app users holding `catalog_master_manage` / `team_manager_assign` (expect 0 before W01/W02 apply).
3. Count of app users still holding `entry_admin@all` that are **not** full Admin (the Accounting accounts to migrate) — boolean "any" plus a count.
4. Count of teams with more than one effective leader (must be 0 before the one-leader rule is enforced).
5. Count of leaders without exactly one verified effective recruiter link and one effective team membership (must be 0).
6. Count of `direct_entries` with `labor_type` outside the three stable keys (must be 0).
7. Count of manager assignments on inactive projects, future-dated open assignments, and expired-but-open rows.
8. Count of vendors with any team membership or team scope (must be 0).
9. Count of personnel with more than one effective team membership (must be 0).
No email, user UUID, recruiter UUID, worker name, CCCD, storage key or raw database error may be printed.

## 7. Risks / blockers

- **R1 (sequenced transition, not a blanket bypass):** Accounting currently holds `entry_admin@all` because P2.5 project operations needed it (E5). That is **broader than the C01 catalog-operator contract**, but it is **not** full Admin (the triple also needs `recruiter_master_manage` and `team_master_manage`) and it does **not** bypass every catalog boundary — the project and catalog RPCs still evaluate their own guard on every call.
  - **W01A (#67):** add the capability contract (tokens + DB CHECK 21→23 + desired-provisioning code and tests). It must **not** revoke or apply any Production grant and must **not** make Accounting lose project operations.
  - **W02:** only after the project/catalog guards accept `catalog_master_manage`, switch Accounting over as **one controlled transition**: grant the new token → verify the new authority works → revoke `entry_admin` → regression. It must be performable with rollback, must not open a window where Accounting loses project operations, and must not leave both authorities held long-term.
  - Production preflight must measure the **count of Accounting / non-full-Admin accounts still holding `entry_admin@all`** so the transition is observable before and after W02.
- **R2 (blocker for the contract bump):** the owner bootstrap hard-asserts 21 capabilities (E2); the bump must update it in the same change or the owner account cannot be provisioned.
- **R3:** there are now **three** token definitions that must agree — the DB CHECK (E12), `CAPABILITIES` (E1) and the v1 `Capability` union (E3), plus the nav comment (E9). A token added in TypeScript but not in the CHECK fails at the first grant insert with 23514; the parity test must be explicit, not incidental.
- **R4:** `OUTSOURCED` spans DB CHECK, TS union, import/template, filters and reporting mapping (E6/E7) — a partial rollout leaves historical rows unreadable or new writes rejected.
- **R5:** one-active-leader-per-team has no schema today (E8); enforcing it needs a unique effective-interval guarantee plus a decide-then-revoke path, otherwise a team can end up with zero or two leaders.
- **R6:** unassign-after-project-deactivation and future-assignment cancellation must not resurrect the historical team-attribution rewrite that W07C-R7 already retired.
- **R7:** browser UAT is Owner-only; every W01–W05 lane must stay machine-verifiable (DB + structural) so no lane depends on browser execution.
