# Data Contract — Daily Recruitment Breakdown v0.2 (R1)

| Thuộc tính | Giá trị |
|---|---|
| Contract version | `daily-recruitment-breakdown/0.2` |
| Revision | **R1** — contract reconciliation theo T0 TASK P0-T1-G1-R1 |
| Thay thế | `daily-recruitment-count/0.1` (đã retire) |
| Trạng thái | Đã triển khai trên DEV |
| Owner contract | T1 (WEB) — reviewer T2 (n8n) |
| RPC snapshot | `public.replace_daily_recruitment_breakdown_snapshot_v02(jsonb)` |
| RPC lỗi nguồn | `public.record_recruitment_source_failure_v01(jsonb)` |
| Bảng đích | `public.daily_recruitment_breakdown` |
| Fixture | `docs/contracts/fixtures/daily-recruitment-breakdown/` |

---

## 1. Mục đích và phạm vi

Ghi nhận **số người được tuyển**, tổng hợp theo **ngày** và **4 chiều phân loại**:

| # | Chiều | Field payload | Cột nguồn | Danh mục cho phép |
|---|---|---|---|---|
| 1 | Dự án | `project` | **B** | free text |
| 2 | Ngày vào | `business_date` | **C** | ngày lịch `YYYY-MM-DD` |
| 3 | HRP/Vendor | `provider_type` | **J** | `HRP`, `Vendor` |
| 4 | Người tuyển | `recruiter` | **K** | free text |
| 5 | Loại hình lao động | `employment_type` | **L** | `Thời vụ`, `Chính thức` |

Dashboard phải trả lời được: tổng theo ngày, breakdown theo từng chiều, và **kết hợp** các chiều (§12).

### Tuyệt đối không lưu dữ liệu cá nhân ứng viên

Contract và bảng đích **không có** và **không được có**: họ tên ứng viên · ngày sinh · CCCD/CMND/hộ chiếu ·
địa chỉ · số điện thoại · ghi chú ứng viên · raw row từ Sheet.
Payload chỉ chứa **giá trị tổng hợp**; chỉ **số lượng** đi qua boundary.

Kiểm tra tự động trong `pnpm fixtures:check`: tập cột của bảng aggregate phải **đúng bằng** danh sách mong đợi,
và không bảng nào được có cột thuộc danh sách tên bị cấm.

---

## 2. Nguồn chuẩn

Google Sheet chuẩn có tab `Sheet1` (tên tab lấy từ config/registry, không hard-code trong nhiều node) với mapping:

| Cột | Ý nghĩa |
|---|---|
| **A** | `stt` — không dùng làm khóa, không dùng để nhận diện |
| **B** | Dự án → `project` |
| **C** | Ngày vào → `business_date` |
| **J** | HRP/Vendor → `provider_type` |
| **K** | Người tuyển → `recruiter` |
| **L** | Loại hình lao động → `employment_type` |

`provider_type` chỉ nhận `HRP` hoặc `Vendor`; `employment_type` chỉ nhận `Thời vụ` hoặc `Chính thức`.
**Không** có ánh xạ `on/off`. **Không** suy HRP/Vendor từ người tuyển.

---

## 3. Grain

| Hạng mục | Định nghĩa |
|---|---|
| Grain | `source_id + business_date + project + recruiter + provider_type + employment_type = recruited_count` |
| Khóa duy nhất | `(source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key)` (PRIMARY KEY) |
| Ý nghĩa | `recruited_count` = số hàng hợp lệ thuộc đúng tổ hợp phân loại đó |
| Đơn vị | người (person), số nguyên |
| Publish | mỗi lần publish **thay thế toàn bộ** aggregate hiện tại của **đúng một** source |

Bảng lưu song song **key** (đã chuẩn hóa, dùng gộp nhóm và làm khóa) và **display** (giá trị hiển thị).

---

## 4. Payload snapshot

```json
{
  "contract_version": "daily-recruitment-breakdown/0.2",
  "drive_file_id": "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456",
  "file_name": "Danh sách tuyển dụng - Chi nhánh A",
  "sheet_name": "Sheet1",
  "sync_run_id": "11111111-1111-4111-8111-111111111111",
  "trigger_type": "manual",
  "snapshot_at": "2026-10-01T09:30:00Z",
  "timezone": "Asia/Ho_Chi_Minh",
  "rows_read": 15,
  "rows_valid": 15,
  "rows_rejected": 0,
  "rows_warned": 0,
  "warning_issues": 0,
  "row_issues": [],
  "breakdown": [
    { "business_date": "2026-10-01", "project": "Dự án A", "recruiter": "Nguyễn Văn A",
      "provider_type": "HRP", "employment_type": "Thời vụ", "recruited_count": 3 },
    { "business_date": "2026-10-01", "project": "Dự án A", "recruiter": null,
      "provider_type": "Vendor", "employment_type": "Chính thức", "recruited_count": 1 }
  ]
}
```

