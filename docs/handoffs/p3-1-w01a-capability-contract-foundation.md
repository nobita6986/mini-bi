# P3.1-W01A - capability contract foundation: P3_1_W01A_LOCAL_PASS_AWAITING_T0_REVIEW

Branch feature/p3-1-w01a-capability-contract-foundation. Base origin/main 7a8aa40a7a2604c76ab4c522a9050bdedfa7b2e2 -> final (this commit). Fast-forward only; no amend/rebase/force, no Production apply, no deploy, no browser/UAT, no new dependency, no sub-agent.

## Delta
- NEW supabase/migrations/20261009030000_p3_1_w01a_capability_contract_foundation.sql (#67, append-only): replaces the capability CHECK on public.direct_entry_capability_grants with the same 21 tokens plus catalog_master_manage and team_manager_assign (23). Migrations #1-#66 untouched, no account grant seeded, no helper/guard added, unknown tokens still 23514.
- src/lib/auth/direct-entry-v2.ts: DIRECT_ENTRY_AUTH_CONTRACT_VERSION -> direct-entry-auth/1.3; both tokens added to CAPABILITIES, REASON_REQUIRED_ACTIONS, VERSION_REQUIRED_ACTIONS and REQUIRED_SCOPE_KIND (catalog_master_manage = all, team_manager_assign = team). src/lib/contracts/direct-entry-v1.ts: both tokens added to the Capability union. No other registry changed, so neither token opens Direct Entry, project operations or the full-Admin triple.
- scripts/p3-first-owner-bootstrap.mjs pinned the vocabulary to exactly 21, which would have failed the sanctioned first-owner recovery path closed once the contract moved to 23; it now compares against the canonical CAPABILITIES length. Its test follows the same vocabulary and repairs a pre-existing display_name NOT NULL insert that already failed on main.
- Migration-inventory guards bumped 66 -> 67 (30 test files), including the names.length-(N) and names.at(-N) position offsets, following the same convention T0 used for #66 in commit 35e36648.
- NEW focused lane scripts/p3-1-w01a-capability-contract.test.mjs, registered exactly once as test:p3-1-w01a-capability-contract and once in the pnpm test chain. No lane was removed or duplicated.

## Evidence
- Focused lane 9/9 pass: exact 23-token DB/TS parity (effective schema CHECK + v2 CAPABILITIES + v1 union), #67 append-only with the frozen 21-token foundation intact, existing grants preserved across the extension, both new tokens accepted, unknown token 23514, contract version 1.3, reason + expected version + scope kind enforced for both tokens, an all scope never substitutes the team scope of team_manager_assign, client-supplied actor/capability/scope still rejected, and no page or nav surface opened.
- Mutation-check: removing catalog_master_manage from the migration SQL -> 3 focused tests red; removing team_manager_assign from the v1 union -> 1 red; both reverted byte-identical and the lane is green again.
- Gates all exit 0: pnpm test (49 runner invocations, 1821/1821 pass, 0 fail), next typegen, typecheck, lint (0 errors / 14 pre-existing warnings), build, docs:check (6/6), secrets:check, db:migrate -- --offline = 67 migration(s) valid, git diff --check.

## Scope limit
Foundation only: no W01B/W01C/W02 RPC, guard, project/Vendor/labor-type/API/UI work, and no capability grant created for any real account.
