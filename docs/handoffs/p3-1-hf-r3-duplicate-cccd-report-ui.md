# P3.1-HF-R3 — Duplicate CCCD report API/UI

- **Status:** `P3_1_HF_R3_DUPLICATE_CCCD_REPORT_UI_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@48bb83b2572ff241a9acecd2db54e53a5d245a55` (`docs(p3-w06d-s0-r1): rebaseline survey on R9 contract`), recorded at preflight (local = remote then). During this work `origin/main` advanced independently to `2a235b0` (`e7f54b4` + `2a235b0`, W06D dashboard tabs) — an external, unrelated lane; `48bb83b` remains an ancestor. This branch is intentionally based on the recorded preflight SHA and is **not** rebased onto the later main.
- **Branch / worktree:** `feature/p3-1-hf-r3-duplicate-cccd-report-ui` on a clean isolated worktree (`node_modules` is a junction to the primary checkout; see Limitations).

## Preflight

- `git fetch origin` done; `git rev-parse origin/main` = `48bb83b2572ff241a9acecd2db54e53a5d245a55`.
- Migration #74 (`supabase/migrations/20261009100000_p3_1_hf_duplicate_cccd_reporting.sql`) and `public.direct_entry_duplicate_cccd_report(uuid, uuid, integer, integer)` are present on base; the RPC is the source of truth and is **unchanged** (one new read-only consumer).
- Read: `docs/handoffs/p3-1-hf-duplicate-cccd-report.md`, `docs/handoffs/p3-1-hf-duplicate-cccd-submit-confirmation.md`, migration #74, and the existing reporting/API/page-access/navigation patterns.
- No migration, schema, RPC, DB, or dependency change. Append-only #1–#85 untouched.

## Goal and boundary

Surface the duplicate-CCCD report — previously reachable only as a database RPC — as a paginated read-only API + UI for exactly the three audiences the RPC grants (**Full Admin, Kế toán / Accounting, BoD**, with an effective `all` scope). It is a **centralized report**, separate from the "Gửi duyệt" warning modal (P3.1-HF-R1), which is **unchanged**, as are the writer paths and every other code path.

## Route / menu placement

- **Smallest placement that serves all three audiences:** a single new top-level route + one new nav entry. Neither existing area works: `/admin` excludes BoD (`admin_area` = catalog operator OR Full Admin triple), and `/direct-entry` is the entry flow. So the report gets its own `/reports` area.
- **Route:** `/reports/duplicate-cccd`
  - `src/app/reports/layout.tsx` — wraps `AppShell`, resolves the nav actor (request-scoped).
  - `src/app/reports/duplicate-cccd/page.tsx` — server gate `decideDuplicateCccdReportPageAccess({ actor })`; renders `AccessDenied` / `AccountUnavailable` / `TemporaryUnavailable` or the panel.
- **Menu entry** (registry, `src/lib/navigation/registry.ts`): `id: "duplicate-cccd-report"`, label `"Báo cáo CCCD trùng"`, `path: "/reports/duplicate-cccd"`, `capability: "duplicate_cccd_report"`, `status: "current"`, desktop + mobile visible, icon `ShieldAlert` (added to both `desktop-nav.tsx` and `mobile-nav.tsx` local icon maps).
- **Authority is not widened:** the new capability token maps to `duplicateCccdReportNavPredicate`, which mirrors `direct_entry_assert_duplicate_cccd_reader` **exactly** — no token, scope or actor gains anything the RPC did not already grant. The nav entry is only a display hint; the RPC decides.

## Authority

- `duplicateCccdReportNavPredicate` (`src/lib/navigation/registry-capability.ts`) and `decideDuplicateCccdReportPageAccess` (`src/lib/auth/direct-entry-page-access.ts`) require an effective `all` scope **and** one of: the legacy Full Admin triple (`entry_admin` ∧ `recruiter_master_manage` ∧ `team_master_manage`) · `catalog_master_manage` · `entry_privileged_edit`.
- `entry_admin@all` alone, `change_review`, leader/PM, unmapped and disabled actors are denied — the same set the RPC refuses.
- **API** (`GET /api/direct-entry/duplicate-cccd-report`, gated by `DIRECT_ENTRY_API_ENABLED` before params/session/repository): server resolves the session actor (`getDirectEntryActor`), the client never sends `auth_subject`/`app_user_id`/authority/scope. The repository calls the RPC with the server actor only.

## Projection and privacy boundary

- The repository validates the **exact RPC jsonb shape** and then emits a display projection that **drops `authority` (capability) and `project_id` (internal routing key)** before any byte leaves the server. This is the only place the RPC projection is narrowed; the display semantics (masked CCCD + counts + names + dates + status) are the RPC's.
- Returned page keys: `page`, `page_size`, `total_groups`, `total_entries`, `has_more`, `authorization_date`, `groups`. Group keys: `cccd_last4`, `cccd_length`, `profile_count`, `project_count`, `active_profile_count`, `first_work_date`, `latest_first_work_date`, `episodes`. Episode keys: `employee_code`, `display_name`, `project_display`, `first_work_date`, `latest_status`, `active`.
- **Never returned or rendered:** full CCCD (only `cccd_last4` + `cccd_length`), any UUID / `entry_id` / `worker_id`, `project_id`, `auth_subject`, `app_user_id`, email, capability/scope/authority, or raw DB error text.
- Fail-closed: malformed/unknown payloads → `UNAVAILABLE` (never a fabricated success). Denied is a real `403`, never an empty "no duplicates" page.
- Responses are `Cache-Control: private, no-store`. The page/detail is not publicly cached.
- UI status labels are produced in TS (`ON → Đang làm việc`, `UNCONFIRMED → Không xác định`, `OFF → Đã nghỉ`); SQL emits only the enum.

