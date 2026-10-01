# Data Contract — Daily Recruitment Count v0.1

| Thuộc tính | Giá trị |
|---|---|
| Contract version | `daily-recruitment-count/0.1` |
| Trạng thái | Đã triển khai trên DEV (P0-T1-G1) |
| Baseline | `docs/master-plan.md` v1.0, `docs/P0.md` v1.0 |
| Owner contract | T1 (WEB) |
| Reviewer | T2 (n8n) |
| Boundary thực thi | RPC `public.replace_daily_recruitment_snapshot_v01(jsonb)` |
| Migrations | `supabase/migrations/20261001120000_p0_daily_recruitment_foundation.sql`, `supabase/migrations/20261001120100_p0_replace_daily_recruitment_snapshot_v01.sql` |
| Fixtures | `docs/contracts/fixtures/daily-recruitment-count/` |
| Fixture runner | `scripts/check-daily-recruitment-fixtures.mjs` |

Tài liệu này là nguồn tham chiếu duy nhất cho việc T2 ghi dữ liệu vào Supabase ở P0/P1.
Thay đổi contract phải theo quy trình: nêu lý do/tác động → T1 cập nhật migration + contract + fixture → T0 soạn prompt cho T2 → T2 cập nhật workflow → kiểm tra DEV → triển khai.

---

## 1. Mục đích và phạm vi

Ghi nhận **số người được tuyển theo từng ngày** cho từng Google Sheet nguồn.

- "Doanh số" của dự án là **số người tuyển theo ngày**, không phải tiền.
- P0/P1 chỉ thống kê **số hàng có "ngày vào" hợp lệ**, **không** ingest hồ sơ ứng viên.
- Payload là dữ liệu **tổng hợp (aggregate)**, không chứa và không được chứa bất kỳ thông tin ứng viên nào.

**Tuyệt đối không gửi qua boundary này:** họ tên, CCCD, số điện thoại, địa chỉ, ngày sinh, giới tính, người tuyển, ghi chú, hoặc raw row từ Sheet.

---

## 2. Grain

| Hạng mục | Định nghĩa |
|---|---|
| Grain của bảng đích | 1 dòng = 1 cặp (source, business_date) → `recruited_count` |
| Grain của payload | 1 snapshot = toàn bộ tập daily counts hiện hành của **một** source |
| Khóa duy nhất | `daily_recruitment_counts (source_id, business_date)` (PRIMARY KEY) |
| Ý nghĩa giá trị | `recruited_count` = số hàng vật lý trong Sheet có cột "ngày vào" hợp lệ, thuộc ngày `business_date` |
| Đơn vị | người (person) — số nguyên, không đơn vị tiền tệ |

**Publish semantics:** mỗi lần publish là **thay thế toàn bộ** tập daily counts hiện hành của đúng source đó (xem §6).

---

## 3. Source identity

| Hạng mục | Định nghĩa |
|---|---|
| External stable ID | `drive_file_id` — Google Drive file ID của Sheet nguồn |
| Khóa nội bộ | `data_sources.id` (uuid) do database sinh, không do T2 gửi |
| Upsert source | `ON CONFLICT (drive_file_id)` — lần đầu tự tạo, các lần sau cập nhật metadata |
| `first_seen_at` | Giữ nguyên từ lần tạo đầu tiên |
| `last_seen_at` | Cập nhật mỗi lần publish (kể cả replay không đổi) |

**Không được dùng làm khóa:** tên file (`file_name`), tên tab (`sheet_name`), cột `stt`, số thứ tự hàng.
`file_name` chỉ để hiển thị; đổi tên file trên Drive **không** tạo source mới.

---

## 4. Payload

```json
{
  "contract_version": "daily-recruitment-count/0.1",
  "drive_file_id": "P0FIXTURE_DRIVE_FILE_A",
  "file_name": "Danh sách ứng viên - Chi nhánh A",
  "sheet_name": "Sheet1",
  "sync_run_id": "11111111-1111-4111-8111-111111111111",
  "trigger_type": "manual",
  "snapshot_at": "2026-10-01T09:30:00Z",
  "timezone": "Asia/Ho_Chi_Minh",
  "rows_read": 11,
  "rows_valid": 11,
  "rows_rejected": 0,
  "daily_counts": [
    { "business_date": "2026-10-01", "recruited_count": 4 },
    { "business_date": "2026-10-02", "recruited_count": 7 }
  ]
}
```

