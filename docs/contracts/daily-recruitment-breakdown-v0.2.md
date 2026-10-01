# Data Contract — Daily Recruitment Breakdown v0.2

| Thuộc tính | Giá trị |
|---|---|
| Contract version | `daily-recruitment-breakdown/0.2` |
| Thay thế | `daily-recruitment-count/0.1` (đã retire — xem §13) |
| Trạng thái | Đã triển khai trên DEV |
| Baseline | `docs/master-plan.md`, `docs/P0.md`, **T0 Change Request — P0/P1 Reporting Grain Update** |
| Owner contract | T1 (WEB) |
| Reviewer | T2 (n8n) |
| Boundary thực thi | RPC `public.replace_daily_recruitment_breakdown_snapshot_v02(jsonb)` |
| Bảng đích | `public.daily_recruitment_breakdown` |
| Fixtures | `docs/contracts/fixtures/daily-recruitment-breakdown/` |
| Bằng chứng kiểm thử | `docs/acceptance/p0-t1-g1-fixtures.md` |

---

## 1. Mục đích và phạm vi

Ghi nhận **số người được tuyển**, tổng hợp theo **ngày** và **4 chiều phân loại**:

| # | Chiều | Field payload | Ví dụ |
|---|---|---|---|
| 1 | Dự án | `project` | `Dự án A` |
| 2 | Người tuyển | `recruiter` | `Nguyễn Văn A` |
| 3 | HRP/Vendor | `provider_type` | `HRP`, `Vendor` |
| 4 | Loại hình làm việc | `employment_type` | `Thời vụ`, `Chính thức` |

Dashboard phải trả lời được: tổng theo ngày, và breakdown theo từng chiều, và **kết hợp** các chiều (§10).

### Tuyệt đối không lưu dữ liệu cá nhân ứng viên

Contract và bảng đích **không có** và **không được có** các trường:
họ tên ứng viên · ngày sinh · CCCD/CMND/hộ chiếu · địa chỉ · số điện thoại · ghi chú ứng viên ·
và bất kỳ raw row nào từ Sheet.

Payload chỉ chứa **giá trị tổng hợp**. Việc đếm được thực hiện ở phía đọc nguồn; chỉ **số lượng** đi qua boundary.

Có kiểm tra tự động trong `pnpm fixtures:check`: tập cột của bảng aggregate phải **đúng bằng** danh sách mong đợi,
và không bảng nào được có cột thuộc danh sách tên bị cấm.

---

## 2. Grain

| Hạng mục | Định nghĩa |
|---|---|
| Grain | `source_id + business_date + project + recruiter + provider_type + employment_type = recruited_count` |
| Khóa duy nhất | `(source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key)` — PRIMARY KEY |
| Ý nghĩa | `recruited_count` = số hàng vật lý trong Sheet có "ngày vào" hợp lệ, thuộc đúng tổ hợp phân loại đó |
| Đơn vị | người (person), số nguyên |
| Publish | Mỗi lần publish **thay thế toàn bộ** aggregate hiện tại của **đúng một** source |

Bảng lưu song song **key** (đã chuẩn hóa, dùng để gộp nhóm và làm khóa) và **display** (giá trị hiển thị). Xem §5.

---

## 3. Source identity

| Hạng mục | Định nghĩa |
|---|---|
| External stable ID | `drive_file_id` — Google Drive file ID |
| Khóa nội bộ | `data_sources.id` (uuid) do database sinh |
| Upsert source | `ON CONFLICT (drive_file_id)` — tự tạo lần đầu, sau đó cập nhật metadata |
| Không dùng làm khóa | tên file, tên tab, cột `stt`, số thứ tự hàng |

---

## 4. Payload

