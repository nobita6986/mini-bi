# Pre-W2-HF-D3-B/C — Account Auth/API/UI & Personnel-from-account

- **Status:** `PRE_W2_HF_D3_BC_ACCOUNT_PERSONNEL_UI_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@148333e939b780656c3e4fe9d5a52bfaebf913fc` (ledger 92). Đã merge `origin/main@2a126415`
  (migration #93 worker-directory export) vào nhánh bằng merge commit (không rebase/amend/force-push).
- **Branch/worktree:** `feature/pre-w2-hf-d3-bc-account-personnel-ui` @ `C:\CodeApp\BI\.worktrees\pre-w2-hf-d3-bc`.
- **Final SHA:** `ad885378b7e696986f5ae290dda1fe52cd59b622` (merge `21f8f95`, D3-B fixes, D3-C + pagination).

## Đã hoàn thành

### Server/API (D3-B)
- `account-operation-contract.ts`, `account-operation-repository.ts`, `account-operation-auth.ts`,
  `account-operation-api.ts` + 6 route (5 mutation + eligible-accounts read).

### UI (D3-B) — Tài khoản truy cập
- `account-operation-ui-model.ts` (validator login canonical, password 8..1024 byte + confirm, classify intent states).
- `account-manager.tsx`: **Tạo tài khoản**, **Sửa tên hiển thị**, **Đặt lại mật khẩu** (input type=password,
  `autoComplete="new-password"`, không echo/log), và **Operation cần xử lý** + action **Đối soát** cho
  INDETERMINATE/BLOCKED/CONFLICT (không tự retry Auth khi kết quả chưa xác định).

### Tests & gates
- Lane `test:pre-w2-hf-d3-bc-account-personnel`: API (9) + UI model (4) + UI source (4) — **17/17 xanh**.
- `pnpm typecheck` 0 · `pnpm lint` 0 error · `next build --webpack` 0 · `docs:check` 6/6 · `secrets:check` clean ·
  `git diff --check` 0.
- Mutation probes `scripts/pre-w2-hf-d3-bc-account-personnel-mutation.mjs` — **3/3 RED**, byte-identical:
  1. bỏ kiểm tra provenance (finalize APPLIED dù marker lệch); 2. claim thua vẫn gọi Auth lần hai;
  3. lộ password trong response. (Full Admin gate do RPC `direct_entry_assert_actor_app_user_admin` enforce;
  probe DB đã có trong `scripts/pre-w2-hf-d3-a-account-personnel-mutation.mjs`.)

## Review fixes (đã xử lý)

- **Finish authoritative:** mọi nhánh create/reset đều kiểm tra kết quả `repository.finish`; finish lỗi →
  `ACCOUNT_OPERATION_UNAVAILABLE` (500), không trả success/terminal giả và **không gọi lại Auth**. Intent
  ở lại `IN_FLIGHT`; reclassify sẽ chuyển `INDETERMINATE` sau 15 phút rồi operator đối soát.
- **Reclassify:** thêm `POST /api/admin/access/accounts/reclassify` (session + CSRF) gọi RPC
  `direct_entry_account_operation_reclassify` hiện có; UI có nút "Phân loại lại" trong Operation surface.
  Khi Full Admin mở danh sách tài khoản, reclassify chạy **một lần** (ref guard, empty deps) — không chạy
  lại khi đổi search/page/filter và không lặp; lỗi hiển thị copy sanitized. Không cron, không migration,
  không grant mới.

## D3-C (đã hoàn thành)

- Danh mục nhân sự: thay "Thêm nhân sự" tự do bằng **"Tạo nhân sự từ tài khoản"**.
- Create dialog tải `GET /api/admin/catalog/personnel/eligible-accounts` (chỉ projection
  `app_user_id` + `display_name`), chọn account → đọc OCC version từ `GET /api/admin/access/accounts/[ref]`
  → `POST /api/admin/catalog/personnel/from-account` với `account_ref` + `expected_account_version`.
  `display_name` luôn do server lấy từ account (form không gửi tên).
- Đóng `POST /api/admin/catalog/personnel` (chỉ còn GET) — free-create trả 405. List/update/set-active/
  team-management giữ nguyên.
- Test: focused D3-BC (account-driven flow + taxonomy + closed endpoint), personnel regression
  `test:p3-1-w04-a1-a2` 153/153.
- Phân trang selector account (trang 1..1000, page_size 25) dùng metadata response; đổi trang xóa
  selection/version cũ và bỏ qua response detail stale.

## Rủi ro

- `createAuthAccount` dùng `app_metadata.account_intent`; reconcile tìm Auth user bằng `listUsers` (pagination,
  bounded 5 trang). Nếu số user lớn vượt 5000, reconcile có thể cần T0 xác minh thủ công.
- Không hiển thị/log mật khẩu/auth_subject/intent_token; không đổi email/login; không xóa account; không
  default password.

## Owner UAT checklist (D3-B)

1. Full Admin vào **Tài khoản truy cập** → **Tạo tài khoản**: nhập mã đăng nhập, tên, mật khẩu + nhập lại, lý do →
   tạo; đăng nhập bằng `<mã đăng nhập>@hrpartner.vn` + mật khẩu mới.
2. Xác minh account mới chưa tự có capability/scope/personnel.
3. **Sửa tên hiển thị** trước và sau khi gắn personnel; OCC conflict phải báo và yêu cầu tải lại.
4. **Đặt lại mật khẩu**: mật khẩu cũ bị từ chối, mật khẩu mới đăng nhập được.
5. Actor không đủ Full Admin nhận 403; BoD/Kế toán không tự có quyền.
6. Kiểm tra audit/revision không chứa password/email; không có password/auth_subject trong UI/log.

## Owner UAT checklist (D3-C)

1. Vào **Danh mục nhân sự** → nút chỉ còn "Tạo nhân sự từ tài khoản".
2. Chọn account đang hoạt động chưa liên kết → nhập mã, vị trí STAFF/TEAM_LEADER, ngày hiệu lực, lý do → tạo; tên hiển thị đúng bằng tên account (không nhập tay).
3. Account đã liên kết / ngừng hoạt động không xuất hiện trong danh sách chọn (hoặc bị từ chối).
4. Gọi trực tiếp `POST /api/admin/catalog/personnel` → phải bị 405 (free-create đã đóng).
5. TEAM_LEADER chỉ là thuộc tính hồ sơ, không cấp quyền.

## Chờ T0

Không merge main, không apply migration/DB, không deploy Vercel thủ công, tuyệt đối không deploy/truy cập VPS.