> Ví dụ **không chứa PII**: chỉ có ngày, nhãn phân loại và số lượng. `recruiter` là **nhân viên tuyển dụng**,
> không phải ứng viên.

### 4.1. Envelope (bắt buộc)

| Trường | Kiểu | Nullable | Default | Ghi chú |
|---|---|---|---|---|
| `contract_version` | string | không | không | Phải đúng `daily-recruitment-breakdown/0.2` |
| `drive_file_id` | string non-blank | không | không | Google Drive file ID — external stable ID |
| `file_name` | string non-blank | không | không | Chỉ để hiển thị |
| `sheet_name` | string non-blank | không | không | Tab nguồn, từ config/registry |
| `sync_run_id` | **UUID v4** | không | không | Sai version ⇒ `INVALID_SYNC_RUN_ID` |
| `trigger_type` | enum | không | không | `manual` \| `schedule` \| `bot` |
| `snapshot_at` | timestamp UTC | không | không | ISO-8601 có offset (`Z` hoặc `+00:00`) |
| `timezone` | string | không | không | Phải đúng `Asia/Ho_Chi_Minh` |
| `rows_read` | integer ≥ 0 | không | không | Xem §7 |
| `rows_valid` | integer ≥ 0 | không | không | Xem §7 |
| `rows_rejected` | integer ≥ 0 | không | không | Xem §7 |
| `rows_warned` | integer ≥ 0 | không | không | Số hàng **khác nhau** có ít nhất một warning |
| `warning_issues` | integer ≥ 0 | không | không | Tổng số issue mức warning |
| `row_issues` | array | không | không | Chi tiết issue mức hàng; có thể rỗng |
| `breakdown` | array | không | không | Tên field giữ nguyên là `breakdown` |

**Không nhận field lạ** ở cả ba cấp (payload, phần tử `breakdown`, phần tử `row_issues`) ⇒ `UNKNOWN_FIELD`.

### 4.2. Phần tử `breakdown`

| Trường | Kiểu | Nullable | Ghi chú |
|---|---|---|---|
| `business_date` | string `YYYY-MM-DD` | không | Ngày lịch theo Asia/Ho_Chi_Minh |
| `recruited_count` | integer ≥ 0 | không | 0 hợp lệ |
| `project` | string ≤ 200 | có | Thiếu/null/rỗng ⇒ "Không xác định" |
| `recruiter` | string ≤ 200 | có | idem |
| `provider_type` | string ≤ 200 | có | Ngoài danh mục ⇒ "Không hợp lệ" + warning |
| `employment_type` | string ≤ 200 | có | Ngoài danh mục ⇒ "Không hợp lệ" + warning |

### 4.3. Phần tử `row_issues` — CHỈ ba field

```json
{ "source_row_number": 7, "issue_level": "error", "error_code": "MISSING_DATE" }
```

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `source_row_number` | integer ≥ 1 | Số hàng **vật lý** trên Sheet; chỉ là locator, không phải khóa |
| `issue_level` | enum | `error` hoặc `warning` |
| `error_code` | enum | Xem bảng dưới |

| `issue_level` | `error_code` hợp lệ |
|---|---|
| `error` | `MISSING_DATE`, `INVALID_DATE` |
| `warning` | `INVALID_PROVIDER_TYPE`, `INVALID_EMPLOYMENT_TYPE` |

**Không** nhận raw value, tên ứng viên, ngày sinh, CCCD, địa chỉ, số điện thoại hay bất kỳ dữ liệu PII nào.
Thêm field khác ⇒ `UNKNOWN_FIELD`. Cùng một `(source_row_number, issue_level, error_code)` lặp lại ⇒ `DUPLICATE_ROW_ISSUE`.

---

## 5. Chuẩn hóa chiều phân loại

| Bước | Quy tắc |
|---|---|
| 1 | Chuẩn hóa Unicode **NFC** |
| 2 | **Trim** khoảng trắng đầu/cuối |
| 3 | **Gộp** mọi chuỗi khoảng trắng liên tiếp thành **một** space |
| 4 | `*_key` = kết quả bước 1–3 **lowercase**; `*_display` = giá trị canonical (bảng dưới) |

