# PRE-W2-HF-C — Global duplicate-CCCD read access

- **Status:** `PRE_W2_HF_C_GLOBAL_DUPLICATE_CCCD_READ_ACCESS_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@afd13420365bff2801f5a6731649e1c278ffb894` (preflight fetch matched; ledger 86, last `20261013120000_pre_w2_p1_worker_export.sql`).
- **Branch / worktree:** `feature/pre-w2-hf-c-global-duplicate-cccd-read-access` on a clean isolated worktree `C:\CodeApp\BI-pre-w2-hf-c-global-duplicate-cccd-read-access`. Primary checkout untouched; no rebase/amend/force-push.

## Migration #87

- `supabase/migrations/20261013130000_pre_w2_hf_c_global_duplicate_cccd_read_access.sql` — append-only; sha256 `ea471ae267dc7da4330398917c9997b0c6e96798f0b33b327c74370337e34949`. Offline validation **87/87**. No capability/scope grant, no schema change, and it does **not** re-create the report RPC.
- It `create or replace`s exactly one function: the report reader guard `direct_entry_assert_duplicate_cccd_reader(uuid, uuid)`.
  - **Before:** Full Admin triple OR `catalog_master_manage` OR `entry_privileged_edit`, **and** an effective `all` scope.
  - **After:** `perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id)` only — i.e. an authenticated session mapped to an **enabled** `direct_entry_app_user` with a unique actor mapping. Anonymous / unmapped / mismatched / disabled / ambiguous actors still fail closed with `42501` before any read. No capability, all-scope, email, display name, role label or client-provided authority is consulted.
  - The reader returns one stable authority label, `business_actor`, so every authorized actor receives the **same** global result for the same `page`/`page_size`.
  - It stays `SECURITY DEFINER`, `STABLE`, fixed `search_path`, revoked from `public, anon, authenticated, service_role`; the report RPC stays `service_role`-only with its signature, envelope, pagination, ordering, masking and projection byte-for-byte.
- Self-check (data-free) proves: one reader, ACL/search_path, the mapping-guard reuse, the absence of every old gate fragment, the stable label, the untouched report RPC boundary/`groups`/`cccd_last4`/`right(`, and that an unmapped actor is still refused with `42501`.

## TypeScript / UI

- `duplicate-cccd-report-contract.ts`: `DUPLICATE_CCCD_REPORT_AUTHORITIES = ["business_actor"]` (the validated-then-dropped internal label). **No** change to the query keys, page/group/episode keys, masking, types, `nextDuplicateCccdReportPage` or the response envelope.
- `direct-entry-page-access.ts`: `canViewDuplicateCccdReport(actor)` is now `actor !== null && actor.ok` (follows the resolved session actor; fails closed otherwise).
- `registry-capability.ts`: `duplicateCccdReportNavPredicate` returns true for every resolved actor projection, and the `duplicate_cccd_report` token is mapped.
- `registry.ts`: one new `current` nav entry `duplicate-cccd-report` (“Báo cáo CCCD trùng”) → `/dashboard?tab=duplicate-cccd`, capability `duplicate_cccd_report`, desktop+mobile; icon added to both nav renderers. It is server-side visibility only (hidden for an unresolved actor); membership is never a client-side role check.
- `dashboard-view.tsx` / `page.tsx`: for `team`/`own` audiences (recruiter, team leader, project manager) the Dashboard renders the single shared `DuplicateCccdReportPanel` when `?tab=duplicate-cccd` is requested. The BoD/`all` tab shell is unchanged (general → team → duplicate-cccd, CCCD third). `general`/`team` remain audience-gated and are never widened.
- API `GET /api/direct-entry/duplicate-cccd-report`, its route, repository, panel, pagination and `private, no-store` headers are unchanged. No second endpoint/page; the standalone `/reports/duplicate-cccd` stays gone.

## Tests + mutation

- New focused lane `test:pre-w2-hf-c-global-duplicate-cccd-read-access` (registered once in the canonical chain): contract + API (15) and access/nav + HF-C DB (11) = **26 pass**. The HF-C DB lane proves every mapped actor — admin, recruiter, team leader, project manager, and an actor with no capability at all — reads the same global report under `business_actor`, that unmapped/mismatched/disabled actors are denied, that the masked projection + pagination bounds are unchanged, and that the report stays `service_role`-only with no capability/scope grant.
- Rebaselined for the new contract (re-run green): `test:p3-1-hf-duplicate-cccd-report` (gate test → global), `test:p3-1-hf-r3-duplicate-cccd-report-ui` (contract/repository/api + access), and the navigation lanes that pin the registry size (now 6 current entries).
- Mutation evidence `scripts/pre-w2-hf-c-global-duplicate-cccd-read-access-mutation.mjs`: **7/7 RED**, byte-identical restore — (1) drop the reader mapping guard, (2) swallow the guard denial for a disabled account, (3) leak the raw CCCD, (4) leak `project_id`/internal id in the response, (5) open the general/team tab for another audience, (6) drop the page-1000 ceiling, (7) grant the report RPC to `authenticated`.

## Gates

- `next typegen` + `pnpm typecheck` (exit 0), `pnpm lint` (0 errors; 13 pre-existing warnings), `next build --webpack` (exit 0, `BUILD_ID` written), `pnpm docs:check` (6/6), `pnpm secrets:check` (clean), `pnpm db:migrate -- --offline` (**87/87**), `git diff --check` (exit 0).
- Related lanes re-run green: `test:p3-w06d`, `test:p3-w06c`, `test:p3-1-hf-admin-direct-catalog-navigation`, `test:app-nav-02a`, `test:p3-1-w04-a1-a2`, `test:p3-1-hf-mobile-theme-menu`, `test:pre-w2-p1-worker-export-backend`, `test:p1.6-i04c3-s01`, `test:p1.6-i04c2b`, and the ledger pin lanes (`p3-w05b-a-team-reporting`, `p3-1-w01d-a1a/a1b1/a1b2`, `p3-1-w02a`, `p3-1-w02b`, `p3-1-w02c` r2/r3/catalog, `p3-1-w03a-r2-account-read`, `p2.5-hf-create-rehire`, `p2.5-status-default`, `p2-de-dim-hotfix`, `p3-w05a`, `p3-w07a-r3/r4`). `test:p3-1-w02b-vendor-catalog` asserts a clean `git status` over `supabase/migrations`; it fails only while #87 is untracked and passes once committed (verified post-commit).
- Canonical `pnpm test` is **not** run in this lane (Pre-W2 integration/release owns full regression).

## Skipped / risk

- No new filter, no default change to `active_count >= 2`, no historical split, no worker-status close, no worker export/name-change change. No Production query/apply, deploy, browser/UAT or merge to main.
- `pnpm build` (Turbopack) cannot run inside this worktree (`node_modules` junction points out of the filesystem root); the documented Webpack opt-out was used.
- The nav entry is provided for every resolved actor (the task's “if the account has no Dashboard menu, add a link” case); the Dashboard menu itself is capability `any`, so this is the discoverable path for the `team`/`own` audiences whose dashboard has no tab shell.
