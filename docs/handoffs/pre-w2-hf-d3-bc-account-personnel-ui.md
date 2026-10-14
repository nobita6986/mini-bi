# Pre-W2-HF-D3-B/C — Account Auth/API/UI & Personnel-from-account

- **Status:** `PRE_W2_HF_D3_B_ACCOUNT_UI_DONE_C_PENDING` (D3-B hoàn tất; D3-C chưa làm)
- **Base:** `origin/main@148333e939b780656c3e4fe9d5a52bfaebf913fc` (ledger 92). origin/main sau đó đã tới
  `2a126415` (migration #93 worker-directory export + rebaseline pins) nhưng contract D3 + migration/RPC
  D3-A **không đổi** → không dừng.
- **Branch/worktree:** `feature/pre-w2-hf-d3-bc-account-personnel-ui` @ `C:\CodeApp\BI\.worktrees\pre-w2-hf-d3-bc`.
- **Final SHA:** `808912913cd53be91c7b71fcbe1422884587e254` (impl `f7310ca`, UI `8089129`).

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

## Chưa làm (D3-C, theo đúng yêu cầu task này)

- Chưa đổi luồng "Thêm nhân sự" tự do, chưa thêm "Tạo nhân sự từ tài khoản" (route/UI đã có sẵn
  `POST /api/admin/catalog/personnel/from-account` + `GET .../eligible-accounts` nhưng chưa wire UI).

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

## Chờ T0

Không merge main, không apply migration/DB, không deploy Vercel thủ công, tuyệt đối không deploy/truy cập VPS.