**Không** bỏ dấu, **không** sửa lỗi chính tả, **không** map alias, **không** dùng AI, **không** suy HRP/Vendor từ người tuyển.

### 5.1. Danh mục và sentinel

| Chiều | Đầu vào sau bước 1–3 | `*_key` | `*_display` |
|---|---|---|---|
| `provider_type` | thiếu / `null` / rỗng | `__unknown__` | `Không xác định` |
| `provider_type` | `hrp` (không phân biệt hoa/thường) | `hrp` | `HRP` |
| `provider_type` | `vendor` | `vendor` | `Vendor` |
| `provider_type` | giá trị khác | `__invalid__` | `Không hợp lệ` |
| `employment_type` | thiếu / `null` / rỗng | `__unknown__` | `Không xác định` |
| `employment_type` | `thời vụ` | `thời vụ` | `Thời vụ` |
| `employment_type` | `chính thức` | `chính thức` | `Chính thức` |
| `employment_type` | giá trị khác | `__invalid__` | `Không hợp lệ` |
| `project`, `recruiter` | thiếu / `null` / rỗng | `__unknown__` | `Không xác định` |
| `project`, `recruiter` | giá trị khác | lowercase sau chuẩn hóa | giữ nguyên chữ hoa/thường |

`*_display` của J/L **suy trực tiếp từ key** nên key và display không thể lệch nhau.
Ràng buộc CHECK trong database bảo đảm điều này.

Ví dụ đã kiểm thử: `" hrp "` → key `hrp` / display `HRP`; `"chính   thức"` → key `chính thức` / display `Chính thức`; `"abc"` → key `__invalid__` / display `Không hợp lệ`.

### 5.2. Giá trị free text đặc biệt

Với `project` và `recruiter`, các nhãn `-`, `N/A`, `không có` vẫn là **giá trị thật** (khác `__unknown__`),
vì việc quy chúng về "Không xác định" là một suy luận nghiệp vụ chưa được duyệt.

---

## 6. Quy tắc hàng (phía đọc nguồn)

| # | Điều kiện | Kết quả |
|---|---|---|
| C1 | Cả **B, C, J, K, L** đều trống | **Bỏ qua** — không tính vào `rows_read` |
| C2 | Có **ít nhất một** giá trị trong B/C/J/K/L | Tính vào `rows_read` |
| C3 | C trống | `MISSING_DATE` mức `error` ⇒ **rejected** |
| C4 | C sai (không parse được) | `INVALID_DATE` mức `error` ⇒ **rejected** |
| C5 | C hợp lệ | Hàng thuộc `rows_valid` và được tính vào `breakdown` |
| C6 | J trống | Nhóm **Không xác định**, **không** warning |
| C7 | L trống | Nhóm **Không xác định**, **không** warning |
| C8 | J ngoài `HRP`/`Vendor` | `provider_type = Không hợp lệ` + warning `INVALID_PROVIDER_TYPE`; hàng **vẫn thuộc** `rows_valid` và **vẫn được tính** |
| C9 | L ngoài `Thời vụ`/`Chính thức` | `employment_type = Không hợp lệ` + warning `INVALID_EMPLOYMENT_TYPE`; hàng **vẫn được tính** |
| C10 | Một hàng sai cả J và L | `rows_warned` tăng **1**; `warning_issues` tăng **2** |
| C11 | Hàng bị rejected (C3/C4) | **Chỉ** sinh issue mức `error`, **không** sinh warning — cần thiết để giữ `rows_warned <= rows_valid` |

---

## 7. Bất biến (RPC từ chối nếu vi phạm)

| # | Bất biến | Error code |
|---|---|---|
| I1 | `rows_read = rows_valid + rows_rejected` | `ROWS_COUNT_MISMATCH` |
| I2 | `sum(breakdown[].recruited_count) = rows_valid` | `COUNT_MISMATCH` |
| I3 | `rows_warned <= rows_valid` | `INVALID_WARNING_COUNTS` |
| I4 | `rows_warned` = số `source_row_number` **khác nhau** có `issue_level = warning` | `WARNING_COUNT_MISMATCH` |
| I5 | `warning_issues` = số phần tử `row_issues` có `issue_level = warning` | `WARNING_COUNT_MISMATCH` |
| I6 | `rows_rejected` = số `source_row_number` **khác nhau** có `issue_level = error` | `REJECTED_COUNT_MISMATCH` |
| I7 | Không `source_row_number` nào vừa có `error` vừa có `warning` | `MIXED_ROW_ISSUE_LEVEL` |
| I8 | Xuất hiện nhóm `__invalid__` của J ⇔ có ít nhất một warning `INVALID_PROVIDER_TYPE` (và tương tự cho L) | `ISSUE_LINKAGE_MISMATCH` |