```json
{
  "contract_version": "daily-recruitment-breakdown/0.2",
  "drive_file_id": "P0FIXTURE_DRIVE_FILE_A",
  "file_name": "Danh sách tuyển dụng - Chi nhánh A",
  "sheet_name": "Sheet1",
  "sync_run_id": "11111111-1111-4111-8111-111111111111",
  "trigger_type": "manual",
  "snapshot_at": "2026-10-01T09:30:00Z",
  "timezone": "Asia/Ho_Chi_Minh",
  "rows_read": 15,
  "rows_valid": 15,
  "rows_rejected": 0,
  "breakdown": [
    {
      "business_date": "2026-10-01",
      "project": "Dự án A",
      "recruiter": "Nguyễn Văn A",
      "provider_type": "HRP",
      "employment_type": "Thời vụ",
      "recruited_count": 3
    },
    {
      "business_date": "2026-10-01",
      "project": "Dự án A",
      "recruiter": "Nguyễn Văn A",
      "provider_type": "HRP",
      "employment_type": "Chính thức",
      "recruited_count": 1
    },
    {
      "business_date": "2026-10-02",
      "project": "Dự án B",
      "recruiter": null,
      "provider_type": "Vendor",
      "employment_type": "Chính thức",
      "recruited_count": 5
    }
  ]
}
```

> Ví dụ trên **không chứa PII**: chỉ có ngày, nhãn phân loại và số lượng.
> `recruiter` là **nhân viên tuyển dụng** (người tuyển), **không phải** ứng viên.
> `null` ở `recruiter` nghĩa là "Không xác định" (§6).

### 4.1. Trường envelope (bắt buộc)

| Trường | Kiểu | Nullable | Default | Ghi chú |
|---|---|---|---|---|
| `contract_version` | string | không | không | Phải đúng `daily-recruitment-breakdown/0.2`; version khác bị **từ chối** |
| `drive_file_id` | string non-blank | không | không | External stable ID |
| `file_name` | string non-blank | không | không | Chỉ để hiển thị |
| `sheet_name` | string non-blank | không | không | Tab nguồn; lấy từ config/registry |
| `sync_run_id` | uuid | không | không | Xem §7.2 |
| `trigger_type` | enum | không | không | `manual` \| `schedule` \| `bot` |
| `snapshot_at` | timestamp UTC | không | không | ISO-8601 có offset (`Z` hoặc `+00:00`) |
| `timezone` | string | không | không | v0.2 yêu cầu đúng `Asia/Ho_Chi_Minh` |
| `rows_read` | integer ≥ 0 | không | không | Xem §8 |
| `rows_valid` | integer ≥ 0 | không | không | Xem §8 |
| `rows_rejected` | integer ≥ 0 | không | không | Xem §8 |
| `breakdown` | array | không | không | Có thể là mảng rỗng (snapshot hợp lệ, §7.3) |

**Không nhận field lạ** ở cả hai cấp — kể cả bên trong phần tử `breakdown` ⇒ `UNKNOWN_FIELD`.
Mục đích: không âm thầm bỏ mất dữ liệu mà bên gửi tưởng đã ghi.

### 4.2. Phần tử `breakdown`

| Trường | Kiểu | Nullable | Default | Ghi chú |
|---|---|---|---|---|
| `business_date` | string `YYYY-MM-DD` | không | không | Ngày lịch theo Asia/Ho_Chi_Minh |
| `recruited_count` | integer ≥ 0 | không | không | 0 hợp lệ |
| `project` | string ≤ 200 ký tự | **có** | — | Thiếu/null/rỗng ⇒ "Không xác định" |
| `recruiter` | string ≤ 200 ký tự | **có** | — | idem |
| `provider_type` | string ≤ 200 ký tự | **có** | — | idem |
| `employment_type` | string ≤ 200 ký tự | **có** | — | idem |

---

## 5. Chuẩn hóa chuỗi phân loại

Áp dụng **thống nhất ở boundary** (RPC), không lặp lại ở n8n hay UI. Lớp TS `src/lib/contracts/daily-recruitment-breakdown.ts`
mirror đúng các bước này cho early validation; **database là nơi quyết định**.

| Bước | Quy tắc |
|---|---|
| 1 | Chuẩn hóa Unicode **NFC** |
| 2 | **Trim** khoảng trắng đầu/cuối |
| 3 | **Gộp** mọi chuỗi khoảng trắng liên tiếp (space/tab/newline) thành **một** space |
| 4 | `*_key` = kết quả bước 1–3 **lowercase** (gộp nhóm + khóa); `*_display` = kết quả bước 1–3 **giữ nguyên chữ hoa/thường** |
| 5 | Thiếu / null / rỗng sau bước 1–3 ⇒ quy ước "Không xác định" (§6) |

