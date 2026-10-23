# Mini BI — Báo cáo QA, Hiệu năng & Quản trị Motion Chặng 2 (`UIUX-S2-08`)

- **Tài liệu nguồn:** [`docs/plans/mini-bi-ui-ux-agent-ready-masterplan.md`](../mini-bi-ui-ux-agent-ready-masterplan.md)
- **Kiểm kê thông báo nền tảng (Chặng 1):** [`docs/plans/uiux/notification-inventory.md`](./notification-inventory.md) (giữ nguyên 40/40 hạng mục `completed`, 0 `migrate`)
- **Baseline bắt buộc (`origin/main`):** `cc48b11185e3be3649cbf5bad96b06c27f8dfeb5` (sau khi merge Chặng 1 PR `#122`–`#134`, CI run `39881540175` PASS)
- **Phạm vi thực thi:** Chuỗi 8 nhánh/PR tuần tự `S2-01 → S2-08` (`PR #135` → `PR #142`), không migration/schema/RPC, không đổi quyền hoặc công thức BI, không thêm thư viện animation/toast mới, không tự merge/deploy.

---

## 1. Danh mục Chuỗi Nhánh & PR Chặng 2 (`S2-01 → S2-08`)

| Thứ tự | Task ID | Nhánh (`codex/*`) | PR | Nội dung cốt lõi |
|---|---|---|---|---|
| 1 | `S2-01` | `codex/uiux-s2-01-chart-animation` | `#135` | Animation dữ liệu biểu đồ có điều kiện (`340ms`, chỉ chạy khi dataset server mới hợp lệ; tắt khi mount/remount/theme/resize/filter liên tiếp `<420ms`/dataset lớn/`prefers-reduced-motion`). |
| 2 | `S2-02` | `codex/uiux-s2-02-kpi-transition` | `#136` | Chuyển tiếp số nguyên `KpiCard` (`220ms`, định dạng `vi-VN`, giữ nguyên frame hiển thị trước `useEffect`, nối tiếp từ frame hiện tại hoặc hiện ngay khi đổi lọc nhanh `<120ms`, không đếm từ `0` khi mount/chuyển tab, bỏ qua `—`/`N/A`/tỷ lệ `%`). |
| 3 | `S2-03` | `codex/uiux-s2-03-panel-dialog-motion` | `#137` | Motion nhẹ (`<= 6px`, `200ms`) cho tab panel, drawer `WorkerDetailDialog`/`MobileNav`, popover `RowOverflowMenu`, bộ lọc nâng cao (`hidden={!advancedOpen}`), và fade-only trên `Dialog.Content` căn giữa (`FormDialog`, hộp thoại `WorkerOperations`) để bảo toàn `translate(-50%, -50%)`. |
| 4 | `S2-04` | `codex/uiux-s2-04-bi-interaction` | `#138` | Cross-highlight hai chiều (`BiHighlightScope`) giữa biểu đồ và bảng/danh sách dùng chung dataset (hover, bàn phím `Enter`/`Space`/`Escape`, ghim trên cảm ứng, ánh xạ nhóm `Khác` `__other__`), không tự lọc URL/toàn trang. |
| 5 | `S2-05` | `codex/uiux-s2-05-advanced-toast` | `#139` | Mở rộng `NotifyProvider` Chặng 1: `notify.pending()`, cập nhật tại chỗ `notify.update()`, gom burst theo `dedupeKey` (`×2`/`×3`), guard one-flight + `isValid()` cho cả nút và `<Link>` action, chặn Undo giả, không dùng Web Storage, xóa sạch khi logout (`204`). |
| 6 | `S2-06` | `codex/uiux-s2-06-long-running-feedback` | `#140` | Phản hồi tác vụ dài bằng `<progress>` bất định (không phần trăm giả), kiểm tra chữ ký ZIP `.xlsx` (`PK\x03\x04`) & HTML hợp lệ trước khi tải xuống, giữ polling/Toast nền khi đóng drawer AI và dừng `<progress>` kèm nút `Kiểm tra lại trạng thái` khi poll lỗi mạng. |
| 7 | `S2-07` | `codex/uiux-s2-07-selected-micro-motion` | `#141` | Mở rộng micro-motion có chọn lọc cho `StatusBadge`, `Alert`, `StatusBanner`, `AdminSubnav`, subnav Work Reports, form renderer, disclosure `[data-ui-disclosure="true"]`, queue tabs và các drawer AI/duyệt yêu cầu. |
| 8 | `S2-08` | `codex/uiux-s2-08-release-gate` | `#142` | Release Gate Chặng 2 (`uiux-s2-release-gate.test.mjs`), đo đạc bundle thực tế trước/sau, khóa quy tắc quản trị bảo trì và lập checklist Manual UAT. |

