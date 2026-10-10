# P3.1-W01D-A1b2-R1 — T0 blocker fixes

> Base: `a7eaceb4a611b71e451c818a13ea714c992d4bc0`
> Scope: repair the reserved-team SQLSTATE, enforce transactional mutation postconditions, and prove replacement rollback. No Production or application-surface work.

## Review blockers

1. **Reserved Vendor team:** before R1, `direct_entry_apply_team_leader_mutation` denied `__system_vendor__` with `42501`. It now returns exactly `23514` for both designate and revoke before idempotency reservation or any mutation. The regression checks both SQLSTATEs and verifies unchanged team/assignment/scope/capability/revision/audit/reason/idempotency state. Closing self-checks reject any read/write function source that calls `direct_entry_system_vendor_team_id()`.
2. **Missing runtime postconditions:** before R1, writes trusted their own DML without checking the resulting assignment and authority state. The helper now validates the post-state in the same transaction before team version/revision/audit/reason/idempotency completion and raises generic `55000` on mismatch, without identity data in the message.
3. **Replacement rollback evidence:** before R1, failure injection covered designate only. R1 seeds an effective outgoing leader and injects failures at replacement capability update, revision insert, audit insert, and idempotency completion; complete state snapshots and incoming/outgoing effective authority are checked after rollback. Each case then retries successfully after removing the trigger.

## Postconditions

- Designate/replace: exactly one effective target-team leader, exactly the target app user; that user is effective leader of exactly one team and it is the target team; exactly one effective target-team scope and one effective `team_manager_assign`; assignment/scope/capability start at the requested date and have identical end dates; outgoing assignment/scope/capability are no longer effective.
- Revoke: no effective target-team leader, outgoing target-team scope, or `team_manager_assign` at the requested date; the closed assignment, scope, and capability each have `valid_to = p_effective_date`. Existing future-revoke coverage confirms authority remains effective before that date.
- Both paths ignore zero-length markers in effective-date predicates. Any failed postcondition rolls back all DML in the transaction.

## Mutation and rollback evidence

- R1 behavioral mutation cases remove the exact reserved-team guard, target-team leader cardinality check, one-team-per-target check, capability interval coextension check, or scope interval coextension check. All five made the focused lane fail.
- Postcondition fault probes create a duplicate leader in the target team, a second team assignment for the incoming leader, an out-of-step capability, an out-of-step scope, or a missing target assignment. Each returned `55000` and left no rows or version/reason/revision/audit/idempotency residue.
- Migration #71 SHA-256 before and after mutation runs: `a8bcdb75a6cc498a87f63acb6051e0bc79274b845d8504f53356f834162f10da` (identical).
- Replacement rollback injection seeded an active outgoing leader with matching assignment/scope/capability. Capability-update, revision-insert, audit-insert, and idempotency-finish failures each restored the complete captured state and preserved outgoing effective authority; incoming authority was absent. Each replacement succeeded after its failure trigger was removed.
- Migration ledger: 71 entries, #71 last, no #72; the focused lane verifies #1–#70 byte-identical to the base.

## Gates

- Focused A1b2, A1b1, A1a, W01C-B, W01C-A, W01B, and W01A lanes — PASS.
- `pnpm test` — PASS, including both leader read/write lanes.
- `pnpm exec next typegen`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` — PASS. Lint reports zero errors and 15 existing warnings.
- `pnpm docs:check`, `pnpm secrets:check`, `pnpm db:migrate -- --offline`, and `git diff --check` — PASS; offline migration validation reports 71 valid migrations.

## Excluded

No migration #72, #1–#70 edits, legacy transition, seed revocation, TypeScript/API/UI, W02/W03/W04, Production query/apply, deployment, or browser/Playwright/CUA/UAT. Browser UAT remains Owner-run.
