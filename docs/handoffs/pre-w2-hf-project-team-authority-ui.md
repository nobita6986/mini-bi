# Pre-W2-HF Project↔Team Authority — T1A handoff (API + UI)

- **Status:** `PRE_W2_HF_PROJECT_TEAM_AUTHORITY_T1A_LOCAL_PASS_AWAITING_T0_REVIEW` (API + mapping UI + Team Leader gate + flag-gated Project Ops + focused tests + mutation probes complete)
- **Base:** `origin/main@785bafce18c1d319f9eea452c8cac10499919329` (ledger 94, PR #23 merged, migration #94 present).
- **Final SHA:** see T1A completion report (this commit includes the finalized handoff).
- **Branch/worktree:** `feature/pre-w2-hf-project-team-authority-ui` @ `C:\CodeApp\BI\.worktrees\pre-w2-hf-pt-ui`.

## Đã hoàn thành

### Server/API (mapping admin)
- `src/lib/admin/project-team-scope-contract.ts` — strict validators (grant/revoke request) + fail-closed projectors (list envelope + grant/revoke results), mirroring T1B migration #94 envelopes exactly.
- `src/lib/admin/project-team-scope-repository.ts` — service-role repository calling the 3 T1B RPCs (`direct_entry_list_project_team_scopes_admin`, `direct_entry_grant_project_team_scope`, `direct_entry_revoke_project_team_scope`); SQLSTATE classification fail-closed.
- `src/lib/admin/project-team-scope-api.ts` — pipeline: `DIRECT_ENTRY_API_ENABLED` gate → same-origin/CSRF (mutation) → content-type → authority-field refusal → exact allowlist → server session actor → repository/RPC → `private, no-store`. Grant narrowly permits the business `team_id` key through the shared generic authority validator, then the grant parser validates its UUID and exact allowlist; actor/auth_subject/app_user_id/role/scope/capability fields remain rejected.
- Routes:
  - `GET /api/admin/catalog/project-team-scopes` (list, pagination page 1..1000, page_size 1..100, project_id/team_id/include_history filters)
  - `POST /api/admin/catalog/project-team-scopes` (grant: project_id, team_id, expected_pair_version ≥ 0, effective_from optional date, reason, idempotency_key)
  - `POST /api/admin/catalog/project-team-scopes/[mappingId]/revoke` (revoke: mapping_id, expected_pair_version ≥ 1, effective_to optional date, reason, idempotency_key)

### Nav/Page gate (Team Leader)
- `projectAdminNavPredicate` mở cho `team_manager_assign` capability (Team Leader giữ menu Dự án); Admin predicate `entry_admin + all` giữ nguyên.
- `decideProjectOperationsPageAccess` dùng chung predicate — server page gate, không chỉ client nav.

### Project Operations flag-gated actions
- `project-operations.tsx` derive `canManageProjectMaster` từ server-projected `projects[0].can_manage_project_master`; "Tạo dự án", "Chỉnh sửa", "Ngừng/Kích hoạt" chỉ render khi flag true.
- Khi list RPC trả danh sách rỗng hợp lệ, `/direct-entry/projects` truyền fallback boolean do server page suy từ actor đã resolve: `(catalog_master_manage OR entry_admin) + effective all`, đúng thứ tự authority selector #72. Chỉ trạng thái `empty` mới dùng fallback; nếu có project thì dùng flag RPC từng row, còn loading/error/denied fail-closed. Team Leader chỉ có `team_manager_assign` nên không nhận fallback này. API/RPC vẫn là ranh giới quyền cuối.
- `can_assign_managers` wired vào detail view: gate "Gán quản lý" + "Thu hồi phân công" buttons.
- Mapping admin UI page: `/admin/catalog/project-team-scopes` (canonical Full Admin triple + effective `all` only, same as Account Access) — list/filter/pagination + grant/revoke dialogs; nav entry "Mapping Dự án ↔ Nhóm" is also Full Admin only. Accounting/catalog operators do not get this page or nav item.
- Mapping list accepts both project and team filters and shows the mapping-pair version. Grant lets Full Admin submit the expected pair version (0 for a never-used pair; otherwise obtain the latest version by filtering the pair with history enabled), so regrant uses the DB OCC contract instead of being hardcoded to version 0. DB/RPC remains authoritative and returns a sanitized conflict on stale versions.
- Team Leader thấy danh sách rỗng → empty state "Chưa có dự án nào" (không phải lỗi quyền).

## Tests và mutation probes đã chạy

- `pnpm test:pre-w2-hf-project-team-authority-ui`: **75/75** (API/repository 9 + UI/model/nav/page/project-operations 66). Coverage gồm valid grant with `team_id`, forbidden client authority fields, anonymous/disabled/malformed actor, Full Admin-only mapping page/nav (Accounting + `catalog_master_manage` bị chặn), Team Leader project page gate, empty-list create authority for Admin/catalog operator but not Team Leader, bounded filters, pagination/history/OCC, sanitized conflicts, and project-master/PM action flags.
- `pnpm test:pre-w2-hf-project-team-authority-db`: **8/8**, including mapped/unmapped/inactive Team Leader scope, same-day revoke, future revoke rejection, OCC/regrant, Full Admin-only grant/revoke/list, plus the local real-PostgreSQL revoke-vs-mutation concurrency test.
- `pnpm test:p3-1-w02a-team-leader-project-manager`: **3/3** (real-PostgreSQL concurrency + existing authority regression).
- `pnpm test:p3-1-hf-admin-direct-catalog-navigation`: **99/99**.
- `node scripts/pre-w2-hf-project-team-authority-ui-mutation.mjs`: **8/8 RED**, source files restored byte-for-byte (drop session, CSRF, authority-field guard; expose project-master/PM actions; broaden mapping page/nav to catalog operators; grant empty-list fallback to Team Leader).
- `node scripts/pre-w2-hf-project-team-authority-mutation.mjs`: **7/7 RED**, migration source restored byte-for-byte. This uses local test harnesses only; it did not connect to any staging/production database.

## Gates đã chạy

- `pnpm typecheck` 0 · `pnpm lint` 0 errors (warnings are pre-existing except the three new unused imports found during lint and removed) · `next build --webpack` 0 (mapping page and API routes present) · `pnpm docs:check` 6/6 · `pnpm secrets:check` clean (1,788 files) · `pnpm db:migrate -- --offline` **94/94** (offline only) · `git diff --check` 0.
- `package.json` registers the focused UI lane in `pnpm test`. It also preserves the pre-existing, unrelated `pnpm test:pre-w2-hf-ui-labels` lane in that chain.

## Owner UAT checklist (khi hoàn thành full)

1. Full Admin vào mapping admin → xem mapping hiện tại/tương lai/lịch sử, cấp/thu hồi.
2. Grant với OCC version đúng → mapping hiện; grant stale → 409 + tải lại.
3. Revoke current-date/same-day → access mất ngay; revoke future date → bị từ chối. Regrant after a prior revoke uses the current pair version from filtered history; stale version returns conflict and requires reload.
4. Team Leader mở Dự án → chỉ thấy active projects mapped; thao tác gán/thu hồi PM trên mapped project; không thấy Tạo/Chỉnh sửa/Ngừng.
5. Team Leader trên project không mapped hoặc inactive → fail closed, không thấy trong danh sách.
6. Non-Full-Admin gọi mapping API → 403.

## Chờ T0

Đã hoàn tất code/tests local, chờ T0 review độc lập và GitHub CI. Chưa merge main, chưa apply migration/DB, không deploy Vercel/VPS, không tự UAT. Full canonical `pnpm test` chưa chạy; Owner tự thực hiện UAT sau khi duyệt.