### 4.1. Trường bắt buộc

| Trường | Kiểu | Nullable | Default | Ghi chú |
|---|---|---|---|---|
| `contract_version` | string | không | không | Phải đúng `daily-recruitment-count/0.1`. Version khác bị **từ chối**, không tự parse |
| `drive_file_id` | string (non-blank) | không | không | External stable ID, xem §3 |
| `file_name` | string (non-blank) | không | không | Chỉ để hiển thị |
| `sheet_name` | string (non-blank) | không | không | Tab nguồn; cấu hình được, không hard-code |
| `sync_run_id` | uuid | không | không | Định danh run; xem §6.2 |
| `trigger_type` | enum | không | không | `manual` \| `schedule` \| `bot` |
| `snapshot_at` | timestamp UTC | không | không | ISO-8601 có offset (`Z` hoặc `+00:00`) |
| `timezone` | string | không | không | v0.1 yêu cầu đúng `Asia/Ho_Chi_Minh` |
| `rows_read` | integer ≥ 0 | không | không | Xem §5 |
| `rows_valid` | integer ≥ 0 | không | không | Xem §5 |
| `rows_rejected` | integer ≥ 0 | không | không | Xem §5 |
| `daily_counts` | array | không | không | Có thể là mảng rỗng (snapshot hợp lệ, xem §6.4) |

**Không nhận field lạ.** Payload chứa key không nằm trong bảng trên bị từ chối (`UNKNOWN_FIELD`) — kể cả bên trong phần tử `daily_counts`. Mục đích: không âm thầm bỏ mất dữ liệu mà bên gửi tưởng đã ghi.

### 4.2. Phần tử `daily_counts`

| Trường | Kiểu | Nullable | Default | Ghi chú |
|---|---|---|---|---|
| `business_date` | string `YYYY-MM-DD` | không | không | Ngày lịch hợp lệ theo Asia/Ho_Chi_Minh |
| `recruited_count` | integer ≥ 0 | không | không | 0 là giá trị hợp lệ |

---

## 5. Quy tắc đếm

| Quy tắc | Diễn giải |
|---|---|
| R1 | Mỗi **hàng vật lý** có "ngày vào" hợp lệ = **một người** |
| R2 | **Header không tính** |
| R3 | Hàng không có "ngày vào" (kể cả hàng trống hoàn toàn) **bị bỏ qua**, không tính vào `rows_read` |
| R4 | "Ngày vào" không rỗng nhưng **không parse được** → **reject** |
| R5 | `rows_read` = số hàng vật lý có ô "ngày vào" không rỗng (đã trừ header, đã trừ hàng bỏ qua theo R3) |
| R6 | `rows_valid` = số hàng có ngày parse được |
| R7 | `rows_rejected` = số hàng bị reject theo R4 |
| R8 | Bất biến bắt buộc: `rows_valid + rows_rejected = rows_read` — RPC từ chối nếu sai (`ROWS_COUNT_MISMATCH`) |
| R9 | Bất biến bắt buộc: `sum(daily_counts.recruited_count) = rows_valid` — RPC từ chối nếu sai (`COUNT_MISMATCH`) |
| R10 | Hai hàng cùng ngày, cùng nội dung vẫn là **hai người** (đếm theo hàng vật lý, không dedup theo tên) |
| R11 | Không gửi dòng cho ngày không xuất hiện trong dữ liệu. Gửi `recruited_count = 0` là **khẳng định** đã đọc và ngày đó không có ai |

---

## 6. Thời gian, số, replay và sửa/xóa

### 6.1. Thời gian

- `business_date` là **ngày lịch** theo `Asia/Ho_Chi_Minh`, độc lập với timezone của máy chạy n8n, VPS, trình duyệt hay UTC.
- `snapshot_at` là **thời điểm UTC** của lần đọc nguồn; lưu ở cột `timestamptz`.
- `snapshot_at` là mốc độ tươi (data currency) của snapshot, **không phải** business date.
- Ngày không hợp lệ theo lịch (ví dụ `2026-02-30`) bị từ chối, không chỉ kiểm tra bằng regex.

