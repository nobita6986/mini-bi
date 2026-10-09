# P3.1-W01D-A1b3 — Legacy leader transition

> Base: `5fad15fd47cf60379fb8a05e0d650923d741de08`
> Branch: `feature/p3-1-w01d-team-leader-lifecycle`
> Scope: migration-time controlled transition from legacy W05A team scopes to canonical leader authority, and retirement of the old seed's executable authority. No Production or application-surface work.

## Transition contract

Migration #71 builds its candidate inventory at `direct_entry_authorization_date()` from every effective `team` scope without an effective `team_manager_assign` capability. The inventory size is database-derived; there is no production-count constant. Before any persistent write, every candidate must have an enabled app user, exactly one verified effective recruiter link, an active recruiter, exactly one canonical effective HRP provider membership, exactly one effective membership in the scope's team, and one active non-reserved business team. The helper also rejects multiple effective team scopes and overlapping capability or leader-assignment intervals.

Only after the full candidate set passes validation does the transition lock each team aggregate and create its leader assignment and `team_manager_assign` grant. Both start at the canonical transition date and share the legacy scope's `valid_to`; the legacy scope row is never updated, closed, re-dated or deleted. It does not fabricate authority before the transition date.

Each transitioned team receives one version bump, one fixed eight-key revision with action/change `transition`, and one system migration audit event with null human actor, action `team_leader_legacy_transition`, outcome `APPLIED`, capability `team_manager_assign`, scope kind `team`, and only the opaque team reference. No user identity or PII is written to the audit event.

Runtime postconditions check assignment/scope/capability cardinality and date alignment, the unchanged legacy scope row, canonical read-resolver acceptance, zero scope-only and capability-only authority, and no actor leading multiple teams or team having multiple leaders. All failures raise a generic fail-closed error in the same migration transaction. A replay sees an empty inventory and creates no assignment, capability, revision, audit event, or version bump.

## Evidence

- The existing PGlite leader-write lane applies all 71 migrations. Variable legacy inventories of **1** and **3** candidates both transition completely; assignment and capability `valid_from` equal the transition date, and full `to_jsonb` snapshots of legacy scopes are unchanged.
- Each transitioned team has exactly one version increment, one transition revision and one system audit event. Every transitioned actor is accepted by the canonical read-authority resolver. Replay is a no-op.
- Invalid/ambiguous links, provider identities, memberships, teams, scopes and leader assignments abort the complete transition. Failure injection at assignment, capability, revision and audit writes leaves zero residue; invalid candidate tests also verify the legacy scope and all other persistent state remain unchanged.
- The existing `direct_entry_seed_team_scope_grants()` function remains present and is not dropped. Migration #71 revokes `EXECUTE` from `public`, `anon`, `authenticated` and `service_role`; its closing self-check verifies presence and the complete revoked ACL. No later migration or source test calls the legacy seed.
- The migration helper is internal `SECURITY DEFINER`, pins `search_path = pg_catalog, public`, is revoked from all roles, and does not read `personnel_position`. Migration #71 invokes it once with the canonical authorization date.
- Measured Direct Entry inventory: #70 **162 total / 76 service-role executable / 86 internal**; #71 **173 / 80 / 93**. A1b1 adds one internal read resolver and three service-role read RPCs; A1b2 adds one internal mutation helper and two service-role write RPCs; A1b3 adds one internal transition helper. Revoking the legacy seed's service-role grant moves that existing function from the service-role inventory to the internal inventory. The migration ledger remains **71**; there is no #72.
- Migrations #1–#70 are byte-identical to the base. Migration #71 SHA-256 before and after the mutation probes: `85A71FA4CAF541F1E0AF8045F5201FD68078B3A9FA8FBFF8AAB555D2DE0F6D7A` (identical).

## Mutation sensitivity

All seven in-memory mutations made the focused lane fail; the checked-in migration remained byte-identical:

1. Hard-code the candidate inventory size.
2. Backdate the capability to the legacy scope start.
3. Write capability rows before validating every candidate.
4. Omit the assignment insert.
5. Remove the one-team/one-leader postconditions.
6. Omit the legacy seed ACL revoke.
7. Make transition replay non-idempotent.

After each mutation probe, the migration hash matched the pre-probe hash. The unmutated A1b2 leader-write lane then passed again.

## Gates

- A1b2 leader-write, A1b1 leader-read, A1a schema, W01C-B, W01C-A, W01B and W01A focused lanes — PASS.
- `pnpm test` — PASS.
- `pnpm exec next typegen`, `pnpm typecheck`, `pnpm lint`, `pnpm build` — PASS. Lint reports 0 errors and 15 existing warnings.
- `pnpm docs:check`, `pnpm secrets:check`, `pnpm db:migrate -- --offline` — PASS; offline validation reports 71 valid migrations.
- `git diff --check` — PASS.

## Excluded

No migration #72, changes to migrations #1–#70, Production query/apply, deployment, browser/Playwright/CUA/UAT, TypeScript/API/UI, seed re-execution, A2, W02, W03 or W04. Browser UAT remains Owner-run.
