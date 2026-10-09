# P3.1-W01D-A1b2 — Team leader write lifecycle

> Base: `3c95af91c716de316c39bca7bab66a5122c11b78` (A1b1 read lane)
> Scope: DB-only designate, replace, revoke, transactional audit/revision, and regression coverage.

## Contract

The write surface consists of two `SECURITY DEFINER` RPCs:

- `direct_entry_designate_team_leader(auth_subject, app_user_id, team_id, leader_app_user_id, effective_date, expected_version, reason, idempotency_key)`
- `direct_entry_revoke_team_leader(auth_subject, app_user_id, team_id, effective_date, expected_version, reason, idempotency_key)`

Each RPC directly calls `direct_entry_assert_catalog_operator(auth_subject, app_user_id)` before handing input to the internal mutation helper. The wrappers accept no client-supplied capability, scope, recruiter identity, or authority. The internal `direct_entry_apply_team_leader_mutation` helper is revoked from every role; only the two public RPCs are executable by `service_role`.

The helper locks the team as the OCC root and checks `expected_version`, then locks affected app-user/grant rows and stable advisory interval keys. Designation requires an enabled target account, exactly one verified effective recruiter link, an active recruiter, exactly one effective canonical HRP provider membership, and exactly one effective membership in the requested team. The team must be active and non-reserved for designation. Cross-team or otherwise ambiguous effective leader assignments and pre-existing overlapping authority intervals are denied with `42501`; revoke remains available for an inactive business team.

Assignment, team scope, `team_manager_assign` capability, team version, immutable revision, audit event, restricted reason, and idempotency result commit atomically. Replacement/revocation close the outgoing intervals at the requested date. Same-day zero-length markers are permitted only through the transaction-local audited mutation path and remain inert in effective authority predicates. Exact idempotent replay returns its stored result; a conflicting request hash or OCC token is rejected.

The existing A1b1 current/scheduled/history read contract is retained. No second authority resolver was added.

## Evidence

- `scripts/p3-1-w01d-a1b2-leader-write.test.mjs` applies all 71 migrations to disposable PGlite and verifies designation, replacement, revocation, target eligibility, cross-team exclusion, inactive/reserved-team behavior, interval semantics, audit/revision/idempotency, rollback injection, ACL/RLS/search path, inventory, and byte identity of migrations #1–#70.
- Mutation sensitivity: all ten in-memory mutations made the focused lane fail: bypass the canonical catalog guard, allow inactive designation, allow the reserved team, remove same-team membership validation, invert cross-team assignment validation, extend outgoing authority intervals, skip OCC version validation, omit revision insertion, weaken the marker guard, and grant `authenticated` EXECUTE. The checked-in migration remained byte-identical across mutation runs; the unmutated lane passed afterward.
- Inventory measured by the PGlite lane: migration #70 has 162 Direct Entry functions (76 service-role executable / 86 internal); migration #71 has 172 (81 / 91). Relative to the A1b1 state, A1b2 adds one internal helper and two service-role RPCs. The migration ledger remains at 71; no #72 was added.
- Migrations #1–#70 remain byte-identical to the branch base.

## Gates

- Focused A1b2 lane and the A1b1, A1a, W01C-B, W01C-A, W01B, and W01A regression lanes — PASS.
- `pnpm test` — PASS, including the A1b2 lane in the canonical chain after A1b1.
- `pnpm exec next typegen`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` — PASS. Lint reports zero errors and 15 existing warnings.
- `pnpm docs:check`, `pnpm secrets:check`, and `pnpm db:migrate -- --offline` — PASS; offline migration validation reports 71 valid migrations.
- `git diff --check` — PASS.

## Not included

No legacy transition, seed revocation, TypeScript/API/UI changes, Production apply/query, deployment, or browser UAT.