### 6.2. Số và run

- `recruited_count` là số nguyên ≥ 0. Không dùng dấu phân nhóm, không dùng số thực.
- Một `sync_run_id` chỉ thuộc **một** source. Gửi lại cùng `sync_run_id` với source khác bị từ chối (`RUN_SOURCE_MISMATCH`).
- Gửi lại **cùng `sync_run_id`** với cùng source là **idempotent**: run đó được cập nhật lại (dùng cho trường hợp DB đã ghi thành công nhưng T2 mất response). Không tạo run trùng.
- Mỗi lần chạy mới phải dùng `sync_run_id` **mới**.
- `sync_runs.started_at` lấy từ `snapshot_at` khi run chưa tồn tại; `finished_at` là thời điểm RPC ghi xong. P0 chưa có run-start marker riêng (xem handoff).

### 6.3. Replay và correction

| Tình huống | Hành vi |
|---|---|
| Replay cùng nội dung, run mới | `outcome = unchanged`; không thêm/xóa dòng; tổng không đổi; run mới vẫn được ghi; `last_seen_at` cập nhật |
| Replay cùng nội dung, **cùng** run | `outcome = unchanged`; run được cập nhật (idempotent) |
| Sửa giá trị một ngày | `outcome = applied`; dòng cùng `(source, business_date)` được thay giá trị; **không** tạo dòng thứ hai |
| Thêm ngày mới | `outcome = applied` |
| Ngày không còn trong snapshot | Dòng tương ứng bị **xóa khỏi current** — đây là hệ quả của "replace toàn bộ", không phải suy diễn xóa |
| Snapshot rỗng, run thành công | `outcome = applied`; xóa toàn bộ daily counts của source; `last_successful_sync_at` cập nhật |

**Giới hạn có chủ đích:** P0 **không** giữ revision history của snapshot cũ và **không** hỗ trợ tombstone riêng lẻ. Xóa một ngày chỉ có nghĩa khi snapshot gửi lên là kết quả đọc **hoàn chỉnh** của source. Nếu lần đọc nguồn thất bại, **không được** gửi snapshot rỗng thay thế — phải để run ở trạng thái `failed` (xem §9.3).

### 6.4. Tính nguyên tử

- Toàn bộ việc thay thế snapshot của một source diễn ra trong **một transaction**.
- Nếu RPC/payload thất bại giữa chừng: **không thay đổi** dữ liệu daily counts.
- Source khác **không bị ảnh hưởng**.
- Chỉ publish sau khi T2 đã đọc source **hoàn chỉnh**.

---

## 7. Error codes

### 7.1. Lỗi do boundary trả về (`outcome = "rejected"`)

Khi bị từ chối, RPC **không** thay đổi daily counts. Nếu source đã tồn tại và `sync_run_id`/`trigger_type` hợp lệ, RPC ghi thêm 1 dòng `sync_runs` status `failed` và 1 dòng `sync_errors`.

| Code | Nguyên nhân |
|---|---|
| `INVALID_PAYLOAD` | Payload không phải JSON object |
| `UNSUPPORTED_CONTRACT_VERSION` | `contract_version` khác `daily-recruitment-count/0.1` |
| `UNKNOWN_FIELD` | Payload có key ngoài §4.1 hoặc ngoài §4.2 |
| `MISSING_DRIVE_FILE_ID` | Thiếu/rỗng `drive_file_id` |
| `MISSING_FILE_NAME` | Thiếu/rỗng `file_name` |
| `MISSING_SHEET_NAME` | Thiếu/rỗng `sheet_name` |
| `INVALID_SYNC_RUN_ID` | `sync_run_id` không phải uuid |
| `INVALID_TRIGGER_TYPE` | `trigger_type` ngoài `manual\|schedule\|bot` |
| `INVALID_SNAPSHOT_AT` | `snapshot_at` không parse được thành timestamp |
| `UNSUPPORTED_TIMEZONE` | `timezone` khác `Asia/Ho_Chi_Minh` |
| `INVALID_COUNTS` | `rows_read/rows_valid/rows_rejected` thiếu, không phải số nguyên, hoặc âm |
| `ROWS_COUNT_MISMATCH` | Vi phạm R8 |
| `INVALID_DAILY_COUNTS` | `daily_counts` không phải array, phần tử không phải object, hoặc thiếu field |
| `INVALID_DATE` | `business_date` sai định dạng hoặc không phải ngày lịch hợp lệ |
| `INVALID_VALUE` | `recruited_count` không phải số nguyên hoặc âm |
| `DUPLICATE_BUSINESS_DATE` | Cùng `business_date` xuất hiện nhiều lần trong một snapshot |
| `COUNT_MISMATCH` | Vi phạm R9 |
| `RUN_SOURCE_MISMATCH` | `sync_run_id` đã thuộc source khác |
| `DB_WRITE_FAILED` | Lỗi ghi DB trong lúc publish (đã rollback toàn bộ) |
| `UNEXPECTED_ERROR` | Lỗi không lường trước (đã rollback toàn bộ) |

