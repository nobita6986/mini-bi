# PRE-W2-P1 (T1A) — Nút "Xuất Excel" cho "Người tôi tuyển" / "Dự án tôi quản lý"

- **Status:** `PRE_W2_P1_WORKER_EXPORT_UI_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@8e79850` (bao gồm merge PRE-W2-P1 backend `afd1342` + merge HF-C `8e79850`).
  Backend export `POST /api/direct-entry/workers/export` đã có trên base và **không bị sửa**.
- **Contract đọc trước khi làm:** `docs/handoffs/pre-w2-s0-pii-export-worker-name-survey.md @ 499a212`
  (PRE-W2-S0-R2, accepted) và `docs/handoffs/pre-w2-p1-worker-export-backend.md`.
  Request/response contract của route khớp nguyên trạng R2 (không drift) → **không dừng/rebase**.
- **Branch / worktree:** `feature/pre-w2-p1-worker-export-ui` trên worktree cô lập
  `C:\CodeApp\BI\.worktrees\pre-w2-p1-ui-export` (`node_modules` là junction trỏ về primary
  checkout). **Primary checkout không bị chạm** (vẫn nguyên các thay đổi VPS chưa commit).

## Phạm vi đã làm (Pre-W2, chỉ UI)

- Thêm nút **"Xuất Excel"** vào hai danh sách `Người tôi tuyển` (scope `recruited`) và
  `Dự án tôi quản lý` (scope `managed`). Tab `Tôi đã nhập`/`Toàn bộ NLĐ` **không** có nút.
- Hộp thoại hỏi **lý do xuất** (bắt buộc), tái dùng `Dialog` (radix) + primitives sẵn có.
- Gửi đúng contract: `POST /api/direct-entry/workers/export` (`content-type: application/json`,
  same-origin/CSRF), body allowlist `scope | project_id | recruiter_id | employment_status |
  reason` theo đúng scope + bộ lọc hiện tại. **Không** lấy PII từ bảng UI, **không** tạo XLSX phía
  client, **không** gửi authority (client không gửi `auth_subject`/`app_user_id`/capability).
- Tải file từ `response.blob()`; filename lấy từ `content-disposition` (đã kiểm basename `.xlsx`,
  chặn path traversal) hoặc fallback cố định `danh-sach-nguoi-lao-dong-YYYY-MM-DD.xlsx`.
- Trạng thái: `busy` chặn double-submit + khoá đóng dialog; thành công hiện notice; lỗi hiện copy
  sanitized. **422 row-limit** báo rõ giới hạn kèm hướng dẫn thu hẹp bộ lọc và **không tải file
  thiếu dòng** (chỉ `status === 200` mới tải).
- Ẩn/hiện nút chỉ dựa trên capability projection **do server cấp** (`pii_export` + `pii_view` +
  `payment_view`). Row authority vẫn do RPC #86 quyết định; 403 từ server hiện thông báo, **không**
  mở rộng access.
- **Không log** reason/body/response/CCCD/SĐT/ngân hàng (component không có `console.*`).

## File thay đổi

- **Mới** `src/lib/direct-entry/worker-export-ui-model.ts` — model thuần: `canExportWorkers`,
  `exportScopeForTab`, `buildWorkerExportRequest`, `workerExportRequestMessage`,
  `workerExportErrorMessage` + `workerExportRowLimit`, `workerExportFilename`.
- **Mới** `src/lib/direct-entry/worker-export-ui-model.test.mjs` — focused model tests.
- **Mới** `src/components/direct-entry/worker-export-ui.test.mjs` — source/structure tests.
- **Sửa** `src/components/direct-entry/worker-operations.tsx` — nút + `WorkerExportDialog` +
  `downloadFile`; prop `canExport`.
- **Sửa** `src/app/direct-entry/workers/page.tsx` — tính `canExport = canExportWorkers(projection)`
  và truyền xuống (chỉ capabilities + scope kind, không lộ PII).
- **Sửa** `package.json` — lane `test:pre-w2-p1-worker-export-ui` (đăng ký một lần trong `pnpm test`).
- **Mới** `docs/handoffs/pre-w2-p1-worker-export-ui.md` (file này).

**Không** sửa API/repository/RPC/migration/schema/capability/quy tắc xuất. **Không** thêm
dependency. **Không** đụng VPS/Production/DB/migration deploy.

## Kiểm thử & gate

- Focused lane `test:pre-w2-p1-worker-export-ui` — **17/17 pass**. Phủ: đúng hai scope; body theo
  contract (scope + filter map, filter rỗng → null); scope `all`/invalid + reason sai fail-closed;
  gate capability triple; 400/401/403/404/422/5xx/lỗi mạng; 422 đọc `limit` + fallback; filename
  từ server/fallback/chặn path traversal; không lộ UUID/raw DB/PII trong copy.
- Regression liên quan: `test:p2.5-w06` (62 pass), `test:p3-1-hf-change-request-panel` (57 pass),
  `test:p2.5-w03` (22 pass).
- `pnpm typecheck` exit 0 · `pnpm lint` 0 error / 13 warning pre-existing · `next build --webpack`
  exit 0 (`/direct-entry/workers` + `/api/direct-entry/workers/export` hiện diện) ·
  `pnpm docs:check` 6/6 · `pnpm secrets:check` clean · `pnpm db:migrate -- --offline` **87** ·
  `git diff --check` exit 0.
- `pnpm build` (Turbopack) không chạy được trong worktree vì `node_modules` là junction trỏ ra ngoài
  filesystem root → dùng Webpack opt-out như tài liệu P1.

## Rủi ro / ngoài phạm vi

- Authority provisioning không thuộc code: actor cần `pii_export` + `pii_view` + `payment_view`
  (T0/Admin cấp trước UAT). Thiếu → nút ẩn (capability) hoặc 403 (row authority) — đều fail-closed.
- Row authority (recruiter link / PM assignment) chỉ RPC biết; UI không suy diễn. Một actor có đủ
  capability nhưng không có quan hệ vẫn thấy nút và nhận 403 kèm copy giải thích (đúng "quyền cuối
  cùng do backend").
- Sửa tên NLĐ (SURVEY B) là slice kế tiếp — **không** làm ở đây.
- Không UAT/browser, không merge main, không deploy.
