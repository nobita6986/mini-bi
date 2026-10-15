# Pre-W2-HF Project↔Team Authority — T1A handoff (API + UI)

- **Status:** `PRE_W2_HF_PROJECT_TEAM_AUTHORITY_T1A_LOCAL_PASS_AWAITING_T0_REVIEW` (API + mapping UI + Team Leader gate + flag-gated Project Ops done; focused tests + mutation probes pending)
- **Base:** `origin/main@785bafce18c1d319f9eea452c8cac10499919329` (ledger 94, PR #23 merged, migration #94 present).
- **Final SHA:** `fd23116f785da29366a344de46545c051dfd7056`
- **Branch/worktree:** `feature/pre-w2-hf-project-team-authority-ui` @ `C:\CodeApp\BI\.worktrees\pre-w2-hf-pt-ui`.

## Đã hoàn thành

### Server/API (mapping admin)
- `src/lib/admin/project-team-scope-contract.ts` — strict validators (grant/revoke request) + fail-closed projectors (list envelope + grant/revoke results), mirroring T1B migration #94 envelopes exactly.
- `src/lib/admin/project-team-scope-repository.ts` — service-role repository calling the 3 T1B RPCs (`direct_entry_list_project_team_scopes_admin`, `direct_entry_grant_project_team_scope`, `direct_entry_revoke_project_team_scope`); SQLSTATE classification fail-closed.
- `src/lib/admin/project-team-scope-api.ts` — pipeline: `DIRECT_ENTRY_API_ENABLED` gate → same-origin/CSRF (mutation) → content-type → `validateClientBusinessPayload` authority-field refusal → exact allowlist → server session actor → repository/RPC → `private, no-store`.
- Routes:
  - `GET /api/admin/catalog/project-team-scopes` (list, pagination page 1..1000, page_size 1..100, project_id/team_id/include_history filters)
  - `POST /api/admin/catalog/project-team-scopes` (grant: project_id, team_id, expected_pair_version ≥ 0, effective_from optional date, reason, idempotency_key)
  - `POST /api/admin/catalog/project-team-scopes/[mappingId]/revoke` (revoke: mapping_id, expected_pair_version ≥ 1, effective_to optional date, reason, idempotency_key)

### Nav/Page gate (Team Leader)
- `projectAdminNavPredicate` mở cho `team_manager_assign` capability (Team Leader giữ menu Dự án); Admin predicate `entry_admin + all` giữ nguyên.
- `decideProjectOperationsPageAccess` dùng chung predicate — server page gate, không chỉ client nav.

### Project Operations flag-gated actions
- `project-operations.tsx` derive `canManageProjectMaster` từ server-projected `projects[0].can_manage_project_master`; "Tạo dự án", "Chỉnh sửa", "Ngừng/Kích hoạt" chỉ render khi flag true.
- `can_assign_managers` wired vào detail view: gate "Gán quản lý" + "Thu hồi phân công" buttons.
- Mapping admin UI page: `/admin/catalog/project-team-scopes` (Full Admin only) — list/filter/pagination + grant/revoke dialogs; nav entry "Mapping Dự án ↔ Nhóm".
- Team Leader thấy danh sách rỗng → empty state "Chưa có dự án nào" (không phải lỗi quyền).

## Chưa hoàn thành (cần tiếp tục)

1. **Focused tests** — API/repository/UI/nav/page-gate tests cho Admin, Team Leader mapped/unmapped, anonymous, actor không hợp lệ, mapping rỗng, phân trang, grant/revoke, OCC conflict, cùng-ngày, ngày revoke tương lai.
2. **Mutation probes** — bỏ session/CSRF; tin authority từ client; cho leader xem unmapped/inactive; mở project-master actions; grant/revoke bằng non-Full-Admin; lộ danh sách ngoài mapping.

## Gates đã chạy

- `pnpm typecheck` 0 · `pnpm lint` 0 errors (16 warnings pre-existing) · `next build --webpack` 0 · `git diff --check` 0 · `pnpm db:migrate -- --offline` **94/94**.

## Owner UAT checklist (khi hoàn thành full)

1. Full Admin vào mapping admin → xem mapping hiện tại/tương lai/lịch sử, cấp/thu hồi.
2. Grant với OCC version đúng → mapping hiện; grant stale → 409 + tải lại.
3. Revoke current-date → access mất ngay; revoke future date → bị từ chối; revoke same-day → cancellation marker.
4. Team Leader mở Dự án → chỉ thấy active projects mapped; thao tác gán/thu hồi PM trên mapped project; không thấy Tạo/Chỉnh sửa/Ngừng.
5. Team Leader trên project không mapped hoặc inactive → fail closed, không thấy trong danh sách.
6. Non-Full-Admin gọi mapping API → 403.

## Chờ T0

Không merge main, không apply migration/DB, không deploy Vercel/VPS, không tự UAT.