### 7.2. Lỗi phía nguồn (T2 tự ghi nhận, không đi qua RPC)

| Code | Nguyên nhân |
|---|---|
| `SOURCE_READ_FAILED` | Không đọc được Google Sheet (quyền/network/quota). Run phải là `failed`; **không** gửi snapshot rỗng thay thế và **không** suy diễn xóa |

### 7.3. Run status do RPC ghi

| Status | Điều kiện |
|---|---|
| `succeeded` | Snapshot được chấp nhận và `rows_rejected = 0` |
| `partial` | Snapshot được chấp nhận nhưng `rows_rejected > 0` |
| `failed` | Payload bị từ chối hoặc lỗi ghi DB |
| `running` | Không được RPC này tạo. Chừa chỗ cho run-start marker ở phase sau |

`data_sources.last_successful_sync_at` **chỉ** được cập nhật khi run `succeeded` (theo `docs/P0.md` §8.1). Run `partial`/`failed` không được che bằng thời gian thành công cũ.

---

## 8. RPC boundary

```sql
public.replace_daily_recruitment_snapshot_v01(p_payload jsonb) returns jsonb
```

| Hạng mục | Giá trị |
|---|---|
| Quyền thực thi | Chỉ `service_role`. `PUBLIC`, `anon`, `authenticated` đã bị `REVOKE EXECUTE` |
| Gọi qua | `POST /rest/v1/rpc/replace_daily_recruitment_snapshot_v01` với body là payload §4 |
| Nguyên tử | Toàn bộ publish trong một transaction |
| Ảnh hưởng | Chỉ source khớp `drive_file_id` |

### 8.1. Response

```json
{
  "outcome": "applied",
  "contract_version": "daily-recruitment-count/0.1",
  "source_id": "00000000-0000-0000-0000-000000000000",
  "sync_run_id": "11111111-1111-4111-8111-111111111111",
  "run_status": "succeeded",
  "daily_rows_current": 2,
  "daily_rows_removed": 0,
  "recruited_count_total": 11,
  "error_code": null,
  "sanitized_reason": null
}
```

| Field | Ý nghĩa |
|---|---|
| `outcome` | `applied` \| `unchanged` \| `rejected` |
| `run_status` | Trạng thái run sau khi xử lý |
| `daily_rows_current` | Số dòng daily counts hiện hành của source sau lệnh |
| `daily_rows_removed` | Số dòng bị xóa khỏi current trong lệnh này |
| `recruited_count_total` | Tổng `recruited_count` hiện hành của source |
| `run_logged` | `true` nếu RPC đã ghi được `sync_runs`/`sync_errors` cho lần gọi này |
| `error_code` / `sanitized_reason` | Chỉ có giá trị khi `outcome = rejected` |

RPC chỉ ghi log từ chối khi đã xác định được **source đã tồn tại** và `sync_run_id` +
`trigger_type` hợp lệ. Payload sai định danh hoặc source chưa từng tồn tại sẽ trả
`outcome = rejected` mà không có dòng `sync_runs` nào — khi đó T2 phải tự log ở phía workflow.

**T2 phải coi `outcome = rejected` là thất bại**, không được ghi log thành công.

---

## 9. Schema tham chiếu

