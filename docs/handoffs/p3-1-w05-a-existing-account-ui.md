# P3.1-W05-A — Existing Account Management UI (Admin) handoff

## Status

`P3_1_W05_A_EXISTING_ACCOUNT_UI_LOCAL_PASS_AWAITING_T0_REVIEW`

## Scope

Admin UI quản lý tài khoản hiện có (Existing Account Management), tái sử dụng toàn bộ backend/API W03A đã khóa (`GET /api/admin/access/accounts`, `GET .../[accountRef]`, `POST .../[accountRef]/enable`, `POST .../[accountRef]/disable`). Không sửa backend/API/RPC/schema/migration/dependency.

- Route `/admin/access/accounts` có server page gate; nav nội bộ Admin "Tài khoản".
- Điều hướng + vào thẳng URL chỉ ALLOW Full Admin triple tại effective `all` (`entry_admin` + `recruiter_master_manage` + `team_master_manage`) — dùng `adminSecurityNavPredicate`, KHÔNG dùng `adminAreaNavPredicate` (rộng hơn, nhận cả Accounting `catalog_master_manage@all`). Không suy luận quyền phía client.
- Danh sách: tìm theo `display_name`; lọc Tất cả / Đang hoạt động / Ngừng hoạt động; phân trang có chặn; states loading/empty/denied/unavailable/error+retry.
- Chỉ render `display_name` + trạng thái. `account_ref` chỉ là định danh route/request nội bộ; `version` chỉ dùng nội bộ OCC — KHÔNG BAO GIỜ render account_ref/UUID/auth_subject/email/reason/version/capability/scope.
- Enable/disable: dialog accessible; reason bắt buộc; `expected_version` lấy từ projection có thẩm quyền; một UUID idempotency key cho mỗi intent, retry tái sử dụng cùng key; header `Idempotency-Key` khớp body.
- Không optimistic success: mutation success `{ok:true}` KHÔNG kèm projection, nên sau applied bắt buộc reload authoritative detail; applied HOẶC 409 conflict khóa tài khoản đó tới khi authoritative reload hợp lệ thành công; reload malformed/denied/transport-failed KHÔNG mở khóa (fail-closed).
- Message sanitized phân biệt: ACCOUNT_DENIED, ACCOUNT_NOT_FOUND, ACCOUNT_CONFLICT, ACCOUNT_INVALID, ACTOR_NOT_AVAILABLE, ACCOUNT_UNAVAILABLE.
- KHÔNG mở: tạo/mời/đổi mật khẩu/reset/recovery/MFA tài khoản; capability/scope editor; verified recruiter links; audit explorer; entry restore.

## Base

- Repo: `https://github.com/nobita6986/mini-bi.git`
- Worktree: `C:/CodeApp/BI-p3-1-w05-a-existing-account-ui`
- Branch: `feature/p3-1-w05-a-existing-account-ui`
- Base SHA: `6ae04f271eb8659fdcb59761674bd9d2730075aa` (= origin/main tại thời điểm giao task)
- Migration ledger: 84 migrations; #82–#84 = W03A (`..._w03a_app_user_lifecycle`, `..._w03a_r2_account_read`, `..._w03a_r2_r1_account_read_repair`).
- Ghi chú môi trường: `node_modules` trong worktree là bản `pnpm install --frozen-lockfile --offline` thật (không symlink sang checkout chính) vì Turbopack từ chối biên dịch qua path ngoài workspace root. `node_modules`/`.next` gitignored, không stage/commit.

## Files

Mới:

- `src/app/admin/access/accounts/page.tsx` — server page gate, mirror labor-types page (resolveActorForRequest → decideAccountAccessPageAccess switch).
- `src/components/admin/account-manager.tsx` — list/search/filter enabled/phân trang, states loading/empty/denied/unavailable/error/retry, dialog radix accessible, enable/disable với reason + expected_version + Idempotency-Key, lock-until-authoritative-reload (fail-closed).
- `src/lib/admin/account-access-model.ts` — strict projection tái sử dụng `projectExistingAccountList`/`projectExistingAccount` (contract W03A) + shared validators; `buildAccountListQuery`, `buildAccountStateRequest`, `classifyAccountMutation`, `newAccountIntentKey`. `{kind:"applied"}` KHÔNG kèm row → bảo đảm cấu trúc không có optimistic projection.
- `src/lib/admin/account-access-model.test.mjs`
- `src/components/admin/account-manager.test.mjs`

