# P3.1-W01D-A1a1 - schema foundation: P3_1_W01D_A1A1_SCHEMA_RUNTIME_PASS_AWAITING_T0_REVIEW

Branch feature/p3-1-w01d-team-leader-lifecycle. Base f9d77c690a8430c53248daf4b1ebd5216fdcd6bb -> final (this commit). Fast-forward only; migrations #1-#70 stay byte-identical, migration #71 is the only new migration. No Production query/apply/deploy, no browser/UAT, no merge of main.

## What landed (migration #71, schema only)
Widens exactly direct_entry_scope_grants_check and direct_entry_capability_grants_check to valid_to >= valid_from (membership CHECK + capability vocabulary untouched). Replaces both uniquenesses with marker-excluding partial indexes (capability, scope, leader-by-team, leader-by-app-user). Adds public.direct_entry_team_leader_assignments and public.direct_entry_team_leader_revisions (forced RLS, revoked from every role). Adds the direct_entry_team_leader_marker() guard (flag direct_entry.team_leader_marker) with triggers on the three tables, the audit link direct_entry_audit_events.leader_revision_id, the fixed eight-key snapshot and the bounded projection, plus a closing self-check DO block.

## Evidence
Disposable PGlite 25/25: 71 migrations apply, scope/capability/membership CHECKs are >=, 23-token vocabulary intact, partial indexes carry the marker predicate, three marker guards + RLS + deny-all ACL present, raw leader/scope/capability markers 23514, two open leaders same team and one app user in two teams 23505, revision update/delete 55000, snapshot exactly the eight keys, fixture rolled back with no residue. Gates exit 0: pnpm db:migrate -- --offline = 71 valid, git diff --check, pnpm secrets:check.

## Intermediate - NOT merged / NOT applied
A1a2 must add the formal test lane + mutation checks. A1b must append the designate/replace/revoke RPC and the legacy transition inside #71 before integration (no #72). Do not merge to main until A1b is green.

Scope limit: no RPC, no list RPC, no seed EXECUTE revocation, no TypeScript/API/UI, no Production/deploy/browser.
