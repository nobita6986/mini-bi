# T1-Android API Contract — Pre-Wave-2: Đối Chiếu CCCD, Tạo Hồ Sơ Trước (`worker-profile/1.2`) & Review Thông Tin NLĐ

Tài liệu này mô tả đầy đủ hợp đồng API backend để `T1-Android` tích hợp luồng tạo hồ sơ người lao động (NLĐ) theo nguyên tắc **Lưu hồ sơ trước — Tải ảnh & đọc QR CCCD chạy nền sau**, thống nhất trường cá nhân bắt buộc (`national_id` 12 chữ số bắt buộc, `display_name` và các trường cá nhân khác không bắt buộc), và tra cứu/xử lý trạng thái đối chiếu CCCD.

---

## 1. Nguyên tắc kiến trúc & Tương thích

1. **Record-First (Lưu hồ sơ trước, ảnh chạy nền):**
   - Android gọi `POST /api/direct-entry/batches/full-profile` với `contract_version: "worker-profile/1.2"` để tạo hồ sơ NLĐ ngay lập tức mà **không cần chờ** tải ảnh `CCCD_FRONT` / `CCCD_BACK` xong.
   - Sau khi nhận `entry_ids[]`, Android tải ngầm ảnh `CCCD_FRONT` và/hoặc `CCCD_BACK` qua luồng 3 bước (`reserve -> PUT R2 -> finalize`).
   - Lỗi mạng khi tải ảnh hoặc lỗi giải mã QR **tuyệt đối không rollback** hồ sơ NLĐ đã tạo.
2. **Thống nhất trường cá nhân (`worker-profile/1.2`) & Cô lập chế độ Lưới (`1.0`, `1.1`):**
   - `contract_version: "worker-profile/1.2"` dành cho **Web Biểu mẫu** và **Android**:
     - **Bắt buộc:** `worker.national_id` (`state: "provided"`, đúng 12 chữ số `0-9`, khác `"000000000000"`).
     - **Không bắt buộc:** `display_name` (cho phép chuỗi rỗng `""`..`256` ký tự), `worker.date_of_birth`, `worker.gender`, `worker.address`, `worker.phone`, `worker.national_id_issued_at`, `worker.national_id_issued_place`.
     - **Giữ nguyên các trường nghiệp vụ bắt buộc:** `project_id`, `recruiter_id`, `provider_type` (`"hrp" | "vendor"`), `labor_type`, `first_work_date` (`YYYY-MM-DD`), `employment.initial_status` (`"ON" | "UNCONFIRMED"`).
   - `contract_version: "worker-profile/1.0"` và `"worker-profile/1.1"` (Web Lưới) giữ nguyên 100% như cũ (`display_name` bắt buộc `1..256` ký tự, `national_id` tùy chọn).
3. **Không sử dụng CMT 9 số & Chưa bật OCR/Gemini:**
   - Chặng hiện tại chỉ giải mã **QR CCCD**. Nếu đọc QR thành công thì hoàn tất ngay.
   - Số CMT cũ 9 số (trường số 2 trong chuỗi QR CCCD) bị loại bỏ hoàn toàn: không lưu DB, không trả về API, không ghi log.

---

## 2. Tạo hồ sơ NLĐ (`POST /api/direct-entry/batches/full-profile`)

### Request
- **Headers:**
  - `Content-Type: application/json`
  - `Idempotency-Key: <UUID v4>`
- **Body (`contract_version: "worker-profile/1.2"`):**
```json
{
  "contract_version": "worker-profile/1.2",
  "rows": [
    {
      "project_id": "proj_alpha",
      "first_work_date": "2026-04-10",
      "provider_type": "hrp",
      "recruiter_id": "33333333-3333-4333-8333-333333333333",
      "labor_type": "TEMPORARY",
      "display_name": "",
      "worker": {
        "national_id": { "state": "provided", "value": "079095008811" },
        "date_of_birth": { "state": "omitted" },
        "gender": { "state": "omitted" },
        "address": { "state": "omitted" },
        "phone": { "state": "provided", "value": "0909123456" },
        "national_id_issued_at": { "state": "omitted" },
        "national_id_issued_place": { "state": "omitted" }
      },
      "general_note": { "state": "omitted" },
      "payment": { "state": "omitted" },
      "employment": { "initial_status": "ON" }
    }
  ]
}
```
> **Lưu ý:** Nếu người dùng trên Android đã nhập `display_name` hoặc các trường cá nhân khác, truyền giá trị bình thường; các trường đã nhập sẽ **không bao giờ bị ghi đè** khi QR tự động điền nền.

### Response (`201 Created` hoặc `200 OK` khi replay cùng `Idempotency-Key`)
```json
{
  "ok": true,
  "submission_id": "77777777-7777-4777-8777-777777777777",
  "state": "SUBMITTED",
  "version": 2,
  "entry_ids": ["11111111-1111-4111-8111-111111111111"]
}
```
Ngay khi tạo thành công với `worker-profile/1.2`, backend khởi tạo bản ghi đối chiếu CCCD ở trạng thái `PENDING` với `entered_national_id` vừa nhập.