**Không được làm:** bỏ dấu, sửa lỗi chính tả, map alias, đoán tên gần đúng, dùng AI/LLM để chuẩn hóa,
tách/gộp từ viết tắt, hoặc suy ra "HRP" từ tên người tuyển.

Ví dụ (đã kiểm thử tự động):

| Input | `*_key` | `*_display` |
|---|---|---|
| `"  Dự   án  A "` | `dự án a` | `Dự án A` |
| `"NGUYỄN   VĂN A"` | `nguyễn văn a` | `NGUYỄN VĂN A` |
| `" hrp "` | `hrp` | `hrp` |
| `"Thời   vụ"` | `thời vụ` | `Thời vụ` |

**Hệ quả cần biết:** hai giá trị chỉ khác nhau về hoa/thường hoặc khoảng trắng được coi là **cùng một nhóm**.
Nếu cùng một snapshot chứa hai dòng mà key trùng nhau sau chuẩn hóa ⇒ **từ chối toàn bộ** (`DUPLICATE_GRAIN_KEY`), không cộng dồn và không chọn tùy tiện.

---

## 6. Quy ước giá trị thiếu

| Tình huống | `*_key` | `*_display` |
|---|---|---|
| Field vắng mặt trong phần tử `breakdown` | `__unknown__` | `Không xác định` |
| `null` | `__unknown__` | `Không xác định` |
| Chuỗi rỗng hoặc chỉ có khoảng trắng | `__unknown__` | `Không xác định` |

- `__unknown__` là **giá trị dành riêng**; không dùng cho dữ liệu thật.
- "Không xác định" là một **nhóm bình thường** trong breakdown, hiển thị được trên dashboard.
- **Không** biến giá trị thiếu thành chuỗi rỗng, thành "0 người", hoặc gán vào nhóm khác.

**Chưa được coi là "không xác định"** (cần Owner quyết định trước khi áp dụng): các nhãn như `-`, `N/A`, `không có`, `chưa rõ`.
v0.2 giữ chúng là **giá trị thật** vì việc quy chúng về "không xác định" là một suy luận nghiệp vụ.

---

## 7. Thời gian, run, replay và sửa/xóa

### 7.1. Thời gian

- `business_date` là **ngày lịch** theo `Asia/Ho_Chi_Minh`, độc lập với timezone máy chạy n8n/VPS/trình duyệt/UTC.
- `snapshot_at` là **thời điểm UTC** của lần đọc nguồn; lưu ở cột `timestamptz`; là mốc độ tươi, không phải business date.
- Ngày không hợp lệ theo lịch (`2026-02-30`) bị từ chối, không chỉ kiểm tra bằng regex.

### 7.2. Số và run

- `recruited_count` là số nguyên ≥ 0; không dùng dấu phân nhóm, không dùng số thực.
- Một `sync_run_id` chỉ thuộc **một** source; dùng lại với source khác ⇒ `RUN_SOURCE_MISMATCH`.
- Gửi lại **cùng `sync_run_id`** là idempotent (dùng khi mất response). Mỗi lần chạy mới phải dùng run_id mới.
- `sync_runs.started_at` lấy từ `snapshot_at` khi run chưa tồn tại.

### 7.3. Replay, correction, xóa

| Tình huống | Hành vi |
|---|---|
| Replay cùng nội dung, run mới | `unchanged`; không thêm/xóa dòng; tổng không đổi; run mới vẫn được ghi |
| Replay cùng nội dung, **cùng** run | `unchanged`; run được cập nhật (idempotent) |
| Sửa số lượng của một tổ hợp | `applied`; dòng cùng khóa grain được cập nhật; **không** tạo dòng thứ hai |
| Thêm tổ hợp mới | `applied` |
| Tổ hợp không còn trong snapshot | Dòng tương ứng bị **xóa khỏi current**; `breakdown_rows_removed` đếm đúng số tổ hợp bị bỏ |
| Snapshot rỗng, run thành công | `applied`; xóa toàn bộ aggregate của source; `last_successful_sync_at` cập nhật |
| **Đọc file thất bại** | **Không gọi RPC.** Run phải là `failed`; snapshot thành công gần nhất **giữ nguyên** |
| **Payload không hợp lệ** | `rejected`; snapshot thành công gần nhất **giữ nguyên** |
| **Lỗi ghi DB giữa chừng** | Rollback toàn bộ; snapshot thành công gần nhất **giữ nguyên**; `DB_WRITE_FAILED` |

