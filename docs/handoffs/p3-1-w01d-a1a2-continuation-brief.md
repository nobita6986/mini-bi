# P3.1-W01D-A1a2 — continuation brief (for a fresh session)

> **This is NOT the A1a2 handoff and must never be cited as evidence of completion.** The A1a2 deliverable is
> `docs/handoffs/p3-1-w01d-a1a2-schema-regression.md` and only the session that finishes the work may write it.
> This file exists because A1a2 was **not started**: the previous turn ran out of working budget after preflight.

## 0. State handed over (verified, do not re-verify from scratch)

| Item | Value |
|---|---|
| Worktree | `C:\CodeApp\BI-p3-1-w01d-team-leader-lifecycle` |
| Branch | `feature/p3-1-w01d-team-leader-lifecycle` |
| HEAD = remote branch HEAD | `6500eea2538a16173d56ba59631c30ed31d9779f` (A1a1, T0-reviewed and accepted) |
| Base of the whole wave | `main@f9d77c690a8430c53248daf4b1ebd5216fdcd6bb` |
| Worktree state | **clean** (nothing written by the stopped turn) |
| Ledger | **71** migrations; last = `20261009070000_p3_1_w01d_team_leader_lifecycle.sql` (#71) |
| #1–#70 identity | `git diff --name-only f9d77c690a8430c53248daf4b1ebd5216fdcd6bb HEAD -- supabase/migrations` returns **nothing except #71** → #1–#70 byte-identical |
| Lane `test:p3-1-w01d-a1a-leader-schema` | **not registered** (0 hits in `package.json`) |
| Status claim | **not made** — `P3_1_W01D_A1A2_REGRESSION_PASS_AWAITING_T0_REVIEW` is withheld |

Note: the shared checkout `C:\CodeApp\BI` sits on a stale local `main` (`4b93313`). Always verify against `origin/main`, not that worktree.

## 1. What A1a1 already shipped inside #71 (read the file; it is the ground truth)

`supabase/migrations/20261009070000_p3_1_w01d_team_leader_lifecycle.sql` contains the leader **schema foundation only**:

- `public.direct_entry_team_leader_assignments` (assignment_id, team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, created_at; half-open interval, `valid_to = valid_from` is an inert cancellation marker; forced RLS; revoked from every role).
- `public.direct_entry_team_leader_revisions` (+ the reference column added to `direct_entry_audit_events`; forced RLS; immutable trigger reusing the canonical immutability function).
- Widened `direct_entry_scope_grants_check` and `direct_entry_capability_grants_check` from `>` to `>=`, with marker-excluding partial unique indexes replacing the previous uniqueness (`direct_entry_scope_grants_start_uidx`, and the capability table's `unique (app_user_id, capability, valid_from)`).
- Marker guards on the three tables plus **three internal functions** (marker guard, fixed snapshot, bounded projection) and a closing self-check block.
- **Not** present (they belong to A1b): designate / replace / revoke RPCs, the current/scheduled/history read RPCs, the legacy W05A transition, and the `direct_entry_seed_team_scope_grants()` EXECUTE revocation.

Do not assume the helper names — open #71 and use the exact identifiers you find there.

## 2. A1a2 scope (nothing else)

1. Write `scripts/p3-1-w01d-a1a-leader-schema.test.mjs` — a formal DB regression that **applies all 71 migrations from scratch** in PGlite and asserts the 30 items listed in section 4.
2. Register `test:p3-1-w01d-a1a-leader-schema`: exactly one script definition, exactly one appearance in the canonical `pnpm test` chain, no existing lane lost or duplicated.
3. Rebaseline every migration-count / inventory guard that #71 invalidated (70 → 71), using the repo's own source-derived inventory helper — **never** a blind global replace, and never widen an assertion just to make it pass. Report the measured service/internal function totals.
4. Run the mutation matrix in section 5 with byte-identical restores.
5. Run the gates in section 6.
6. Write `docs/handoffs/p3-1-w01d-a1a2-schema-regression.md` (≤25 lines, delta-only) and commit on the same branch.

Explicitly **out of scope**: any new RPC, the legacy transition, TypeScript/repository/API/UI, W01D-A1b, A2, W02, W04, build/typecheck/lint (optional: run them and report separately, they are not an A1a2 blocker since no runtime TypeScript changes), Production query/apply/deploy, browser/Playwright/CUA/UAT.

## 3. Only touch #71 if the formal test finds a real blocker

If (and only if) the formal regression proves a genuine defect in #71, fix it inside #71 and record the exact before/after in the handoff. Otherwise leave the migration byte-identical, and confirm the #71 SHA256 is unchanged at the end of the mutation round.

## 4. The 30 assertions the formal test must make

1. inventory has exactly 71 migrations and #71 is last; 2. #71 append-only, #1–#70 byte-identical; 3. exactly two grant interval CHECKs were widened (`direct_entry_scope_grants_check`, `direct_entry_capability_grants_check`); 4. `recruiter_team_memberships_check` (#70) still `>=`; 5. capability vocabulary still exactly 23 tokens; 6. assignment table exact columns/FK/check; 7. revision table exact columns/FK/unique; 8. both tables enable **and** force RLS; 9. none of public/anon/authenticated/service_role hold a table privilege; 10. the four marker-excluding partial indexes carry the exact predicate; 11. the three marker triggers have the right table/event; 12. internal helpers are SECURITY DEFINER with fixed `search_path` and no role can EXECUTE them; 13–15. raw leader / team-scope / capability marker insert → 23514; 16. a valid non-marker assignment is accepted inside a synthetic transaction; 17. two non-marker rows for the same team and start date → 23505; 18. one app user on two teams with the same start date → 23505; 19. with the transaction-local marker flag on, a marker does not block a replacement interval starting the same day; 20. a marker is never effective under any date predicate; 21. revision UPDATE → 55000; 22. revision DELETE → 55000; 23. `leader_revision_id` FK exists with ON DELETE RESTRICT; 24. the snapshot has exactly the eight fixed keys for every input; 25. the snapshot contains no auth subject/email/display name/reason/grant/scope/capability; 26. the projection returns exactly the locked bounded keys; 27. the projection leaks no authority/audit internals; 28. the closing self-check exists and the migration fails if the contract drifts; 29. fixture rollback leaves zero residue; 30. no PII, user UUID, email or raw DB error text in any output.

**Cardinality wording (mandatory):** the current indexes are key/start-date foundations only. No test text or handoff may claim they resolve interval overlap. A1b still owes the team-row lock plus advisory/overlap guard and postconditions for one effective leader per team and one team per effective leader.

## 5. Mutation matrix (sequential, restore #71 byte-identical after each, lane must be red then green again)

A. scope CHECK back to strict `>` · B. remove one marker trigger · C. remove the marker predicate from one partial index · D. drop FORCE RLS on one table · E. add a key outside the fixed snapshot · F. grant EXECUTE on one helper to service_role · G. change the capability vocabulary away from 23 tokens · H. touch `recruiter_team_memberships_check`.
After the last restore: #71 SHA256 equals the committed version and the focused lane is green.

## 6. Gates

`pnpm test:p3-1-w01d-a1a-leader-schema` · the W01A, W01B, W01C-A and W01C-B focused lanes · `pnpm test` · `pnpm db:migrate -- --offline` (must report **71 valid**) · `pnpm docs:check` · `pnpm secrets:check` · `git diff --check`.

## 7. Reuse anchors already extracted (saves the next session the long reads)

- Marker pattern (#70): flag read as `coalesce(current_setting('<flag>', true), '') <> 'on'` then raise; guard revoked from every role; trigger `before insert or update`; widening done as `drop constraint <name>; add constraint <name> check (…)`; marker exclusion via partial unique index `where` predicate.
- Revision pattern (#69): `revision_id uuid primary key default gen_random_uuid()`, `unique (team_id, version)`, index on `(team_id, version desc)`, `before update or delete … execute function public.direct_entry_reject_immutable_change()`, `enable` + `force row level security`, `revoke all … from public, anon, authenticated, service_role`, audit link added as a nullable FK column with `on delete restrict`.
- Objects #71 altered, from `20261002170000_p1_6_direct_entry_foundation.sql`: `direct_entry_capability_grants(grant_id, app_user_id, capability, valid_from, valid_to, created_at)` with the auto-named `direct_entry_capability_grants_check` and table-level `unique (app_user_id, capability, valid_from)`; `direct_entry_scope_grants(grant_id, app_user_id, scope_kind, team_id, valid_from, valid_to, created_at)` with `direct_entry_scope_grants_check` plus the explicitly named index `direct_entry_scope_grants_start_uidx` on `(app_user_id, scope_kind, coalesce(team_id, '00000000-…'::uuid), valid_from)`. The capability vocabulary CHECK `direct_entry_capability_grants_capability_check` must not be touched.
- Authority guard to reuse later (A1b): `public.direct_entry_assert_catalog_operator(auth, app)` from #68 — actor mapping first, then Full-Admin triple **or** `catalog_master_manage`, then effective `all` scope; returns the exercised authority for audit.
- Evidence that the widening is ours: #70 line 63 names `direct_entry_scope_grants_check` / `direct_entry_capability_grants_check` as W01D work, and already owns `recruiter_team_memberships_check`.

## 8. Finish line

Commit on the same branch (never amend `6500eea`), fast-forward push, report base → final SHA, file delta, test/gate counts and mutation evidence, keep the worktree clean and local = remote. Claim only when every A1a2 gate is green: `P3_1_W01D_A1A2_REGRESSION_PASS_AWAITING_T0_REVIEW`. Then stop — do not open A1b, A2, W02 or W04.
