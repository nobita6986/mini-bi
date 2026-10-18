# W2S1 — UI chi tiết NLĐ và ảnh hồ sơ (portrait) trên API hiện có

- Nhánh: `feature/w2s1-worker-portrait-ui`
- Worktree: `C:\CodeApp\BI\.worktrees\w2s1-worker-portrait-ui`
- Base: `origin/main` = `c660ce944caabf5415b4b796eb1e71ecd9a2de25` (PR #59, W2S1 backend đã merge)
- Phạm vi: CHỈ UI + projection client + test/wiring. Không sửa backend/API/RPC/SQL/migration/cấu hình auth.
- Không apply DB, không truy cập Production/VPS, không deploy, không merge/push.

## 1. Thay đổi theo file/symbol

### Mới

- `src/lib/direct-entry/worker-detail-projection.ts`
  - `projectWorkerPortrait(value)` / `projectWorkerDetail(value, expectedEntryId)` / `fetchWorkerDetail(entryId, fetchImpl)`:
    chiếu `GET /api/direct-entry/entries/{entryId}` **fail-closed** (thiếu khóa, sai kiểu, sai `entry_id`,
    trường lạ trong `worker_portrait`/`current` ⇒ `null`; `entry.worker_portrait` thiếu hẳn ⇒ `null`).
  - Hai trục ảnh hồ sơ do **server** quyết định: `origin = ENROLLMENT | LEGACY_ADDED` (bất biến,
    `LEGACY_ADDED` bắt buộc có `added_at`; `ENROLLMENT` không được có `added_at`) và `current`
    (`document_id`/`version`/`checksum_sha256`/`mime_type`/`size_bytes`). Client **không** suy origin/current
    từ version/`SUPERSEDED`/thứ tự mảng; `projectWorkerPortrait` từ chối `current` khi `origin === null`.
  - `worker_details` nhận cả dạng canonical (khi có `pii_view`) và dạng redacted `{present}`/`{state}` của server
    (state có thể là `null | provided | omitted | unknown | intentionally_blank`).
  - Nhãn hiển thị: `WORKER_PORTRAIT_STATUS_LABELS`, `workerPortraitOriginLabel`, `workerDocumentStatusLabel`,
    `workerDocumentReady`, `workerPortraitPreviewUrl`, `workerPortraitUploadUrl`.
  - **Không tạo tầng phân quyền hay nhãn PII mới**: nhãn giới tính lấy từ `genderUiLabel` (`display-labels`),
    nhãn loại tài liệu/trạng thái thanh toán lấy từ `change-request-read-projection`.
- `src/components/direct-entry/worker-portrait-panel.tsx` — `WorkerPortraitPanel`
  - Xem ảnh: `<img>` trỏ **private preview route** `.../documents/{documentId}/preview` (same-origin, session cookie),
    có trạng thái đang tải / lỗi / "Thử tải lại ảnh". Không storage key, không signed URL, không log PII.
  - Tải ảnh: đúng pipeline hiện có `reserve → PUT presigned → finalize` với `document_type: "WORKER_PORTRAIT"`,
    `expected_entry_version`, `Idempotency-Key` (và `:finalize`); JPEG/PNG ≤ 10 MiB; nhánh SUBMITTED gửi kèm lý do.
  - `portrait === null` (thiếu `document_view`) ⇒ chỉ hiện "Ảnh hồ sơ được ẩn theo quyền truy cập.", không hiện form upload.
  - **Không báo thành công giả**: chỉ đặt trạng thái "đã ghi nhận" **sau khi finalize trả ok**, rồi mới
    `onEntryVersionChange` + `onPortraitChanged`. 409 ⇒ trạng thái conflict + nút "Tải lại trạng thái"; lỗi khác ⇒ "Thử lại"
    dùng lại cùng idempotency key.
- `src/components/direct-entry/worker-detail-dialog.tsx` — `WorkerDetailDialog` + `WorkerDetailBody`
  - Một Radix Dialog **dùng chung**, mở từ danh sách NLĐ; không tạo route/page chi tiết thứ hai.
  - Layout `styles.documentsDialog` (mobile < 768px chuyển toàn chiều rộng); `Dialog.Title`/`Dialog.Description`,
    `aria-describedby`, `data-testid="worker-detail-dialog"`; `onCloseAutoFocus` trả focus về nút đã mở.
  - Nhóm dữ liệu: **Thông tin NLĐ** (PII theo server; redacted ⇒ ghi rõ ẩn theo quyền PII) · **Công việc và dự án**
    (dự án, ngày đầu tiên, loại hình lao động, người tuyển/nhà cung cấp HRP/Vendor, trạng thái làm việc + ngày hiệu lực)
    · **Thanh toán** (theo projection payment server trả về trong row) · **Thay đổi gần nhất**
    (`pending_request`/`last_decision` của row) · **Ảnh hồ sơ** (`WorkerPortraitPanel`) · **Tình trạng từng loại hồ sơ**
    (CCCD mặt trước/sau, hợp đồng lao động).
  - Chỉ một nguồn dữ liệu chi tiết: `fetchWorkerDetail` (1 GET / lần mở). Không `.rpc(`, không tự ghép/không tự tính lại số liệu.
  - Trạng thái tải/`aria-live`, lỗi + "Thử lại".
- Test: `src/lib/direct-entry/worker-detail-projection.test.mjs`, `src/components/direct-entry/worker-detail-dialog.test.mjs`.

### Sửa

- `src/components/direct-entry/worker-operations.tsx`
  - `WorkerTable` thêm nút **"Xem chi tiết"** (`onViewDetail`, luôn có vì `allowed_actions.view` server luôn `true`);
    giữ nguyên "Đề xuất thay đổi"/"Sửa trực tiếp" và thông báo lý do không có CTA.
  - Thêm `detailRow` + `detailOpenerRef`; `canUploadDocuments` lấy từ `actor.capabilities.includes("document_upload")`
    (capability server-resolved do trang truyền xuống) — **không suy quyền từ tab/role**.
  - Render `<WorkerDetailDialog>`; đóng dialog ⇒ `setDetailRow(null)`, focus trả về nút mở.
- `src/components/direct-entry/direct-entry-shell.module.css` — thêm `.portraitFigure`, `.portraitImage` (khung ảnh hồ sơ).
- `package.json` — lane `test:w2-s1-worker-portrait-ui` và nối vào chuỗi `test` canonical (sau `test:w2-s1-backend`).

## 2. Trạng thái UI

- Danh sách NLĐ (mọi tab recruited/managed/all) ⇒ bấm **Xem chi tiết** mở dialog chi tiết dùng chung; bàn phím đóng/mở được,
  focus trả về đúng nút (Radix không tự làm khi không dùng `Dialog.Trigger`).
- Ảnh hồ sơ: `MISSING`/`QUEUED`/`UPLOADING`/`QUARANTINED`/`SCANNING`/`READY`/`FAILED`/`SUPERSEDED` đều có nhãn;
  nguồn ảnh hiển thị theo server (`LEGACY_ADDED` luôn kèm ngày bổ sung, **không** mô tả là ảnh onboarding).
- Upload ảnh chỉ hiện khi actor có `document_upload` **và** đọc được trạng thái ảnh; chưa có ảnh ⇒ vẫn upload được (thay thế/khởi tạo).
- Kiểm tra đăng nhập, capability, scope hiện hành **giữ nguyên**; không mở rộng quyền, không tạo hệ thống/nhãn PII/role mới.

## 3. Test và gate

| Gate | Kết quả |
| --- | --- |
| `pnpm test:w2-s1-worker-portrait-ui` | 26/26 PASS (16 projection + 10 source-contract) |
| `pnpm test:p2.5-w06` (đọc `worker-operations.tsx`) | 63 PASS / 0 fail |
| `pnpm test:p3-1-hf-change-request-panel` (đọc `worker-operations.tsx`) | 58 PASS / 0 fail |
| `pnpm test:p3-1-w05-a-existing-account-ui` (`direct-entry-page-access`, trang workers) | 30 PASS / 0 fail |
| `pnpm test:pre-w2-hf-ui-labels` | 6 PASS / 0 fail |
| `pnpm test:p2.5-hf-r3` | 11 PASS / 0 fail |
| `pnpm test:w2-s1-backend` (không đổi backend) | 48 PASS / 0 fail |
| `pnpm typecheck` (`next typegen && tsc --noEmit`) | PASS |
| `pnpm lint` | 0 error; 14 warning — **tất cả thuộc file có sẵn**, không warning nào ở file thêm/sửa của task này |
| `pnpm build` | PASS (exit 0, `Compiled successfully`) |
| `pnpm docs:check` | PASS 6/6 |
| `node scripts/apply-migrations.mjs --offline` | 112 migration VALID, **không truy cập DB** |
| `git diff --check` | sạch |
| `pnpm secrets:check` | **KHÔNG CHẠY ĐƯỢC** — xem blocker B4 |

Coverage test đáng chú ý: thứ tự nhóm dữ liệu; ẩn theo quyền PII (`redacted`); portrait `null` khi thiếu `document_view`;
`LEGACY_ADDED` thiếu `added_at` ⇒ `null`; `ENROLLMENT` kèm `added_at` ⇒ `null`; `current` có trường lạ/`origin null` ⇒ `null`;
`WORKER_PORTRAIT` không nằm trong `documents`; pipeline reserve→PUT→finalize đúng URL/khóa/idempotency; không đặt
"đã lưu" trước kiểm tra finalize; 409 ⇒ conflict + tải lại; 403/404/hỏng JSON ⇒ fail-closed.

## 4. Blocker còn lại (chờ T1B đề xuất contract / T0 chốt)

- **B1 — Staging ảnh trước khi lưu (tạo mới NLĐ).** Chưa có API staging/promote/cleanup trong contract W2S1 backend.
  Không giả lập bằng client, không upload thẳng vào hồ sơ trước khi lưu. Vì vậy dialog này chỉ phục vụ NLĐ **đã có entry**;
  phần upload ảnh trong luồng nhập mới **chưa làm**.
- **B2 — Cleanup ảnh mồ côi.** Draft bỏ/lưu thất bại phải cleanup orphan (master plan W2S1). Chưa có contract ⇒ chưa làm.
- **B3 — Preview CCCD/hợp đồng.** Route `.../documents/{documentId}/preview` hiện chỉ phục vụ `WORKER_PORTRAIT`; CCCD/hợp đồng
  chỉ hiển thị **tình trạng**, không xem trước. Dialog có sẵn vị trí tích hợp với ghi chú
  `WORKER_DETAIL_PREVIEW_PENDING_NOTE` ("chưa khả dụng"). **Không dùng portrait preview cho CCCD.**
- **B4 — `pnpm secrets:check` không chạy được trong môi trường này.**
  `scripts/check-secrets.mjs` → `loadSupabaseConfig()` cần file cấu hình ngoài repo `C:\CodeApp\supabase-bi.txt`
  (mặc định trong `scripts/lib/load-supabase-config.mjs`); file này **không tồn tại** trên máy hiện tại nên script
  dừng với `ENOENT`. Đây là thiếu hụt môi trường, **không phải phát hiện secret trong thay đổi này**; chưa thể khẳng định
  "0 secret" bằng gate. Cần chạy lại ở môi trường có file cấu hình.
- **B5 — 404/403 mới chỉ có coverage mức CODE.** `fetchWorkerDetail` fail-closed và dialog hiện lỗi + "Thử lại" đã được test;
  **chưa UAT** với tài khoản/hồ sơ thật (chưa đăng nhập, chưa mở hồ sơ ngoài scope bằng dữ liệu thật). Không được coi là đã UAT.

## 5. Xác nhận

- Không thay đổi DB/migration/schema, không apply DB, không truy cập Production/VPS, không deploy.
- Không sửa master plan, không sửa `.codegraph`.
- Không tạo route/page chi tiết thứ hai; không thêm tầng phân quyền/nhãn PII mới; authorization và scope giữ nguyên.
- Chưa push/merge.
