# S0-T0 acceptance — TEST security hotfix

**Status:** Database ACL work and full CI are complete on the Product Owner-designated TEST target; PR #79 is ready for T0-authorized merge. Authenticated end-to-end workflow smoke is not verified because the application opened at login and no designated test session/account was available.

## Scope and baseline

- Initial code baseline: `c29adc58ea2b41d2ed66a908f6a66a545952986f`.
- Authorized TEST environment only: Vercel alias `https://bi2.hrpartner.vn` and Supabase ref `oyykqfxkyqhxgrfntokl`. The Vercel environment label does not override the Product Owner's TEST designation. No other ref/deployment was used.
- No production project/configuration, employee or business rows, direct live RPC, or exploit probe was accessed. Supabase validation was catalog metadata plus the explicitly authorized migration and ledger insert.

## Integrated work

| Workstream | PR/status | TEST database result |
|---|---|---|
| T1-A ledger reconciliation | PR #77 merged at `81358b7243747c0c6b02f0c9a87fe126fdf1943a` | Verified #122 DDL effects and source checksum, inserted the missing ledger record without replaying non-idempotent DDL. |
| T1-B S0-A ledger ACL | PR #78 merged at `60cc1fe2968d6085679599139a951eb98f395e39` | Ledger ACL narrowed; owner/runner retained. |
| T1-C RPC ACL | PR #79 open; code commit `8ff8b8a94db7e56c49417c13f87cc0f5afc7d23c`, report commit `17c7198e8ca44957c1de6060ffef593ebc5cc52a` | Guarded migration applied successfully after the owner-grant fix; final ACL postconditions passed. |

## Verified final TEST state

- Migration ledger has 124 entries and matches migration source through `20261020180000_s0_t1_c_rpc_acl_allowlist.sql`. T1-C checksum: `7382013e39521601ae1c08de22e7579dc289a8e113ea8c362f8be6ba66e3417f`. S0-A checksum remains `f06317af919d572cc0fe816549d2741c5442c1e6d96371800a452bf4861fd2b4`.
- `public.schema_migrations` owner is `postgres`; raw ACL is owner-only. `anon`, `authenticated`, and `service_role` have no effective table privileges. No ledger data was deleted or rewritten; only migration version/checksum rows were inserted.
- Across 302 Mini BI routines (256 SECURITY DEFINER), post-T1-C metadata reports `anon=0`, `authenticated=0`, explicit PUBLIC EXECUTE `=0`, and `service_role=140`, exactly matching the allowlist. Before T1-C the TEST counts were 273/273/273/294.
- The three executor-owned bootstrap routines remain owned by `direct_entry_catalog_bootstrap_executor`; projection is owner-only, plan/apply retain only owner and allowlisted `service_role`. Temporary SET membership used during revoke was removed before commit; original membership is unchanged. Policies, triggers, and default-ACL metadata matched before/after snapshots.
- API code continues to resolve actor identity from the authenticated server session and call through server-only service-role repositories; it does not trust client actor UUIDs. Evidence and source references are in the T1-C report.
- No default privileges were changed. Creator-default cause and the broad defaults for `postgres`/`supabase_admin` are a separately deferred S0-B decision.

## Validation and remaining acceptance gate

- Native PostgreSQL T1-C regression: 1 passed, 0 failed. S0-A tests and the listed API/reporting regression suites passed in prior CI.
- Full CI run `39360983034` on report commit `17c7198e8ca44957c1de6060ffef593ebc5cc52a` passed six PGlite shards, real PostgreSQL, static quality, typecheck, lint, migration validation, docs checks, build, secret scan, and aggregate Quality job. Prior code CI run `39360000473` also passed; PR #79 is ready for merge.
- Vercel alias navigation reached `Đăng nhập — HR Partner` at `/login?next=/dashboard`. No authenticated account/session was available, so the requested application workflow smoke set (draft/submit/delete/change request, worker directory/export, account management, reports) remains unverified. No user credential was guessed, retrieved, or transmitted.
- PostgREST schema exposure was not confirmed. Database ACL results are verified; API reachability is not claimed.

## Recovery

- Both applied migrations are forward-only and do not change business data, function ownership, policies, triggers, or default privileges. The T1-C transaction included postconditions and committed the ACL update with its ledger checksum atomically.
- If a required call is later found missing, add a reviewed grant for only that signature/role through a new forward migration, then rerun the native ACL regression and TEST metadata checks. Never restore broad PUBLIC/client grants.
- If the migration runner/operator loses ledger access, stop later migrations and use a forward repair for the verified runner role only. Do not delete/rewrite ledger rows or replay #122 DDL.
- No automatic production deployment or production migration was performed.

## Reports

- `S0-baseline-runtime-acl.md` — baseline, identity, ledger and runtime ACL evidence.
- `S0-permission-delta.md` — before/after principal matrix.
- `S0-validation-and-rollback.md` — CI, test, and recovery evidence.
- `S0-B-default-privileges-rpc-plan.md` — separate future-default decision.
- `S0-T0-orchestration.md` — scope, T1 ownership, dependency and integration log.
- `S0-T1-A-ledger-brief.md`, `S0-T1-A-ledger-report.md`, `S0-T1-B-ledger-acl-brief.md`, and `S0-A-ledger-hotfix.md` — ledger/runner details.
- `../../security/s0-t1-c-rpc-acl-report.md` — RPC inventory, exact allowlist, executor-owner fix and E/F/P evidence.