## UI behavior

- Clear title/description: this is the report of profiles sharing one CCCD; **view-only** (no merge/edit/delete), independent of the submit-time warning.
- No search/filter is added (the RPC contract supports none); the report's meaning is not altered.
- Pagination uses `page` (≤ 1000) and `page_size` (≤ 100, default 25) with a page-size selector (25/50/100); stable ordering is the RPC's (canonical digits, then dates).
- Explicit loading / empty / denied / unavailable / error with retry; `role=status`/`role=alert`; responsive tables with `overflow-x-auto`, captions and `scope` headings; no identifier leaks via URL, console or hidden HTML.

## Files

**New:** `src/lib/direct-entry/duplicate-cccd-report-contract.ts`, `...-repository.ts` (server-only), `...-api.ts`; `src/app/api/direct-entry/duplicate-cccd-report/route.ts`; `src/app/reports/layout.tsx`, `src/app/reports/duplicate-cccd/page.tsx`; `src/components/reporting/duplicate-cccd-report-panel.tsx`; focused tests + mutation script; this handoff.

**Modified:** `src/lib/navigation/registry.ts` (+entry, +token), `src/lib/navigation/registry-capability.ts` (+predicate), `src/lib/auth/direct-entry-page-access.ts` (+decision), `src/components/app-shell/desktop-nav.tsx` & `mobile-nav.tsx` (+icon), and the two affected nav lanes rebaselined (`registry.test.mjs`, `registry-capability.test.mjs` — 5→6 entries). **Not touched:** migration/RPC/schema, the R1 preflight modal/flow, writer paths, dashboard/W06D, `src/lib/reporting/*`, admin catalog.

## Tests

- Focused lane `test:p3-1-hf-r3-duplicate-cccd-report-ui` (contract + repository + api + navigation/access), registered **once** in the canonical `pnpm test` chain right after the R1 lane:
  - contract: query only `page`/`page_size` inside RPC bounds; exact view projection drops `authority`/`project_id`; malformed payloads fail closed; masked CCCD + status labels.
  - repository: calls only `direct_entry_duplicate_cccd_report` with the server actor + paging; `42501→denied`, `22023→invalid`, else `unavailable`; malformed → `unavailable`; no raw error leak.
  - api: gate before query/session/repo; paging bounds before session; session/actor fail-closed; **denied is 403, never an empty report**; success is the exact display projection with `no-store` and no internal identifiers; defaults 1/25.
  - navigation/access: predicate matches exactly the three audiences at `all` scope; page gate allows the three and denies the rest; registry exposes exactly one report entry; route/page/panel source boundaries.
- Mutation evidence (3 minimum probes, each must go red, then restored byte-for-byte): `scripts/p3-1-hf-r3-duplicate-cccd-report-ui-mutation.mjs`
  1. remove the all-scope gate on the report predicate → **RED**;
  2. return `authority`/`project_id` (internal identifier) to the client → **RED**;
  3. exceed the RPC paging bound (drop the `page_size` ceiling) → **RED**.
  Result: `mutation checks red: 3/3`, `sources restored byte-for-byte: true`.

## Gates

- `pnpm exec next typegen` (exit 0), `pnpm typecheck` (exit 0), `pnpm lint` (0 errors; only pre-existing warnings), `next build --webpack` (exit 0 — `/reports/duplicate-cccd` and `/api/direct-entry/duplicate-cccd-report` present), `pnpm docs:check` (6/6), `pnpm secrets:check` (clean, 1242 files), `pnpm db:migrate -- --offline` (85 migrations valid, #74 still present, no DB access), `git diff --check` (exit 0).
- Affected lanes kept green: `test:p3-1-hf-duplicate-cccd-report` (10/10), `test:p3-1-hf-r1-duplicate-cccd-submit-confirmation` (30/30), `test:p3-1-hf-admin-direct-catalog-navigation` (98/98), `test:app-nav-02a`, `test:p3-1-w04-a1-a2` (152/152), `test:p3-1-w04-c-vendor-ui`, `test:p3-1-w04-d-labor-type-ui`, `test:p3-1-w05-a-existing-account-ui`, `test:p3-1-w04-a4-team-ui`.
- Canonical `pnpm test`: it reaches `test:main` and stops at the **pre-existing G4-I** failure (`src/lib/ai/gateway/w04-g4-acceptance.test.mjs` → "G4-I: policy fail-closed (rate/concurrency/budget/policy required) — không gọi provider"; `test:main` = 447 tests, 446 pass, 1 fail). The identical single failure reproduces on base `main@48bb83b` (that file alone: 21 tests, 20 pass, 1 fail) and involves no code of mine — **G4-I is not modified**. Every lane before `test:main` passed in the canonical run (including the new focused lane), and every lane after `test:main` (`test:server`, `test:export`, and all `test:p3-1-*` lanes) was re-run individually and exited 0 (`=== ALL-REMAINING-OK ===`).

## Limitations

- The report page lives under a new `/reports` area (no existing area admits all three audiences without widening its gate); its data availability depends on the same `DIRECT_ENTRY_API_ENABLED` flag as the other Direct Entry read routes.
- `pnpm build` (Turbopack) cannot run inside this worktree because `node_modules` is a junction to the primary checkout (`TurbopackInternalError: Symlink [project]/node_modules is invalid, it points out of the filesystem root`) — a worktree/environment limitation, not a code failure. The documented Webpack opt-out was used (`node_modules/next/dist/docs/01-app/01-getting-started/01-installation.md:156`).
- No browser/UAT run; Owner-only. No merge, no Production query/apply, no deploy.