I4/I5/I6 bảo đảm **mọi cảnh báo và mọi hàng bị loại đều truy được** qua `sync_runs` + `sync_errors`.
I8 bảo đảm dữ liệu "Không hợp lệ" trên dashboard luôn có cảnh báo tương ứng, không xuất hiện âm thầm.

---

## 8. Run status và publish

| Status | Điều kiện |
|---|---|
| `succeeded` | Không rejected, không warning |
| `partial` | Có rejected **hoặc** warning, nhưng source được đọc hoàn chỉnh |
| `failed` | Lỗi nguồn, hoặc payload/DB lỗi |

- Snapshot `succeeded` **và** `partial` đều **được phép** thay thế aggregate hiện tại.
- Snapshot `failed` **không** được thay aggregate. Payload sai hoặc lỗi ghi DB ⇒ giữ nguyên snapshot thành công gần nhất.
- `data_sources.last_successful_sync_at` **chỉ** cập nhật với `succeeded`.
- `partial` phải truy được từ `sync_runs` mới nhất của source và các dòng `sync_errors` tương ứng.

---

## 9. Error codes

### 9.1. RPC snapshot trả về (`outcome = rejected`)

| Code | Nguyên nhân |
|---|---|
| `INVALID_PAYLOAD` | Payload không phải JSON object |
| `UNSUPPORTED_CONTRACT_VERSION` | `contract_version` khác bản hiện hành |
| `UNKNOWN_FIELD` | Field ngoài contract ở payload, `breakdown` hoặc `row_issues` |
| `MISSING_DRIVE_FILE_ID` / `MISSING_FILE_NAME` / `MISSING_SHEET_NAME` | Thiếu/rỗng |
| `INVALID_SYNC_RUN_ID` | `sync_run_id` không phải UUID v4 |
| `INVALID_TRIGGER_TYPE` | Ngoài `manual\|schedule\|bot` |
| `INVALID_SNAPSHOT_AT` | Không parse được thành timestamp |
| `UNSUPPORTED_TIMEZONE` | Khác `Asia/Ho_Chi_Minh` |
| `INVALID_COUNTS` | `rows_*` / `warning_issues` thiếu, không phải số nguyên, hoặc âm |
| `INVALID_ROW_ISSUES` | `row_issues` sai cấu trúc/kiểu, hoặc `error_code` không khớp `issue_level` |
| `DUPLICATE_ROW_ISSUE` | Cùng `(source_row_number, issue_level, error_code)` lặp lại |
| `INVALID_BREAKDOWN` | `breakdown` sai cấu trúc hoặc thiếu field bắt buộc |
| `INVALID_DIMENSION` | Chiều phân loại không phải chuỗi/null hoặc vượt 200 ký tự |
| `INVALID_DATE` | `business_date` sai định dạng hoặc không phải ngày lịch hợp lệ |
| `INVALID_VALUE` | `recruited_count` không phải số nguyên ≥ 0 |
| `DUPLICATE_GRAIN_KEY` | Cùng khóa grain sau chuẩn hóa xuất hiện nhiều lần |
| `ROWS_COUNT_MISMATCH` / `COUNT_MISMATCH` / `INVALID_WARNING_COUNTS` / `WARNING_COUNT_MISMATCH` / `REJECTED_COUNT_MISMATCH` / `MIXED_ROW_ISSUE_LEVEL` / `ISSUE_LINKAGE_MISMATCH` | Vi phạm bất biến §7 |
| `RUN_SOURCE_MISMATCH` | `sync_run_id` đã thuộc source khác |
| `DB_WRITE_FAILED` / `UNEXPECTED_ERROR` | Lỗi ghi DB / lỗi không lường trước — đã rollback toàn bộ |

### 9.2. RPC lỗi nguồn trả về

| Code | Nguyên nhân |
|---|---|
| `UNSUPPORTED_SOURCE_ERROR_CODE` | `error_code` ngoài bốn mã cho phép |
| các code envelope khác | Như §9.1 |
| `RUN_SOURCE_MISMATCH` | `sync_run_id` đã thuộc source khác |