Sửa:

- `src/lib/admin/admin-navigation.ts` — mỗi section có predicate `visible` riêng; thêm section `accounts` ("Tài khoản") dùng `adminSecurityNavPredicate` (Full-Admin-only); các section catalog giữ `adminAreaNavPredicate` (hành vi không đổi).
- `src/lib/admin/admin-navigation.test.mjs` — expected 5 sections; Accounting thấy catalog nhưng KHÔNG thấy accounts; Full Admin thấy cả 5; highlight case `/admin/access/accounts`; registry entry `findEntryByPath("/admin/access/accounts")?.id === "admin"`.
- `src/lib/auth/direct-entry-page-access.ts` — thêm `decideAccountAccessPageAccess` dùng `adminSecurityNavPredicate`.
- `src/lib/auth/direct-entry-page-access.test.mjs` — thêm test decision mới (Full Admin triple@all → ALLOW; các actor khác → ACCESS_DENIED; UNAUTHENTICATED → REDIRECT_LOGIN; ACTOR_DISABLED/MAPPING_MISSING → ACCOUNT_UNAVAILABLE; AMBIGUOUS_* / null → TEMPORARY_UNAVAILABLE).
- `package.json` — thêm lane `test:p3-1-w05-a-existing-account-ui` và nối vào `pnpm test` đúng một lần.
- `docs/handoffs/p3-1-w05-a-existing-account-ui.md` — file này.

## Verification

- Focused lane `pnpm test:p3-1-w05-a-existing-account-ui`: 28/28 pass (account-access-model, account-manager, admin-navigation, direct-entry-page-access).
- W03A R2 account-read/API regression `pnpm test:p3-1-w03a-r2-account-read`: 10/10 pass.
- W03A lifecycle regression `pnpm test:p3-1-w03a-app-user-lifecycle`: 4/4 pass.
- Mutation probes (lane đỏ → restore byte-identical, sha256 xác minh, lane xanh lại 28/28):
  - Probe 1: bỏ Full Admin page gate (đổi `decideAccountAccessPageAccess` sang decision rộng) → fail test page gate Full-Admin-only. sha256 `direct-entry-page-access.ts` sau restore = `edee36e4637beed46c283671cf7804f4a3fd3f4ca1b86c0f2fa22ae00f19291b`.
  - Probe 2: render `account_ref` hoặc `version` → fail test render ban. sha256 `account-manager.tsx` sau restore = `94ef3eecf6c9360e1325313cf17d21fb28096dcdbc771b97fd58a4ec2afe3430`.
  - Probe 3: mở khóa ngay sau `{ok:true}` (bỏ lock applied) → fail test no-optimistic lock-until-reload.
- Regression cố định trong test: projection exact-key fail-closed (thêm key email/auth_subject, name rỗng, ref không phải UUID, version 0, enabled "true" → null); query bounded; body mutation đúng 3 key; `{ok:true}` applied không projection (`{ok:true, account}` → unavailable); 6 error code map ra message sanitized phân biệt, không lộ raw code; mỗi intent một UUID mới; page dùng server decision không client inference; nav accounts Full-Admin-only.
- `next typegen`: PASS. `pnpm typecheck`: PASS. `pnpm lint`: 0 errors, 13 warnings pre-existing ở file không liên quan. `pnpm build`: PASS (exit 0), route `/admin/access/accounts` generated.
- `pnpm docs:check`: PASS 6/6. `pnpm secrets:check`: PASS (1903 file, không secret). `pnpm db:migrate -- --offline`: PASS, 84 migrations validated, không kết nối DB. `git diff --check`: PASS.
- Canonical `pnpm test`: kết quả ghi trong báo cáo cuối của T1A (chạy trước khi push).

## Release boundaries

- Không backend/API/RPC/schema/migration/dependency thay đổi; `package.json` chỉ đăng ký lane test.
- Không Production query/apply, không deploy, không browser UAT, không merge/rebase/amend/force-push.
- Local HEAD = remote HEAD trên `feature/p3-1-w05-a-existing-account-ui`, worktree sạch tại thời điểm bàn giao.
