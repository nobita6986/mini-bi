# R1 — Migration and Cutover Plan

**Baseline:** `302ae0ac12f4c7bf39b84e0928971b2e8520d6af`  
**Rule:** New forward-only migration(s); no edits to historical migrations or ledger data.

## 1. Preconditions

Do not implement the authorization migration until all are true:

1. The corrected `R1-authorization-contract.md` and reuse of the existing worker `view` decision and `worker_export` route/RPC/audit action are locked. No new worker capability is planned.
2. S0-C2 has landed and a real PostgreSQL regression proves the runner keeps migration SQL and ledger insert in one outer transaction, including a ledger-write failure.
3. The current `main` baseline is rechecked immediately before the implementation branch is cut. Do not reset/rebase a hotfix checkout with local changes.
4. Function owner, ACL, RLS, and role assumptions are verified from the approved TEST metadata snapshot or ephemeral PostgreSQL. Do not infer runtime ACL solely from source SQL.

S0-C1 is a TEST cutover acceptance gate only; it does not block implementation or regression on ephemeral PostgreSQL.

## 2. Migration design constraints

- Put all changes in a new timestamped migration after the selected baseline. Preserve every old file and checksum.
- Preserve history. Existing `pii_view`, `pii_export`, `payment_view`, and `payment_edit` grant rows remain stored but become unused by authorization. Do not delete or remap them automatically.
- Use an explicit `is_current` marker only on authority relationships whose current state is presently inferred solely from an interval, including team-leader assignments if their request-time guards depend on them. Reuse existing `enabled`, `active`, verified-link, and revocation state where sufficient; do not add a parallel assignment table or generic state engine.
- Backfill `is_current` once, conservatively: current means `valid_from <= cutover_snapshot` and (`valid_to IS NULL` or `cutover_snapshot < valid_to`), with no revoke/cancel/disable/ambiguous state. A future `valid_to` does not close a row at the snapshot; future-start, expired/closed, revoked, ambiguous, and disabled relationships remain non-current. Preserve all source dates and history. After cutover, authorization reads only explicit current state and never compares `valid_from`/`valid_to` or worker business dates.
- Grant/activate mutations explicitly set current state; revoke/disable mutations clear it in the same transaction and the next request reads the new state. Date changes alone do not alter authority. A future-scheduled row remains non-current with no automatic clock promotion or expiry; an operator must explicitly activate a current assignment through the existing audited flow.
- The server-only `direct_entry_resolve_actor_context` currently aggregates stored capabilities. Keep its response shape or prove parser compatibility before changing it; do not make retained legacy rows cause the actor resolver to reject an otherwise valid session.
- Stop `direct_entry_account_operation_finalize_create` from provisioning the retired tokens. Do not seed a new export permission or all-scope export grant.
- Keep current RPC names, argument lists, response shapes, and service-role ACL wherever they remain semantically sufficient. Do not add a new API or policy framework for versioning.
- Do not grant EXECUTE to `PUBLIC`, `anon`, or `authenticated`. Preserve S0's function allowlist; keep internal helpers revoked from all runtime roles.
- Keep SECURITY DEFINER functions on fixed `search_path` and verify ownership/ACL in test. Do not change global or schema default privileges as part of R1.
- Recheck actor mapping inside SQL. API passes `auth_subject` from `auth.getUser()` and `app_user_id` from the server mapping; reject mismatched pairs. Browser input never selects either ID.
- Maintain RLS and service-role server boundary. No direct client table grants.

## 3. Safe cutover sequence

### Phase A — contract and compatibility proof

Freeze the token decision and list every caller of the RPCs that will change. Test the current response envelope against the existing route/client and the new route/client. If old and new app versions cannot safely share one RPC contract, use a versioned boundary only for that RPC and justify why preserving its signature is insufficient. Do not fork a general policy layer.

### Phase B — forward-only database migration on ephemeral PostgreSQL

Update active SECURITY DEFINER function definitions and current-state maintenance in forward-only migration(s). Preserve RPC ACL, fixed search paths, owner assumptions, actor mapping, assignment/revoke lifecycle, audit, status/workflow checks, output shapes, row caps, and data. Reuse existing project/team scope helpers, but make them read explicit current state only.