### 7.4. Tính nguyên tử

- Toàn bộ việc thay thế aggregate của một source nằm trong **một transaction**.
- Source khác **không bị ảnh hưởng**.
- Chỉ publish sau khi đã đọc source **hoàn chỉnh**.

---

## 8. Quy tắc đếm

| Quy tắc | Diễn giải |
|---|---|
| R1 | Mỗi **hàng vật lý** có "ngày vào" hợp lệ = **một người** |
| R2 | **Header không tính** |
| R3 | Hàng không có "ngày vào" (kể cả hàng trống) **bị bỏ qua**, không vào `rows_read` |
| R4 | "Ngày vào" không rỗng nhưng **không parse được** ⇒ **reject** |
| R5 | `rows_read` = số hàng có ô "ngày vào" không rỗng (đã trừ header, đã trừ R3) |
| R6 | `rows_valid` = số hàng có ngày parse được |
| R7 | `rows_rejected` = số hàng bị reject theo R4 |
| R8 | **Bắt buộc:** `rows_valid + rows_rejected = rows_read` (`ROWS_COUNT_MISMATCH`) |
| R9 | **Bắt buộc:** `sum(breakdown[].recruited_count) = rows_valid` (`COUNT_MISMATCH`) |
| R10 | Hai hàng cùng ngày, cùng phân loại vẫn là **hai người**; T2 cộng chúng thành **một** phần tử breakdown |
| R11 | Không gửi phần tử cho tổ hợp không xuất hiện. Gửi `recruited_count = 0` là **khẳng định** đã đọc và tổ hợp đó không có ai |

---

## 9. Error codes

### 9.1. Boundary trả về (`outcome = "rejected"`)

Khi bị từ chối, RPC **không** thay đổi aggregate. Nếu source đã tồn tại và `sync_run_id`/`trigger_type` hợp lệ,
RPC ghi 1 dòng `sync_runs` status `failed` và 1 dòng `sync_errors`.

| Code | Nguyên nhân |
|---|---|
| `INVALID_PAYLOAD` | Payload không phải JSON object |
| `UNSUPPORTED_CONTRACT_VERSION` | `contract_version` khác `daily-recruitment-breakdown/0.2` |
| `UNKNOWN_FIELD` | Field ngoài contract, ở payload hoặc trong phần tử `breakdown` |
| `MISSING_DRIVE_FILE_ID` / `MISSING_FILE_NAME` / `MISSING_SHEET_NAME` | Thiếu/rỗng |
| `INVALID_SYNC_RUN_ID` | Không phải uuid |
| `INVALID_TRIGGER_TYPE` | Ngoài `manual\|schedule\|bot` |
| `INVALID_SNAPSHOT_AT` | Không parse được thành timestamp |
| `UNSUPPORTED_TIMEZONE` | Khác `Asia/Ho_Chi_Minh` |
| `INVALID_COUNTS` | `rows_*` thiếu / không phải số nguyên / âm |
| `ROWS_COUNT_MISMATCH` | Vi phạm R8 |
| `INVALID_BREAKDOWN` | `breakdown` không phải array, phần tử không phải object, hoặc thiếu field bắt buộc |
| `INVALID_DIMENSION` | Chiều phân loại không phải chuỗi/null, hoặc vượt 200 ký tự |
| `INVALID_DATE` | `business_date` sai định dạng hoặc không phải ngày lịch hợp lệ |
| `INVALID_VALUE` | `recruited_count` không phải số nguyên ≥ 0 |
| `DUPLICATE_GRAIN_KEY` | Cùng khóa grain sau chuẩn hóa xuất hiện nhiều lần |
| `COUNT_MISMATCH` | Vi phạm R9 |
| `RUN_SOURCE_MISMATCH` | `sync_run_id` đã thuộc source khác |
| `DB_WRITE_FAILED` | Lỗi ghi DB (đã rollback toàn bộ) |
| `UNEXPECTED_ERROR` | Lỗi không lường trước (đã rollback toàn bộ) |