---

## 10. RPC snapshot

```sql
public.replace_daily_recruitment_breakdown_snapshot_v02(p_payload jsonb) returns jsonb
```

- Chỉ `service_role`; `PUBLIC`/`anon`/`authenticated` đã bị `REVOKE EXECUTE`.
- Gọi qua `POST /rest/v1/rpc/replace_daily_recruitment_breakdown_snapshot_v02`.
- Toàn bộ thay thế aggregate của một source nằm trong **một transaction**; source khác không bị ảnh hưởng.

### 10.1. Response thành công

```json
{
  "outcome": "applied",
  "contract_version": "daily-recruitment-breakdown/0.2",
  "source_id": "<uuid>",
  "sync_run_id": "<uuid>",
  "run_status": "succeeded",
  "breakdown_rows_current": 5,
  "breakdown_rows_removed": 0,
  "recruited_count_total": 15,
  "rows_warned": 0,
  "warning_issues": 0,
  "row_issues_logged": 0,
  "run_logged": true,
  "error_code": null,
  "sanitized_reason": null
}
```

| Field | Ý nghĩa |
|---|---|
| `outcome` | `applied` \| `unchanged` \| `rejected` |
| `breakdown_rows_current` | Số dòng grain hiện hành của source sau lệnh |
| `breakdown_rows_removed` | Số tổ hợp bị xóa khỏi current |
| `recruited_count_total` | Tổng số người hiện hành của source |
| `rows_warned` / `warning_issues` | Giá trị đã ghi vào `sync_runs` |
| `row_issues_logged` | Số dòng `sync_errors` đã ghi cho lần này |
| `run_logged` | `true` nếu RPC ghi được `sync_runs`/`sync_errors` |

Khi `outcome = rejected`: aggregate không đổi. RPC vẫn ghi `sync_runs` `failed` + `sync_errors` nếu đã xác định được
source hiện có và `sync_run_id` hợp lệ. Riêng `sync_run_id` **không phải UUID v4** thì không thể ghi run
(`run_logged = false`) — T2 phải tự log ở phía workflow.

---

## 11. RPC ghi lỗi đọc nguồn

```sql
public.record_recruitment_source_failure_v01(p_payload jsonb) returns jsonb
```

Dùng khi **không đọc được nguồn**. Không có `breakdown` và không có counts: nguồn không đọc được thì không có snapshot.

```json
{
  "contract_version": "daily-recruitment-breakdown/0.2",
  "drive_file_id": "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456",
  "file_name": "Danh sách tuyển dụng - Chi nhánh A",
  "sheet_name": "Sheet1",
  "sync_run_id": "30303030-3030-4030-8030-303030303030",
  "trigger_type": "manual",
  "snapshot_at": "2026-10-01T20:00:00Z",
  "timezone": "Asia/Ho_Chi_Minh",
  "error_code": "SOURCE_READ_FAILED",
  "sanitized_reason": "Không đọc được nguồn (quyền hoặc mạng)"
}
```

| `error_code` | Ý nghĩa |
|---|---|
| `FILE_NOT_NATIVE_SHEET` | File nguồn không phải Google Sheets gốc |
| `SHEET_NOT_FOUND` | Không tìm thấy tab cấu hình trong file nguồn |
| `INVALID_HEADER` | Header nguồn không khớp cấu hình cột chuẩn |
| `SOURCE_READ_FAILED` | Không đọc được nguồn (quyền, mạng hoặc quota) |

RPC này: **upsert** source metadata (file_name, sheet_name, last_seen_at) · ghi `sync_runs` status `failed` ·
ghi `sync_errors` mức `error` · **KHÔNG** xóa hay thay đổi `daily_recruitment_breakdown` ·
**KHÔNG** cập nhật `last_successful_sync_at`.

`sanitized_reason` là tùy chọn: nếu không gửi, RPC dùng mô tả cố định theo `error_code`. Giá trị gửi lên bị cắt ký tự
điều khiển và giới hạn 500 ký tự. **Không** đưa nội dung hàng hay dữ liệu ứng viên vào đây.

Response: `{ outcome: "recorded", run_status: "failed", source_error_code, snapshot_unchanged: true, breakdown_rows_current, recruited_count_total }`.

---

## 12. Truy vấn báo cáo