The migration's self-checks and PostgreSQL/PGlite regression must demonstrate:

- old history remains available to a currently assigned team/project actor, regardless of record date;
- future, expired, closed, revoked, inactive, ambiguous, and wrong-scope assignments are denied;
- a future-scheduled marker remains non-current when the test clock advances; only an explicit audited grant can make it current;
- revoke/disable changes deny the next request without an authorization-date comparison;
- any legacy date is consulted only during the one-time current-state backfill, with a separate cutover-classification test if that backfill uses it;
- the four retired field tokens do not affect profile visibility, export, or payment editing;
- actor UUID mismatch is denied;
- service-role RPC access continues, while client/PUBLIC EXECUTE remains zero;
- audit and export caps remain correct; no profile data is seeded/read in the test beyond ephemeral fixtures.

### Phase C — matching application/API cutover on TEST

Apply only to the approved TEST project after C2 has passed and a deployment mapping is confirmed for a TEST-targeted Vercel deployment. The current custom-domain deployment reports `target=production`; its alias is not a TEST cutover target until a separate approved TEST deployment mapping is established. Deploy the application version whose session, API, repository, and projections match the migrated RPC contract. Run focused tests and full CI, then S0-C1 smoke cases plus R1 cases using an approved test-only account and synthetic records. Record the exact commit, migration version, RPC ACL metadata, and smoke result. Do not use production records to test access.

### Phase D — production release gate

Production is outside this plan. Only after code review, CI, TEST smoke, and an explicit PO approval may a separate release owner schedule production migration/deploy. Production verification must be metadata-only for ACL/function identity plus approved synthetic behavior; no personnel-record access. Do not auto-run production migrations from this task.

## 4. Mixed-version behavior

The preferred path is a compatible migration that preserves existing RPC signatures and envelopes. Before applying it, prove:

| App/API | DB | Required result |
|---|---|---|
| Previous app | Previous DB | Existing baseline behavior. |
| New app | Migrated DB | Target contract, full current-scope profile, current assignment rules. |
| Previous app | Migrated DB | No crash, no client authority, no unintended data exposure or workflow bypass. If it cannot pass, do not cut over this way. |
| New app | Previous DB | Fail closed or an explicitly supported compatibility response; never silently fall back to broader client-side authorization. |

If compatibility cannot be maintained by signatures/envelopes, add only a narrowly versioned RPC/API boundary and test it. Do not grant new roles early to make an old app work. Avoid a mixed-version window in which current-state or field visibility differs across list/detail/export. Preserve compatible envelopes where safe; any retained `view_pii`/`view_payment` compatibility fields must be inert and derived only from the authorized `view` result.

## 5. Rollback and recovery

- Never edit/delete migration history or manually alter the ledger to recover a failed deploy.
- If the migration fails before commit, rely on the fixed runner's transaction to leave both schema and ledger unchanged; prove this in C2 and R1 PostgreSQL tests.
- If application rollout fails after migration, restore the previous compatible application build only if the mixed-version test passed. Keep the forward schema migration and S0 ACL intact.
- If database behavior itself must be reversed, prepare a new, reviewed forward-only compensating migration. It must not erase audit/history or widen public ACL. Production use needs explicit approval.
- Do not reset, rebase, or reuse the S0/hotfix checkout; implementation starts from the newly agreed `main` commit in a dedicated branch.

## 6. Release evidence checklist

- Approved final action list and assignment/time semantics.
- Migration diff and before/after privilege table for changed RPCs only.
- Migration runner C2 PostgreSQL test and new migration rollback-on-failure test.
- SQL actor binding, explicit-current/historical scope, revoke, future non-promotion, and cutover-backfill regressions.
- Worker detail/list/export and payment/workflow API/component regression results.
- S0 ACL regression results (`s0-a-schema-migrations-acl` and `s0-t1-c-rpc-acl`).
- Full CI results from `.github/workflows/ci.yml`.
- TEST smoke record and exact tested commit/project ref (no secrets).
- Explicit human review and approval before any production operation.