---

## 3. Tải ngầm ảnh CCCD & Tự động đối chiếu QR

Sau khi nhận `entryId` từ bước 2, Android tải ảnh `CCCD_FRONT` và `CCCD_BACK` bất đồng bộ:
1. `POST /api/direct-entry/entries/{entryId}/documents` (`document_type: "CCCD_FRONT" | "CCCD_BACK"`, `expected_entry_version`, `mime_type: "image/jpeg" | "image/png"`, `size_bytes`).
2. `PUT <upload_url>` lên R2 private storage.
3. `POST /api/direct-entry/entries/{entryId}/documents/{documentId}/finalize` (`expected_entry_version`).

### Tương thích OCC khi tải tuần tự `CCCD_FRONT` và `CCCD_BACK`
- Khi `CCCD_FRONT` finalize xong, tác vụ đọc QR chạy ngầm có thể khớp CCCD (`MATCHED_INITIAL`) và tự động điền các trường trống trên hồ sơ, làm tăng `direct_entries.version` thêm `1` (ghi audit action `'cccd_qr_autofill_blank_fields'`).
- Backend đã hỗ trợ **OCC tương thích cho phép reserve/finalize ảnh CCCD kế tiếp** nếu các revision xen giữa `expected_entry_version` và `actual_version` chỉ là `'cccd_qr_autofill_blank_fields'`. Nhờ đó luồng tải ngầm mặt sau của Android không bị lỗi `409 ENTRY_VERSION_CONFLICT` giả.

### Quy tắc đối chiếu tự động sau khi giải mã QR
- **Chuẩn hóa & so sánh chính xác 12 chữ số (`entered_national_id === qr.national_id`):**
  1. **`MATCHED_INITIAL` (Khớp CCCD):**
     - Đánh dấu trạng thái đối chiếu `MATCHED_INITIAL`.
     - Chỉ tự động điền các trường đang trống trên hồ sơ từ QR: `display_name` (nếu đang `""`), `date_of_birth`, `gender`, `address`, `national_id_issued_at` (nếu đang `omitted`/`unknown`).
     - Không bao giờ ghi đè trường người dùng đã nhập.
  2. **`MISMATCH` (Lệch CCCD):**
     - Đánh dấu trạng thái đối chiếu `MISMATCH` (đưa vào hàng đợi **Review thông tin NLĐ**).
     - **Tuyệt đối không** tự sửa `national_id` và **không** tự áp dụng bất kỳ trường nào từ QR vào hồ sơ.
  3. **`QR_UNREADABLE` (Ảnh mờ / không tìm thấy QR / lỗi giải mã):**
     - Khi các ảnh CCCD hiện hành đã xử lý xong nhưng không có mặt nào giải mã được QR hợp lệ, đánh dấu `QR_UNREADABLE`.
     - Nếu một mặt (`CCCD_FRONT`) đã `SUCCEEDED` (`MATCHED_INITIAL` hoặc `MISMATCH`) và mặt còn lại (`CCCD_BACK`) trả về `NO_QR_FOUND`, trạng thái của mặt có QR luôn được giữ nguyên, không bị mặt không có QR ghi đè.

---

## 4. Tra cứu & Thử lại đọc QR (`GET` / `POST /api/direct-entry/entries/{entryId}/cccd-qr`)

### `GET /api/direct-entry/entries/{entryId}/cccd-qr`
Trả về trạng thái giải mã QR theo từng ảnh và đối tượng tổng hợp đối chiếu `reconciliation` của hồ sơ:
```json
{
  "ok": true,
  "entry_id": "11111111-1111-4111-8111-111111111111",
  "entry_version": 3,
  "reconciliation": {
    "entry_id": "11111111-1111-4111-8111-111111111111",
    "status": "MATCHED_INITIAL",
    "entered_national_id_masked": "••••••••8811",
    "qr_national_id_masked": "••••••••8811",
    "qr_document_id": "22222222-2222-4222-8222-222222222222",
    "qr_document_type": "CCCD_FRONT",
    "qr_extraction_id": null,
    "resolved_action": "AUTO_MATCHED_INITIAL",
    "resolved_by_user_id": "55555555-5555-4555-8555-555555555555",
    "resolved_at": "2026-04-10T08:00:00.000Z",
    "resolution_reason": null,
    "updated_at": "2026-04-10T08:00:00.000Z"
  },
  "latest": {
    "extraction_id": "99999999-9999-4999-8999-999999999999",
    "entry_id": "11111111-1111-4111-8111-111111111111",
    "document_id": "22222222-2222-4222-8222-222222222222",
    "document_type": "CCCD_FRONT",
    "document_version": 1,
    "status": "SUCCEEDED",
    "reconciliation_status": "MATCHED_INITIAL",
    "error_code": null,
    "error_field": null,
    "candidate_data": {
      "source": "CCCD_QR",
      "authenticity": "UNVERIFIED_QR_TEXT",
      "national_id": "079095008811",
      "display_name": "Lê Thị Hồng Nhung",
      "date_of_birth": "12/04/1996",
      "date_of_birth_iso": "1996-04-12",
      "gender": "FEMALE",
      "gender_label": "Nữ",
      "address": "45 Lê Lợi, Quận 1, TP. Hồ Chí Minh",
      "national_id_issued_at": "15/06/2022",
      "national_id_issued_at_iso": "2022-06-15"
    },
    "field_merge_preview": {
      "display_name": "applied_to_blank",
      "national_id": "kept_existing",
      "date_of_birth": "applied_to_blank",
      "gender": "applied_to_blank",
      "address": "applied_to_blank",
      "national_id_issued_at": "applied_to_blank"
    },
    "applied_fields": [
      "address",
      "date_of_birth",
      "display_name",
      "gender",
      "national_id_issued_at"
    ],
    "skipped_fields": ["national_id"]
  },
  "extractions": []
}
```