```sql
-- Tổng theo ngày
select business_date, sum(recruited_count) as recruited
  from public.daily_recruitment_breakdown
 where source_id = any(:source_ids) and business_date between :from and :to
 group by business_date order by business_date;

-- Breakdown theo dự án (thay project_display bằng recruiter_display,
-- provider_type_display hoặc employment_type_display cho các chiều còn lại)
select project_display, sum(recruited_count) as recruited
  from public.daily_recruitment_breakdown
 where source_id = any(:source_ids) and business_date between :from and :to
 group by project_display order by recruited desc;

-- Kết hợp nhiều chiều (AND)
select project_display, provider_type_display, employment_type_display, sum(recruited_count)
  from public.daily_recruitment_breakdown
 where source_id = any(:source_ids)
   and business_date between :from and :to
   and project_display = :project
   and provider_type_display = :provider
 group by 1, 2, 3;
```

---

## 13. Fixture và kết quả mong đợi

Fixture: `docs/contracts/fixtures/daily-recruitment-breakdown/` (30 file). Chạy `pnpm fixtures:check`.

| Case | Fixture | Kết quả mong đợi |
|---|---|---|
| A | `a-initial.json` | `succeeded`; 5 dòng; tổng 15; mọi breakdown và filter kết hợp đúng |
| B | `b-replay.json` | `unchanged`; không duplicate |
| C | `c-correction.json` | `applied`; đúng một dòng đổi; tổng 14 |
| D | `d-row-removed.json` | `applied`; `breakdown_rows_removed = 1` |
| E | `e-normalization-messy.json` | key chuẩn hóa; display free text giữ nguyên; J/L canonical |
| F | `f-normalization-match.json` | cùng grain khác display ⇒ vẫn 1 dòng |
| G | `g-missing-dimensions.json` | nhóm `__unknown__` / "Không xác định"; **không** warning; `succeeded` |
| H | `h-source-b.json` | hai source độc lập |
| I | `i-partial-errors.json` | `MISSING_DATE` + `INVALID_DATE` ⇒ `partial`; **aggregate vẫn bị thay**; `last_successful_sync_at` không đổi |
| J | `j-partial-warnings.json` | `__invalid__` + một hàng hai warning ⇒ `partial`; `rows_warned = 3`, `warning_issues = 4` |
| K | `k-sentinel-canonicalization.json` | `" hrp "` → `HRP`; `"chính   thức"` → `Chính thức` |
| L | `l-source-failure.json` | `recorded`; run `failed`; **aggregate giữ nguyên**; `last_successful_sync_at` không đổi |
| M | `m-source-failure-not-native.json` | `FILE_NOT_NATIVE_SHEET` cho source B; aggregate B giữ nguyên |
| X | `x-*.json` (16 file) | `rejected` đúng error code; aggregate **không đổi** |
| Y | `y-unsupported-error-code.json` | `UNSUPPORTED_SOURCE_ERROR_CODE` |

---

## 14. Đối soát với nguồn

| Đại lượng | Công thức |
|---|---|
| Số người theo ngày và phân loại | `recruited_count` của dòng grain tương ứng |
| Tổng của snapshot | `sum(recruited_count)` — phải bằng `rows_valid` |
| Số hàng đã đọc | `sync_runs.rows_read` — số hàng có ít nhất một giá trị trong B/C/J/K/L (trừ header) |
| Số hàng bị loại | `sync_runs.rows_rejected` — mỗi hàng phải có dòng `sync_errors` mức `error` |
| Số hàng cảnh báo | `sync_runs.rows_warned` — mỗi hàng phải có dòng `sync_errors` mức `warning` |

So khớp chỉ có giá trị tại một **cutoff** đã chốt.

---

## 15. Quan hệ với v0.1

`daily-recruitment-count/0.1` đã **retire**: tài liệu `docs/contracts/daily-recruitment-count-v0.1.md` chỉ còn giá trị lịch sử;
RPC v01 và bảng `daily_recruitment_counts` đã bị gỡ bằng migration `20261001130000`. Không tồn tại hai pipeline song song.

---

## 16. Điểm chưa được chốt (cần Owner/T0 quyết định)

1. **Trùng ứng viên giữa nhiều Sheet.** v0.2 đếm theo hàng vật lý trên từng source, **không** dedup cross-source.
2. **Retention.** Chỉ giữ snapshot hiện hành, không giữ lịch sử snapshot.
3. **Nhãn `-`, `N/A`, `không có` trong project/recruiter** hiện là giá trị thật (§5.2).
4. **Lease chống chạy đồng thời**: chưa có; replace snapshot là nguyên tử và idempotent nên hai run đồng thời hội tụ về lần ghi sau.
