# W2S1 — UI chi tiết NLĐ và ảnh hồ sơ (portrait) trên API hiện có

- Nhánh: `feature/w2s1-worker-portrait-ui`
- Worktree: `C:\CodeApp\BI\.worktrees\w2s1-worker-portrait-ui`
- Base: `origin/main` = `c660ce944caabf5415b4b796eb1e71ecd9a2de25` (PR #59, W2S1 backend đã merge)
- Phạm vi: CHỈ UI + projection client + test/wiring. Không sửa backend/API/RPC/SQL/migration/cấu hình auth.
- Không apply DB, không truy cập staging/Production/VPS, không deploy, không merge/push.
- Lịch sử: `ec0f9a2` (bản đầu) → **commit nối tiếp này** sửa 4 điểm sau rà soát T0:
  (1) ảnh thay thế không được thành `current` chỉ vì reserve/finalize thành công · (2) chặn gửi tệp rỗng/sai MIME/vượt dung lượng ·
  (3) bỏ thuật ngữ "PII" khỏi nội dung người dùng nhìn thấy · (4) cập nhật handoff (gồm accessibility).

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
  - `workerPortraitUploadPolicy(portrait)` + `workerPortraitUploadPolicyMessage(reason)` — **chính sách thay ảnh**:
    `current !== null` ⇒ `REPLACEMENT_REQUIRES_APPROVAL` (khoá thay thế); `current === null` nhưng vòng đời đang
    xử lý (`QUEUED`/`UPLOADING`/`SCANNING`) ⇒ `IN_FLIGHT`; `portrait === null` ⇒ `HIDDEN`; còn lại ⇒ `allow`.
    **Chỉ cho gửi ảnh ĐẦU TIÊN khi chưa có `current`.**
  - `checkWorkerPortraitFile(file)` + `WORKER_PORTRAIT_MAX_BYTES`/`WORKER_PORTRAIT_MIME_TYPES` — kiểm tra tệp
    (rỗng/quá 10 MiB/sai MIME ⇒ từ chối) dùng ở **cả** bước chọn tệp **và** trong hàm upload.
  - `worker_details` nhận cả dạng canonical (khi có `pii_view`) và dạng redacted `{present}`/`{state}` của server
    (state có thể là `null | provided | omitted | unknown | intentionally_blank`).
  - Nhãn hiển thị: `WORKER_PORTRAIT_STATUS_LABELS`, `workerPortraitOriginLabel`, `workerDocumentStatusLabel`,
    `workerDocumentReady`, `workerPortraitPreviewUrl`, `workerPortraitUploadUrl`.
  - **Không tạo tầng phân quyền hay nhãn mới**: nhãn giới tính lấy từ `genderUiLabel` (`display-labels`),
    nhãn loại tài liệu/trạng thái thanh toán lấy từ `change-request-read-projection`.
- `src/components/direct-entry/worker-portrait-panel.tsx` — `WorkerPortraitPanel`
  - Xem ảnh: `<img>` trỏ **private preview route** `.../documents/{documentId}/preview` (same-origin, session cookie),
    có trạng thái đang tải / lỗi / "Thử tải lại ảnh". Không storage key, không signed URL, không log dữ liệu cá nhân.
  - Tải ảnh: đúng pipeline hiện có `reserve → PUT presigned → finalize` với `document_type: "WORKER_PORTRAIT"`,
    `expected_entry_version`, `Idempotency-Key` (và `:finalize`); nhánh SUBMITTED gửi kèm lý do.
  - **Thay ảnh bị khoá**: khi `current !== null` KHÔNG render form upload; hiện thông báo (`data-testid="worker-portrait-upload-locked"`)
    rằng ảnh hiện hành chỉ được thay thế sau khi ảnh mới **được duyệt** và luồng duyệt chưa khả dụng. Panel chỉ đọc
    `current` từ projection server (`const current = portrait?.current ?? null`), **không có state/setter cho `current`**
    ⇒ reserve/finalize thành công không thể tự đổi ảnh hiện hành.
  - **Tệp không hợp lệ bị loại khỏi state**: `selectFile` gọi `checkWorkerPortraitFile`; tệp rỗng/sai MIME/vượt dung lượng ⇒
    `setFile(null)` + thông báo, nút gửi `disabled={busy || !selectedFileCheck.ok || state === "conflict"}`.
    `upload()` **validate lại** trước khi reserve (`mime_type` lấy từ `check.mimeType`, không lấy thẳng từ `file.type`).
  - `portrait === null` (thiếu `document_view`) ⇒ chỉ hiện "Ảnh hồ sơ được ẩn theo quyền truy cập.", không hiện form upload.
  - **Không báo thành công giả**: chỉ đặt trạng thái "đã ghi nhận" **sau khi finalize trả ok**, rồi mới
    `onEntryVersionChange` + `onPortraitChanged`. 409 ⇒ trạng thái conflict + nút "Tải lại trạng thái"; lỗi khác ⇒ "Thử lại"
    dùng lại cùng idempotency key.
- `src/components/direct-entry/worker-detail-dialog.tsx` — `WorkerDetailDialog` + `WorkerDetailBody`
  - Một Radix Dialog **dùng chung**, mở từ danh sách NLĐ; không tạo route/page chi tiết thứ hai.
  - Layout `styles.documentsDialog` (mobile < 768px chuyển toàn chiều rộng); `Dialog.Title`/`Dialog.Description`,
    `aria-describedby`, `data-testid="worker-detail-dialog"`; `onCloseAutoFocus` trả focus về nút đã mở.
  - Nhóm dữ liệu: **Thông tin NLĐ** (theo server; redacted ⇒ ghi rõ "được ẩn theo quyền truy cập", **không dùng thuật ngữ PII**)
    · **Công việc và dự án** (dự án, ngày đầu tiên, loại hình lao động, người tuyển/nhà cung cấp HRP/Vendor, trạng thái làm việc + ngày hiệu lực)
    · **Thanh toán** (theo projection payment server trả về trong row) · **Thay đổi gần nhất**
    (`pending_request`/`last_decision` của row) · **Ảnh hồ sơ** (`WorkerPortraitPanel`) · **Tình trạng từng loại hồ sơ**
    (CCCD mặt trước/sau, hợp đồng lao động).
  - Chỉ một nguồn dữ liệu chi tiết: `fetchWorkerDetail` (1 GET / lần mở). Không `.rpc(`, không tự ghép/không tự tính lại số liệu.
  - Trạng thái tải, lỗi + "Thử lại".
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

- Danh sách NLĐ (mọi tab recruited/managed/all) ⇒ bấm **Xem chi tiết** mở dialog chi tiết dùng chung.
- Ảnh hồ sơ: `MISSING`/`QUEUED`/`UPLOADING`/`QUARANTINED`/`SCANNING`/`READY`/`FAILED`/`SUPERSEDED` đều có nhãn;
  nguồn ảnh hiển thị theo server (`LEGACY_ADDED` luôn kèm ngày bổ sung, **không** mô tả là ảnh onboarding).
- **Upload ảnh chỉ mở khi: actor có `document_upload` + đọc được trạng thái ảnh + `current === null` + không đang xử lý.**
  Khi đã có ảnh hiện hành ⇒ khoá và báo rõ (chờ luồng duyệt). Khi ảnh trước đang xử lý ⇒ báo chờ kết quả.
- Kiểm tra đăng nhập, capability, scope hiện hành **giữ nguyên**; không mở rộng quyền, không tạo hệ thống/nhãn/role mới.

## 3. Test và gate

| Gate | Kết quả |
| --- | --- |
| `pnpm test:w2-s1-worker-portrait-ui` | 34/34 PASS (21 projection + 13 source-contract) |
| `pnpm test:p2.5-w06` (đọc `worker-operations.tsx`) | 63 PASS / 0 fail |
| `pnpm test:p3-1-hf-change-request-panel` (đọc `worker-operations.tsx`) | 58 PASS / 0 fail |
| `pnpm test:p3-1-w05-a-existing-account-ui` (`direct-entry-page-access`, trang workers) | 30 PASS / 0 fail |
| `pnpm test:pre-w2-hf-ui-labels` | 6 PASS / 0 fail |
| `pnpm test:p2.5-hf-r3` | 11 PASS / 0 fail |
| `pnpm test:w2-s1-backend` (không đổi backend) | 48 PASS / 0 fail |
| `pnpm typecheck` (`next typegen && tsc --noEmit`) | PASS |
| `pnpm lint` | 0 error; warning chỉ ở file có sẵn, **không** ở file thêm/sửa của task này |
| `pnpm build` | PASS (exit 0, `Compiled successfully`) |
| `pnpm docs:check` | PASS 6/6 |
| `node scripts/apply-migrations.mjs --offline` | 112 migration VALID, **không truy cập DB** |
| `git diff --check` | sạch |
| `pnpm secrets:check` | **KHÔNG CHẠY ĐƯỢC** — xem blocker B4 |

Coverage test đáng chú ý (bổ sung ở commit nối tiếp in đậm):

- Thứ tự nhóm dữ liệu; ẩn theo quyền (`redacted`); portrait `null` khi thiếu `document_view`.
- `LEGACY_ADDED` thiếu `added_at` ⇒ `null`; `ENROLLMENT` kèm `added_at` ⇒ `null`; `current` có trường lạ/`origin null` ⇒ `null`;
  `WORKER_PORTRAIT` không nằm trong `documents`.
- Pipeline reserve→PUT→finalize đúng URL/khóa/idempotency; không đặt "đã lưu" trước kiểm tra finalize; 409 ⇒ conflict + tải lại;
  403/404/hỏng JSON ⇒ fail-closed (mức code).
- **Ảnh cũ vẫn là `current` cho tới khi ảnh mới được duyệt**: server trả ảnh mới ở `SCANNING`/`READY` nhưng `current` vẫn là
  document cũ ⇒ projection giữ nguyên `document_id`/`version` cũ và policy trả `REPLACEMENT_REQUIRES_APPROVAL` (khoá thay thế).
- **Chỉ gửi ảnh đầu tiên**: `current === null` + `MISSING`/`FAILED` ⇒ `allow`; `current === null` + `QUEUED`/`UPLOADING`/`SCANNING` ⇒ `IN_FLIGHT`;
  `portrait === null` ⇒ `HIDDEN`; panel không có state/setter cho `current`.
- **Tệp không hợp lệ**: `checkWorkerPortraitFile` từ chối `null`/`undefined`/size 0/size âm/> 10 MiB/sai MIME;
  panel xoá tệp khỏi state và nút gửi bị disable; `upload()` validate lại.
- **Không còn thuật ngữ "PII"** trong mã nguồn đã bỏ comment của dialog và panel (chỉ còn trong comment nội bộ/capability `pii_view`).

## 4. Accessibility

Đã có (mức code, có test):

- Dialog dùng `Dialog.Title` + `Dialog.Description` gắn `aria-describedby`; mở/đóng bằng bàn phím; `Esc` đóng;
  `onCloseAutoFocus` trả focus về đúng nút "Xem chi tiết" đã mở.
- Mỗi nhóm dữ liệu là `<section aria-labelledby>` với `<h3>`; danh sách giá trị dùng `<dl>/<dt>/<dd>`.
- Ảnh hồ sơ có `alt` mô tả; trạng thái đang tải/không tải được là `<figcaption>`; nút "Thử tải lại ảnh" là `<button type="button">`.
- Trạng thái động (`role="status"`) và lỗi (`role="alert"`); `progress` có `aria-label` khi đang gửi.
- Mobile: `styles.documentsDialog` chuyển toàn chiều rộng (< 768px); menu chọn tệp dùng input file có `aria-label` + nhãn hiển thị.

**Chưa làm / chưa xác minh (blocker B7)**: chưa audit a11y bằng screen reader, chưa đo contrast, chưa kiểm tra thứ tự tab
trên thiết bị thật, chưa UAT bàn phím/mobile với tài khoản thật.

## 5. Blocker còn lại (chờ T1B đề xuất contract / T0 chốt)

- **B1 — Staging ảnh trước khi lưu (tạo mới NLĐ).** Chưa có API staging/promote trong contract W2S1 backend.
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
- **B6 — Luồng DUYỆT ảnh thay thế (backend).** Contract W2S1 yêu cầu ảnh thay thế chỉ trở thành `current` **sau khi được duyệt**;
  lý do nhập không thay cho bước duyệt. Backend hiện lấy bản `READY` mới nhất làm `current`, và **chưa có API duyệt ảnh thay thế**.
  Vì vậy UI đã **khoá thay thế** (`REPLACEMENT_REQUIRES_APPROVAL`), chỉ cho gửi ảnh đầu tiên khi `current === null`.
  T0/T1B cần chốt: endpoint duyệt (nộp ảnh thay thế → trạng thái chờ duyệt → duyệt/từ chối) và cách backend **không** đổi
  `current` trước khi duyệt. Khi có contract, chỉ cần mở khoá policy và thêm bước nộp-duyệt; projection/policy hiện tại
  đã tách đúng hai trục nên không phải viết lại.
- **B7 — Audit accessibility thật.** Đã có cấu trúc a11y ở mức code (mục 4) nhưng **chưa** kiểm tra bằng screen reader,
  contrast, thứ tự tab trên thiết bị thật.

## 6. Xác nhận

- Không thay đổi DB/migration/schema, không apply DB, không truy cập staging/Production/VPS, không deploy.
- Không sửa master plan, không sửa `.codegraph`.
- Không đổi tên capability, không sửa authorization/scope; không tạo route/page chi tiết thứ hai; không thêm tầng phân quyền/nhãn mới.
- Không amend/rebase/force-push; chưa push/merge — chờ T0 rà soát tiếp.