### 9.2. Lỗi phía nguồn (T2 tự ghi nhận, không đi qua RPC)

| Code | Xử lý |
|---|---|
| `SOURCE_READ_FAILED` | Không đọc được Sheet (quyền/network/quota). Run `failed`; **không** gửi snapshot rỗng; **không** suy diễn xóa |

### 9.3. Run status

| Status | Điều kiện |
|---|---|
| `succeeded` | Snapshot được chấp nhận và `rows_rejected = 0` |
| `partial` | Snapshot được chấp nhận nhưng `rows_rejected > 0` |
| `failed` | Payload bị từ chối hoặc lỗi ghi DB |
| `running` | RPC này không tạo; chừa chỗ cho run-start marker ở phase sau |

`data_sources.last_successful_sync_at` **chỉ** cập nhật khi run `succeeded`.

---

## 10. RPC boundary và truy vấn báo cáo

```sql
public.replace_daily_recruitment_breakdown_snapshot_v02(p_payload jsonb) returns jsonb
```

- Chỉ `service_role`; `PUBLIC`/`anon`/`authenticated` đã bị `REVOKE EXECUTE`.
- Gọi qua `POST /rest/v1/rpc/replace_daily_recruitment_breakdown_snapshot_v02`.

### 10.1. Response

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
  "run_logged": true,
  "error_code": null,
  "sanitized_reason": null
}
```

| Field | Ý nghĩa |
|---|---|
| `outcome` | `applied` \| `unchanged` \| `rejected` |
| `breakdown_rows_current` | Số dòng grain hiện hành của source sau lệnh |
| `breakdown_rows_removed` | Số tổ hợp bị xóa khỏi current trong lệnh này |
| `recruited_count_total` | Tổng số người hiện hành của source |

**T2 phải coi `outcome = rejected` là thất bại.**

### 10.2. Truy vấn báo cáo (đều dùng cùng một bảng, cùng một định nghĩa)

```sql
-- Tổng theo ngày
select business_date, sum(recruited_count) as recruited
  from public.daily_recruitment_breakdown
 where source_id = any(:source_ids) and business_date between :from and :to
 group by business_date order by business_date;

-- Breakdown theo dự án
select project_display, sum(recruited_count) as recruited
  from public.daily_recruitment_breakdown
 where source_id = any(:source_ids) and business_date between :from and :to
 group by project_display order by recruited desc;

-- Breakdown theo người tuyển / HRP-Vendor / loại hình: thay project_display bằng
-- recruiter_display | provider_type_display | employment_type_display

-- Kết hợp nhiều chiều (mọi chiều kết hợp bằng AND)
select project_display, provider_type_display, employment_type_display, sum(recruited_count)
  from public.daily_recruitment_breakdown
 where source_id = any(:source_ids)
   and business_date between :from and :to
   and project_display = :project
   and provider_type_display = :provider
 group by 1, 2, 3;