---

## 2. Hạng mục `N/A` / Giữ Tĩnh Có Chủ Đích (Kèm Bằng Chứng Mã Nguồn)

| Hạng mục | Phân loại | Bằng chứng kỹ thuật & Lý do |
|---|---|---|
| Nút `Undo` trên Toast (`S2-05`) | `N/A (No Backend Undo Contract)` | Hệ thống RPC/API hiện hành (duyệt yêu cầu thay đổi, sửa hồ sơ, danh mục Admin, nộp báo cáo công việc, cấu hình AI) dùng mô hình kiểm toán bất biến / đề xuất mới, **không có endpoint hoàn tác (Undo)**. Hàm `resolveSafeNotifyAction` tại `src/components/ui/notify-store.ts` chủ động từ chối mọi action `kind === "undo"` để không bao giờ xuất hiện CTA giả. |
| Click biểu đồ để drilldown sang route mới (`S2-04`) | `N/A (No Chart Drilldown Route)` | Các biểu đồ tổng hợp Dashboard (`TrendChart`, `RecruiterBarChart`, `ProjectDonut`, `ProviderDonut`, `EmploymentComposition`) không có route drilldown được server cấp quyền tương ứng cho từng lát cắt; việc tự tạo link/filter giả bị cấm theo §7. Chỉ bật cross-highlight cùng dataset và giữ nguyên drilldown chi tiết nhóm có thật tại `src/components/dashboard/team-entry-detail.tsx`. |
| Thanh tiến độ phần trăm `0% → 100%` (`S2-06`) | `N/A (No Streaming Progress API)` | `POST /api/direct-entry/workers/export` trả một phản hồi nhị phân `.xlsx` hoàn chỉnh và `GET /api/ai/reports/[jobId]` trả trạng thái bước rời rạc (`queued`, `computing`, `ai_generating`, `validating`, `draft`), không có phần trăm thực. UI dùng `<progress>` không gắn `value` (indeterminate) theo đúng §9. |
| Spreadsheet/Grid, hộp thoại dán Excel & upload chân dung `/direct-entry` (`S2-06`, `S2-07`) | `N/A (Locked by §0.3 & R2.2 Checksum Guard)` | 21 file nhập liệu bảng tính/paste/portrait cùng lát cắt `direct-entry-live.tsx` và các khối CSS `.grid*`/`.page` trong `direct-entry-shell.module.css` được khóa SHA-256 bởi `scripts/r2-2-grid-no-touch-guard.test.mjs`. Luồng staging ảnh đã có trạng thái từng ô thực tế nên giữ nguyên 100%. |
| KPI tỷ lệ `%`, chuỗi `—` / `N/A` (`S2-02`) & `TeamBucketChart` CSS (`S2-01`) | `Skipped / Static by Design` | `resolveKpiTransitionPlan` chỉ cho phép số nguyên không âm hợp lệ để tránh nhảy số thập phân sai trên KPI tỷ lệ; `team-bucket-chart.tsx` là thanh CSS thuần không dùng Recharts và được khóa tĩnh theo guard Chặng 1. |
| `Dialog.Content` căn giữa (`FormDialog`, hộp thoại `WorkerOperations`, `.confirmDialog`) (`S2-03`, `S2-07`) | `Opacity / Overlay-Only Motion` | Các modal căn giữa desktop bằng `-translate-x-1/2 -translate-y-1/2` / `translate(-50%, -50%)`; `@keyframes ui-dialog-enter` chỉ animate `opacity` (không đụng `transform`) và `.confirmDialog` chỉ animate lớp overlay để không làm lệch tâm hộp thoại. |

---

## 3. Bằng Chứng Bundle, Build & Hiệu Năng Thực Tế

Đo trực tiếp bằng `pnpm build` (`Next.js 16.3.8 (Turbopack)`) trên cùng máy Windows workspace giữa mốc baseline `cc48b11185e3be3649cbf5bad96b06c27f8dfeb5` và nhánh cuối `codex/uiux-s2-08-release-gate`:

