# Pre-W2-HF-D3-B/C — Account Auth/API/UI & Personnel-from-account

- **Status:** `PRE_W2_HF_D3_BC_ACCOUNT_PERSONNEL_UI_IN_PROGRESS` (server layer hoàn tất; UI còn dở)
- **Base:** `origin/main@148333e939b780656c3e4fe9d5a52bfaebf913fc` (ledger 92, chứa contract D3 + migration D3-A).
- **Branch/worktree:** `feature/pre-w2-hf-d3-bc-account-personnel-ui` @ `C:\CodeApp\BI\.worktrees\pre-w2-hf-d3-bc`.

## Đã hoàn thành (server/API, đã test + build)

Preflight xác nhận contract `pre-w2-hf-d3-account-personnel-contract-final.md` + handoff
`pre-w2-hf-d3-a-account-personnel-db-HANDOFF.md` + 9 RPC của migration #92; signature/envelope khớp.

- `src/lib/admin/account-operation-contract.ts` — validators/projectors strict (login canonical,
  password 8..1024 byte + confirm, exact-key allowlist, RPC envelopes).
- `src/lib/admin/account-operation-repository.ts` — wrapper service_role cho 9 RPC D3-A; classify SQLSTATE.
- `src/lib/admin/account-operation-auth.ts` — Supabase Auth Admin: `createUser` (email canonical
  `<login_id>@hrpartner.vn`, `app_metadata.account_intent`), `updateUserById` (reset), đọc marker qua
  Admin API (không tin JWT/client), find-by-login cho reconcile.
- `src/lib/admin/account-operation-api.ts` — pipeline session → CSRF/same-origin → content-type →
  exact allowlist → repository/RPC + Auth saga (claim → Auth → finish/finalize; INDETERMINATE/BLOCKED).
- Routes: `POST /api/admin/access/accounts` (thêm POST vào route có sẵn),
  `POST .../accounts/[accountRef]/display-name`, `.../[accountRef]/reset-password`,
  `.../accounts/intents/[intentRef]/reconcile`, `POST /api/admin/catalog/personnel/from-account`,
  `GET /api/admin/catalog/personnel/eligible-accounts`.
- `src/lib/admin/account-operation.test.mjs` — 9 test xanh (validator, create success, claim-loser không
  gọi Auth lần hai, provenance mismatch → BLOCKED, reset applied/unknown → INDETERMINATE, authority-field
  bị từ chối, denied 403, không lộ password, personnel-from-account lấy display_name server-side).
- Lane `test:pre-w2-hf-d3-bc-account-personnel` đăng ký vào `pnpm test`.

## Chưa xong / rủi ro (cần T1A tiếp)

- **UI chưa wire:** Account Manager (Tạo/Sửa tên/Đặt lại mật khẩu/Đối soát) và Personnel Catalog
  (thay free-create bằng "Tạo từ tài khoản") chưa được sửa — chỉ mới có server route.
- **Mutation probes** cho lớp TS (client authority, marker từ JWT, direct free-create, password leak,
  bypass Full Admin) chưa có script; probes DB guard của D3-A đã có sẵn trong
  `scripts/pre-w2-hf-d3-a-account-personnel-mutation.mjs`.
- `reclassify` và read-route cho "operation cần xử lý" chưa được surface thành UI (RPC đã có).

## Gate đã chạy

`pnpm typecheck` 0 · `pnpm lint` 0 error · `next build --webpack` 0 · focused lane 9/9.
Chưa chạy full `pnpm test` (Pre-W2 integration sở hữu regression tổng).

## Chờ T0

Không merge main, không apply DB, không deploy. Chưa đạt
`PRE_W2_HF_D3_BC_ACCOUNT_PERSONNEL_UI_LOCAL_PASS_AWAITING_T0_REVIEW` — còn UI + mutation probes.