```

Tổng luôn khớp giữa mọi cách nhóm vì tất cả cùng đọc một bảng ở một grain.

### 10.3. Bảng dữ liệu

| Bảng | Grain | Khóa |
|---|---|---|
| `data_sources` | 1 dòng = 1 Sheet nguồn | `id`; UNIQUE `drive_file_id` |
| `sync_runs` | 1 dòng = 1 lần chạy | `run_id` |
| `daily_recruitment_breakdown` | grain §2 | PK 6 cột (§2) |
| `sync_errors` | 1 dòng = 1 lỗi mức run/snapshot | `id` |

RLS bật trên cả 4 bảng; **không** có policy cho `anon`/`authenticated`.

---

## 11. Fixture và kết quả mong đợi

Fixture: `docs/contracts/fixtures/daily-recruitment-breakdown/`. Chạy `pnpm fixtures:check`.
Runner tự dọn source `P0FIXTURE_*` trước khi chạy để kết quả tất định.

| Case | Fixture | Nội dung | Kết quả mong đợi |
|---|---|---|---|
| A | `a-initial.json` | 2 dự án, 2 người tuyển, HRP+Vendor, Thời vụ+Chính thức, 2 ngày | `applied`; 5 dòng; tổng 15; mọi breakdown và filter kết hợp đúng |
| B | `b-replay.json` | Replay A, run mới | `unchanged`; 5 dòng; tổng 15; không duplicate |
| C | `c-correction.json` | Sửa một tổ hợp | `applied`; đúng 1 dòng đổi; tổng 14 |
| D | `d-row-removed.json` | Bỏ một tổ hợp | `applied`; 4 dòng; `breakdown_rows_removed = 1`; tổng 10 |
| E | `e-normalization-messy.json` | Chuỗi bẩn (space thừa, hoa/thường) | `applied`; key đã chuẩn hóa; display giữ nguyên |
| F | `f-normalization-match.json` | Cùng grain, display khác | `applied`; **vẫn 1 dòng**; display cập nhật |
| G | `g-missing-dimensions.json` | Chiều phân loại trống/null/thiếu | `applied`; nhóm `__unknown__` / "Không xác định" |
| H | `h-source-b.json` | Source thứ hai | Chỉ B đổi; A giữ nguyên; và ngược lại |
| J | `j-*.json` (9 file) | Payload sai | `rejected` đúng error code; snapshot **không đổi** |

---

## 12. Đối soát với nguồn

| Đại lượng | Công thức |
|---|---|
| Số người theo ngày và phân loại | `recruited_count` của dòng grain tương ứng |
| Tổng số người của snapshot | `sum(recruited_count)` — phải bằng `rows_valid` của lần chạy |
| Số hàng đã đọc | `sync_runs.rows_read` — số hàng có "ngày vào" không rỗng trên Sheet (trừ header) |
| Số hàng bị loại | `sync_runs.rows_rejected` — mỗi hàng phải có lý do trong `sync_errors` |

So khớp chỉ có giá trị tại một **cutoff** đã chốt.

---

## 13. Quan hệ với v0.1

`daily-recruitment-count/0.1` (grain `source_id + business_date`) đã **retire**:
`docs/contracts/daily-recruitment-count-v0.1.md` được giữ làm lịch sử, RPC v01 và bảng
`daily_recruitment_counts` đã bị gỡ bằng migration `20261001130000_p0_retire_daily_recruitment_count_v01.sql`.

Không tồn tại hai pipeline song song. Mọi tích hợp mới phải dùng v0.2.

---

## 14. Điểm chưa được chốt (cần Owner/T0 quyết định)

1. **Cột nguồn cho từng chiều.** Trong mẫu `docs/form_report.xlsx`: cột chứa "ngày vào" là **cột B**
   (task mô tả "cột C"); cột "người tuyển" là **cột I**; cột "thời vụ/ chính thức" là **cột K** với giá trị `on/off`.
   Chưa xác định được cột nào là **dự án** và cột nào là **HRP/Vendor**.
2. **Ánh xạ `on/off` → Thời vụ/Chính thức.** v0.2 lưu nguyên giá trị nguồn; việc quy đổi `on`/`off`
   sang hai nhãn nghiệp vụ **chưa được Owner xác nhận** nên **không** được tự suy luận.
3. **HRP/Vendor lấy từ đâu.** Nếu HRP/Vendor được suy ra từ người tuyển (ví dụ tiền tố trong mã),
   đó là business rule cần được duyệt và đặc tả thành bảng ánh xạ, không nhúng vào workflow.
4. **Nhãn "không xác định" dạng text.** `-`, `N/A`, `không có` hiện là giá trị thật (§6).
5. **Trùng ứng viên giữa nhiều Sheet.** v0.2 đếm theo hàng vật lý trên từng source, **không** dedup cross-source.
6. **Retention.** v0.2 chỉ giữ snapshot hiện hành.