| Chỉ số đo thực tế (`.next/static`) | Baseline `cc48b111` (Sau Chặng 1) | Sau Chặng 2 (`S2-01..S2-08`) | Chênh lệch tuyệt đối / Tương đối | Đánh giá Gate |
|---|---:|---:|---:|---|
| Số lượng dependency mới trong `package.json` | `0` | `0` | `+0` | **PASS** (không thêm Framer Motion / Sonner / thư viện ngoài) |
| Số lượng JS chunks (`.next/static/**/*.js`) | `45` files | `45` files | `+0` chunks | **PASS** |
| Tổng dung lượng JS tĩnh (uncompressed) | `3,368,650 B` (`3,289.70 KiB`) | `3,400,549 B` (`3,320.85 KiB`) | `+31,899 B` (`+31.15 KiB` / **`+0.95%`**) | **PASS** (`<1%`, rất nhỏ cho toàn bộ 7 module tương tác) |
| Chunk JS lớn nhất (`1ubgb8e8qhuuh.js`) | `930,904 B` | `930,904 B` | `+0 B` (`0.00%`) | **PASS** |
| Số lượng file CSS tĩnh (`.next/static/**/*.css`) | `3` files | `3` files | `+0` files | **PASS** |
| Tổng dung lượng CSS tĩnh (uncompressed) | `138,582 B` (`135.33 KiB`) | `143,834 B` (`140.46 KiB`) | `+5,252 B` (`+5.13 KiB` / **`+3.79%`**) | **PASS** (keyframes & reduced-motion rules gọn nhẹ) |
| Tổng `.next/static` (JS + CSS) | `3,507,232 B` (`3,425.03 KiB`) | `3,544,383 B` (`3,461.31 KiB`) | `+37,151 B` (`+36.28 KiB` / **`+1.06%`**) | **PASS** |
| Chỉ số Web Vitals thực địa (`INP`, `CLS`, FPS trình duyệt thật) | `NOT VERIFIED` | `NOT VERIFIED` | `NOT VERIFIED` | Môi trường CLI/CI không có phiên đăng nhập staging để đo Chrome DevTools Performance thực tế; đã khóa compositor-only (`transform`, `opacity`, màu sắc) và cần xác nhận bổ sung ở bước Manual UAT bên dưới. |

---

## 4. Chính Sách Bảo Trì Cho Coding Agent Tiếp Theo (Motion & Notification Governance)

1. **Token chuẩn duy nhất (`src/app/globals.css`):**
   - Luôn tái sử dụng `--ui-motion-fast` (`120ms`), `--ui-motion-hover` (`160ms`), `--ui-motion-tab` (`200ms`), `--ui-motion-reveal` (`200ms`), `--ui-motion-toast-in` (`200ms`), `--ui-motion-toast-out` (`160ms`), `--ui-motion-kpi` (`220ms`), `--ui-motion-chart` (`340ms`), và `--ui-motion-ease`.
   - Mọi selector chuyển động mới (`data-ui-*`) bắt buộc phải được thêm vào khối `@media (prefers-reduced-motion: reduce)` trong `src/app/globals.css`.
2. **Biểu đồ & KPI (`src/components/dashboard/chart-motion.ts`, `kpi-motion.ts`):**
   - Tuyệt đối không hardcode `isAnimationActive={true}` trên Recharts; phải đi qua `useChartDataAnimation(...)`.
   - Tuyệt đối không chạy count-up từ `0` khi mount/remount hoặc nội suy trên chuỗi định dạng tỷ lệ `%`.
3. **Thông báo & Tác vụ dài (`src/components/ui/notify-store.ts`, `src/lib/ui/long-running-feedback.ts`):**
   - Kết quả hành động của người dùng dùng `useNotify()` (`NotifyProvider` duy nhất ở `RootLayout`).
   - Chỉ gộp lặp (`repeatCount`) khi có cùng `dedupeKey` nghiệp vụ; không lưu lịch sử Toast hoặc PII vào `localStorage`/`sessionStorage`/`indexedDB`.
   - Với tải file (`.xlsx`, `.html`), bắt buộc xác minh Blob/nội dung hợp lệ (`validateDownloadableExportBlob` / `isUsableWorkerExportBlob`) trước khi kích hoạt tải xuống và `notify.success`.
4. **Ranh giới bất biến:**
   - Không dùng `transition-all` trên bảng lớn, container biểu đồ hoặc `/direct-entry`.
   - Luôn chạy `node --test scripts/r2-2-grid-no-touch-guard.test.mjs scripts/ci-test-manifest.test.mjs` và `src/components/ui/uiux-s2-release-gate.test.mjs` trước khi mở PR UI/UX mới.

