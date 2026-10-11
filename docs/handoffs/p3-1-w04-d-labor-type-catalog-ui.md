# P3.1-W04-D — Labor Type Catalog UI (Admin) handoff

## Status

`P3_1_W04_D_LABOR_TYPE_UI_LOCAL_PASS_AWAITING_T0_REVIEW`

## Scope

Admin UI cho Labor Type Catalog, tái sử dụng toàn bộ backend/API W02C (RPC #79). Không sửa backend/API/RPC/schema/migration/dependency. Không static map TEMPORARY/PERMANENT, không raw-key fallback, không gọi Admin API từ Direct Entry consumer. `labor_type_key` immutable sau create; `display_name`/`sort_order`/`active` hiển thị theo server projection; `version` chỉ dùng nội bộ OCC, không render. Sau mutation applied hoặc OCC conflict, entity bị khóa tới khi authoritative reload thành công (GET item với edit/set-active; GET list exact-key với create).

## Base

- Repo: `https://github.com/nobita6986/mini-bi.git`
- Worktree: `C:/CodeApp/BI-p3-1-w04-d-labor-type-ui`
- Branch: `feature/p3-1-w04-d-labor-type-ui`
- Base SHA: `fc1c8b4958f0049631f62f37f57d34c0131cfba6` (= origin/main tại thời điểm giao task)
- Ghi chú preflight: worktree tồn tại sẵn từ phiên trước với một file untracked dở dang `src/lib/admin/labor-type-catalog-model.ts` (73 dòng, thuộc đúng task này); đã kiểm tra projection khớp contract W02C, hoàn thiện tiếp trên nền đó. Không có thay đổi ngoài task.

## Files

Mới:

- `src/app/admin/catalog/labor-types/page.tsx` — server page gate, mirror vendors page.
- `src/components/admin/labor-type-catalog-manager.tsx` — list/search/phân trang/lọc inactive, states loading/empty/denied/unavailable/error/retry, dialog radix accessible, create/edit/set-active với reason + expected_version + Idempotency-Key, lock-until-authoritative-reload.
- `src/lib/admin/labor-type-catalog-model.ts` — strict projection (7/8 key) + request builders theo đúng contract `labor-type-catalog-api.ts` (create 6 key `expected_version:0`, update 5 key không chứa key, set-active 4 key; `reporting_key` không bao giờ gửi).
- `src/lib/admin/labor-type-catalog-model.test.mjs`
- `src/components/admin/labor-type-catalog-manager.test.mjs`

Sửa:

- `src/lib/admin/admin-navigation.ts` — thêm section `labor-types` ("Loại hình lao động").
- `src/lib/admin/admin-navigation.test.mjs` — expected sections + highlight case + registry entry cho route mới.
- `src/lib/auth/direct-entry-page-access.ts` — thêm `decideLaborTypeCatalogPageAccess` (alias `decideAdminAreaAccess`, cùng pattern personnel/team/vendor).
- `src/lib/auth/direct-entry-page-access.test.mjs` — thêm decision mới vào vòng lặp access matrix.
- `package.json` — thêm lane `test:p3-1-w04-d-labor-type-ui` và nối vào `pnpm test` đúng một lần.
- `docs/handoffs/p3-1-w04-d-labor-type-catalog-ui.md` — file này.

## Verification

- Focused lane `pnpm test:p3-1-w04-d-labor-type-ui`: 30/30 pass (model, manager, admin-navigation, admin-access, direct-entry-page-access).
- W04-C lane `pnpm test:p3-1-w04-c-vendor-ui` (dùng chung admin-navigation/page-access tests): 28/28 pass.
- W02C backend regression `node --conditions=react-server --test src/lib/direct-entry/labor-type-catalog-api.test.mjs`: 16/16 pass.
- Mutation probes (lane đỏ → restore byte-identical, sha256 `be16f611a80c28cc61d758bbeb092792908cceec007f13096c5ac243d382bcc2`, lane xanh lại 30/30):
  - Probe 1: khôi phục static map `{TEMPORARY, PERMANENT}` + fallback `"Không xác định"` trong render → fail test "no static TEMPORARY/PERMANENT vocabulary, label map or raw-key fallback can reappear".
  - Probe 2: bỏ lock applied (optimistic success, chỉ reload khi conflict) → fail test "OCC and applied writes stay locked until strict authoritative reload succeeds".
- Regression cố định trong test: key động tùy ý (`SEASONAL_2X`) round-trip qua projection; inactive hiển thị qua filter kèm khẳng định không xóa lịch sử, không có DELETE; version/revision không render; update/set-active không gửi `labor_type_key`; page dùng server decision, không `DIRECT_ENTRY_UI_ENABLED`/client-side inference.
- `next typegen`: PASS. `pnpm typecheck`: PASS. `pnpm lint`: 0 errors, 13 warnings pre-existing ở file không liên quan. `pnpm build`: PASS, route `/admin/catalog/labor-types` generated.
- `pnpm docs:check`: PASS 6/6. `pnpm secrets:check`: PASS. `pnpm db:migrate -- --offline`: PASS, 81 migrations validated, không kết nối DB. `git diff --check`: PASS.
- Canonical `pnpm test`: kết quả ghi trong báo cáo cuối của T1A (chạy trước khi push).

## Release boundaries

- Không backend/API/RPC/schema/migration/dependency thay đổi; `package.json` chỉ đăng ký lane test.
- Không Production query/apply, không deploy, không browser UAT, không merge/rebase/amend/force-push.
- Local HEAD = remote HEAD trên `feature/p3-1-w04-d-labor-type-ui`, worktree sạch tại thời điểm bàn giao.
