# T0 orchestration — S0 test deployment

## Scope and environment

- Initial S0 source baseline: `c29adc58ea2b41d2ed66a908f6a66a545952986f`. T1-A PR #77 merged at `81358b7243747c0c6b02f0c9a87fe126fdf1943a`; S0-A PR #78 then merged at `60cc1fe2968d6085679599139a951eb98f395e39`. Final S0 validation uses the updated `main`.
- Product Owner designates Vercel `bi2.hrpartner.vn` and Supabase ref `oyykqfxkyqhxgrfntokl` as the authorized test environment. No other Supabase project or deployment is in scope.
- The Product Owner authorizes migration/application and regression testing only on that test database/deployment. Database reads are limited to migration ledger and catalog/runtime metadata; do not read personnel rows.
- S0-A files are committed and PR #78 is merged. The migration is applied on the authorized TEST ref. Generated `supabase/.temp/` state remains excluded from commits.

## Task briefs and ownership

| Workstream | Branch/worktree | Ownership | Shared-database gate |
|---|---|---|---|
| T1-A — ledger integrity | `codex/s0-t1-a-ledger` / `C:\Users\Admin\.codex\worktrees\s0-t1-a\BI` | Ledger/source/checksum verification; runner/operator behavior; migration-position tests. Do not edit S0-A or RPC ACL migrations. | First. Verify source #1–#122 and runtime ledger. If drift exists, document exact evidence and use a verified, minimal reconciliation on the test DB; do not rerun non-idempotent DDL or invent checksums. |
| T1-B — S0-A ledger ACL | `codex/s0-schema-migrations-acl` / `C:\Users\Admin\.codex\worktrees\s0-ledger-hotfix\BI` | Review/refine `20261020150000_s0_a_schema_migrations_acl.sql`, its test and S0-A report. Do not change historical migrations or RPC ACL. | After T1-A confirms/reconciles ledger. Apply only S0-A, then check owner/operator/runner and denied runtime grants. |
| T1-C — RPC ACL | `codex/s0-t1-c-rpc-acl` / `C:\Users\Admin\.codex\worktrees\s0-t1-c\BI` | Inventory RPC callers and definer functions; propose an evidence-based allowlist; own new RPC ACL migration/tests and S0-B/default-privilege recommendation. Do not edit S0-A files. | Read-only metadata may run alongside A. Apply only after B finishes, using a reviewed explicit allowlist. Defer broad default-privilege changes into a separate decision/PR. |

## Integration sequence

1. T0 checks main remains at the baseline and keeps the root checkout untouched.
2. T1-A records ledger count, version and checksum comparison, #122 effects, migration runner/operator permissions and any proven drift. No guessed ledger repair.
3. T1-B reviews/tests S0-A locally while A checks the shared DB. Apply S0-A only after A reports ready.
4. T1-C develops and tests RPC changes on isolated PostgreSQL while A/B work. Review API server callers, session-derived actor identity, trigger/policy dependencies and all existing client RPC calls before finalizing the allowlist.
5. After B verifies the test DB, T0 reviews C's migration and ACL delta, then schedules its single shared-DB apply. Verify catalog grants and server-side path without reading business data.
6. Run the full CI matrix on the integrated branch, then authorized test-environment smoke checks for the listed business workflows. Do not run migrations against any other project or deploy to another environment.
7. T0 reviews and integrates only scope-complete, passing PRs into main; report PR, migration and test environment status. R1 remains out of scope.

## Acceptance evidence

- Ledger source/runtime match with checksums and #122 effects accounted for.
- `schema_migrations` excludes `PUBLIC`, `anon`, `authenticated`, and `service_role`; owner and documented operator can still perform runner operations.
- Internal RPC ACL matches the reviewed allowlist; client roles cannot execute internal RPCs; required server-side paths and session actor binding remain intact.
- New objects do not inherit broad runtime grants unintentionally. Any default-privilege change is narrowly scoped to verified creator roles/schema, or explicitly deferred with a documented guard and separate decision.
- Local ephemeral DB tests, full CI, and authorized test smoke checks pass; no personnel data was accessed.

## Execution update (2026-10-20)

- **T1-A complete:** the DB had the #122 migration effects but lacked its custom-ledger row. T1-A verified checksum `2a4d37d591d8aa88d7ab00a9ad0696723e49a4577f430f237b86a619f5d2f15c` and catalog effects, then reconciled the row without replaying non-idempotent DDL. PR #77 is merged.
- **T1-B/S0-A complete:** PR #78 is merged with all CI checks green. Test-ref ledger is at 123 rows, latest version S0-A, checksum `f06317af919d572cc0fe816549d2741c5442c1e6d96371800a452bf4861fd2b4`. Effective ledger rights for anon/authenticated/service_role are all false; owner postgres remains.
- **T1-C implemented and applied to TEST:** PR #79 contains the reviewed Mini BI RPC EXECUTE allowlist migration and native PostgreSQL regression. The first guarded apply rolled back on a grantor/owner mismatch; a transaction-scoped role-membership repair was tested and applied. CI run `39360000473` passed before the documentation closeout commit; see the acceptance report for the final run.
- **S0-B defaults:** no default privileges were changed. The database has schema-specific defaults for postgres and supabase_admin; creator-specific hardening remains a separate decision, while the RPC regression checks that current/later Mini BI routines do not expose EXECUTE to PUBLIC/anon/authenticated.
- No personnel rows or live RPCs were used. The TEST alias `https://bi2.hrpartner.vn` opened the login page; no test-authenticated session/account was available, so business-workflow smoke checks remain unverified. See `S0-T0-acceptance.md` for final CI, apply, and acceptance status.

## Final TEST integration state (2026-10-20)

- TEST ledger: 124 rows, source/checksum reconciled through `20261020180000_s0_t1_c_rpc_acl_allowlist.sql`; S0-A and S0-T1-C checksums are recorded in the reports.
- TEST ACL after S0-T1-C: no effective `anon` or `authenticated` EXECUTE and no explicit PUBLIC EXECUTE on the 302 Mini BI routines; `service_role` has the exact 140-signature allowlist. The ledger is owner-only for `postgres`; runtime-role table privileges remain denied.
- CI and the native PostgreSQL regression passed on PR #79 before the final report-only commit; the resulting CI run must pass before merge.
- The application alias resolves to the login page. Authenticated workflow smoke is blocked on access to a designated test account/session; no credentials were guessed or retrieved.
- Default-privilege changes are deferred to separate S0-B review. The CI migration-chain test enforces object-level Mini BI RPC ACLs; it does not fix shared creator defaults.
- No production project, migration, configuration, business-row read, or direct RPC invocation was used.