---

## 5. Checklist Manual UAT Trên Trình Duyệt / Staging (`NOT VERIFIED` Trong Môi Trường CLI)

> **Trạng thái trung thực:** Selftest tự động (DOM static markup, fake-clock state machine, contract/projector unit tests, PGlite 6 shards, PostgreSQL concurrency, Next.js production build) đã **PASS**, nhưng kiểm thử tương tác trực quan trên trình duyệt thật có dữ liệu tài khoản phân quyền được đánh dấu **`NOT VERIFIED`** để QA / Product Owner nghiệm thu trên môi trường TEST/Staging trước khi phát hành.

- [ ] **`NOT VERIFIED` — Viewport Matrix (`1440px`, `768px`, `375px`, `320px`):** Mở `/dashboard`, `/direct-entry/workers`, `/direct-entry/change-requests`, `/admin/*`, `/work-reports`; kiểm tra Toast không che khuất nút Submit khi bàn phím ảo mobile bật ở `320px` và bảng phân tích cuộn ngang mượt.
- [ ] **`NOT VERIFIED` — Phương thức tương tác (Mouse, Touch, Keyboard-only):** Dùng `Tab` / `Shift+Tab`, `ArrowLeft/Right`, `Home/End`, `Enter`, `Space`, `Escape` trên tab BoD, `DirectEntryQueueTabs`, lát cắt biểu đồ cross-highlight và nút `Bỏ ghim nổi bật` trên màn hình cảm ứng.
- [ ] **`NOT VERIFIED` — Normal Motion vs `prefers-reduced-motion: reduce`:** Bật giảm chuyển động cấp hệ điều hành; xác nhận biểu đồ Recharts vẽ tĩnh tức thì, KPI không nhảy số trung gian, Toast/Dialog/Drawer/Disclosure mở-đóng không trượt và icon pending không quay.
- [ ] **`NOT VERIFIED` — Ma trận 5 Theme × Sáng/Tối (`hr-partner`, `ocean-trust`, `emerald-growth`, `violet-future`, `executive-gold`):** Chuyển đổi theme và chế độ sáng/tối; xác nhận biểu đồ và KPI **không** chạy lại hiệu ứng đếm/vẽ và độ tương phản badge/toast/highlight rõ ràng ở cả 10 tổ hợp.
- [ ] **`NOT VERIFIED` — Dialog & Drawer Stacking / Focus Return:** Mở `WorkerDetailDialog` → hộp thoại tài liệu con, `DirectEntryChangeRequestReviewer` → `AlertDialog` xác nhận duyệt/từ chối, `AiSettingsPanel` → hộp thoại hủy thay đổi; bấm `Escape` và kiểm tra focus trả về đúng nút kích hoạt ban đầu.
- [ ] **`NOT VERIFIED` — Browser Back / Forward & Tab Authority:** Chuyển qua lại giữa các tab Dashboard và bộ lọc URL rồi bấm Back/Forward liên tiếp; xác nhận đúng tab/panel hiển thị ngay lập tức, không kẹt animation và tài khoản không có quyền không bao giờ thấy DOM của tab `CCCD trùng` / `Nhóm` / `Báo cáo chuyên sâu`.
- [ ] **`NOT VERIFIED` — Đổi bộ lọc liên tiếp & Đo `INP` / `CLS`:** Bấm nhanh nhiều preset kỳ lọc trên `/dashboard`; xác nhận thao tác liên tiếp `< 420ms` ưu tiên hiện số mới ngay không xếp hàng animation và ghi nhận `INP < 200ms`, `CLS < 0.05` bằng Chrome DevTools.
- [ ] **`NOT VERIFIED` — Export / Upload / Submit Thực Tế:** Thử xuất Excel tại `/direct-entry/workers`, tạo nháp & xuất HTML báo cáo AI tại `/dashboard`, lưu nháp/nộp báo cáo tại `/work-reports`; kiểm tra thanh `<progress>` bất định, Toast cập nhật tại chỗ từ `Đang tạo…` sang kết quả cuối, và thử kịch bản lỗi mạng/422 để xác nhận không tải xuống file hỏng.
- [ ] **`NOT VERIFIED` — Logout & Đổi Tài Khoản:** Khi đang có Toast hiển thị (bao gồm Toast lỗi persistent hoặc Toast đang pending), bấm Đăng xuất và đăng nhập tài khoản khác; xác nhận toàn bộ Toast phiên cũ bị xóa sạch ngay lập tức trước khi vào `/login`.