### Giá trị `reconciliation.status`
- `PENDING`: Đang chờ ảnh CCCD tải lên hoặc đang giải mã QR.
- `MATCHED_INITIAL`: Số CCCD nhập khớp chính xác với QR; các trường trống đã được tự động bổ sung từ QR.
- `MISMATCH`: Số CCCD nhập khác với số CCCD trong QR; cần Review.
- `QR_UNREADABLE`: Đã tải ảnh CCCD nhưng không đọc được QR hợp lệ; có thể tải lại ảnh rõ hơn hoặc bấm thử lại.
- `RESOLVED_UPDATED_CCCD`: Đã xử lý Review bằng cách sửa lại số CCCD đã nhập khớp với QR.
- `RESOLVED_FROM_QR`: Đã xử lý Review bằng cách chuẩn hóa thông tin hồ sơ theo dữ liệu QR.

---

## 5. Hàng đợi & Xử lý Review thông tin NLĐ (`/api/direct-entry/cccd-review`)

- **`GET /api/direct-entry/cccd-review?status=NEEDS_REVIEW&limit=50&offset=0`**
  - Lọc theo `status`: `NEEDS_REVIEW` (`MISMATCH` + `QR_UNREADABLE`), `MISMATCH`, `QR_UNREADABLE`, `PENDING`, `MATCHED_INITIAL`, `RESOLVED`, `ALL`.
  - Phạm vi quyền: người tạo hồ sơ luôn thấy và xử lý được hồ sơ do chính mình tạo (`creator_own`); Quản lý dự án (`project_manager`), Trưởng nhóm (`team_leader`), và Admin/Reviewer có quyền theo phạm vi tương ứng.
- **`POST /api/direct-entry/entries/{entryId}/cccd-review`**
  - Header: `Content-Type: application/json`, `Idempotency-Key: <UUID>`.
  - Hành động 1 — Sửa số CCCD đã nhập rồi đối chiếu lại (`UPDATE_ENTERED_CCCD`):
    ```json
    {
      "expected_entry_version": 2,
      "action": "UPDATE_ENTERED_CCCD",
      "national_id": "079095008811",
      "apply_blank_fields": true,
      "reason": "Sửa lại số CCCD bị gõ nhầm"
    }
    ```
  - Hành động 2 — Chuẩn hóa thông tin hồ sơ từ QR (`STANDARDIZE_FROM_QR`):
    ```json
    {
      "expected_entry_version": 2,
      "action": "STANDARDIZE_FROM_QR",
      "fields": [
        "national_id",
        "display_name",
        "date_of_birth",
        "gender",
        "address",
        "national_id_issued_at"
      ],
      "reason": "Chuẩn hóa theo dữ liệu QR CCCD"
    }
    ```
  - Hành động 3 — Nhập thông tin NLĐ thủ công khi QR không đọc được hoặc sai (`MANUAL_UPDATE_DETAILS`):
    ```json
    {
      "expected_entry_version": 3,
      "action": "MANUAL_UPDATE_DETAILS",
      "national_id": "079095008811",
      "display_name": "Nguyễn Văn An",
      "date_of_birth": "15/08/1995",
      "gender": "MALE",
      "address": "Hà Nội",
      "national_id_issued_at": "10/02/2024",
      "reason": "Đã đối chiếu với bản chính"
    }
    ```
    CCCD phải có đúng 12 chữ số; các trường cá nhân còn lại có thể để trống. Thao tác cập nhật trực tiếp trong phạm vi quyền hiện hành, ghi revision/audit và không chờ duyệt. Kết quả nhập tay được giữ nguyên nếu kết quả QR đến muộn.
- **`GET /api/direct-entry/entries/{entryId}/documents/{documentId}/cccd-preview`**
  - Trả về binary ảnh CCCD (`image/jpeg` hoặc `image/png`) với `Cache-Control: private, no-store` để hiển thị đối chiếu trong màn hình Review (không dùng URL công khai).