| Bảng | Grain | Khóa |
|---|---|---|
| `data_sources` | 1 dòng = 1 Sheet nguồn | `id`; UNIQUE `drive_file_id` |
| `sync_runs` | 1 dòng = 1 lần chạy | `run_id` |
| `daily_recruitment_counts` | 1 dòng = (source, business_date) | PK `(source_id, business_date)` |
| `sync_errors` | 1 dòng = 1 lỗi của run | `id` (identity) |

RLS được bật trên cả 4 bảng; **không** có policy cho `anon`/`authenticated` → truy cập ẩn danh bị từ chối hoàn toàn.

---

## 10. Fixture và kết quả mong đợi

Fixture: `docs/contracts/fixtures/daily-recruitment-count/`. Chạy `pnpm fixtures:check` trên DEV.
Fixture runner tự xóa các source có `drive_file_id` bắt đầu bằng `P0FIXTURE_` trước khi chạy để kết quả tất định.

| Case | Fixture | Thao tác | Kết quả mong đợi |
|---|---|---|---|
| A | `a-initial.json` | Snapshot đầu, source A | `applied`; 2 dòng; 2026-10-01=4, 2026-10-02=7; tổng 11; run `succeeded` |
| B | `b-replay.json` | Replay A, run mới | `unchanged`; vẫn 2 dòng; tổng 11; không duplicate |
| C | `c-correction.json` | Sửa 2026-10-01 → 3 | `applied`; vẫn 2 dòng; 2026-10-01=3; tổng 10 |
| D | `d-date-removed.json` | Bỏ 2026-10-02 | `applied`; còn 1 dòng; tổng 3 |
| E | `e-empty.json` | Snapshot rỗng | `applied`; 0 dòng; tổng 0; run `succeeded` |
| F | `f-invalid-*.json` | 6 payload sai | `rejected` với đúng error code; daily counts của source **không đổi** |
| G | `g-source-b.json` | Source B riêng | Chỉ B thay đổi; A giữ nguyên |

Chi tiết từng case và expected value nằm trong `docs/acceptance/p0-t1-g1-fixtures.md`.

---

## 11. Đối soát với nguồn (reconciliation)

```sql
select business_date, recruited_count
from public.daily_recruitment_counts
where source_id = :source_id
order by business_date;
```

| Đại lượng | Công thức |
|---|---|
| Số người theo ngày | `recruited_count` của ngày tương ứng |
| Tổng số người của snapshot | `sum(recruited_count)` — phải bằng `rows_valid` của lần chạy |
| Số hàng đã đọc | `sync_runs.rows_read` — phải bằng số hàng có "ngày vào" không rỗng trên Sheet (trừ header) |
| Số hàng bị loại | `sync_runs.rows_rejected` — mỗi hàng phải có lý do trong `sync_errors` |

So khớp chỉ có giá trị tại một **cutoff** đã chốt, vì Sheet có thể đang được sửa.

---

## 12. Điểm chưa được chốt (cần Owner/T0 xác nhận)

Các điểm sau **chưa** phải quyết định nghiệp vụ đã duyệt và **không** được tự suy diễn:

1. **Cột ngày trong Sheet thật.** Task mô tả T2 đọc "cột C". Trong file mẫu `docs/form_report.xlsx`, cột chứa "ngày vào" là **cột B**, còn cột C là "họ tên". Contract chỉ định danh nghĩa *field* `business_date`, không chốt vị trí cột — nhưng T2 cần Owner/T0 xác nhận cột thật của 40–50 Sheet trước khi chạy dữ liệu thật.
2. **Hàng có dữ liệu nhưng ô "ngày vào" để trống.** v0.1 áp dụng R3: bỏ qua, không tính vào `rows_read`, không reject. Nếu Owner muốn đếm là lỗi dữ liệu thì phải bump contract version.
3. **Nhiều Sheet thuộc cùng một người/chuyển nhóm trùng.** v0.1 đếm theo hàng vật lý trên từng source, không dedup cross-source. Nếu một ứng viên xuất hiện ở hai Sheet khác nhau, hệ thống đếm hai lần cho tới khi có rule dedup được duyệt (dự kiến P1-C01).
4. **Retention.** v0.1 chỉ giữ snapshot hiện hành, không giữ lịch sử snapshot.
