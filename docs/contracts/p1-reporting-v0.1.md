# Reporting Contract — BoD P1 v0.1

| Thuộc tính | Giá trị |
|---|---|
| Reporting contract version | `p1-reporting/0.1` |
| Baseline ingestion contract | `daily-recruitment-breakdown/0.2` (R1) — **không đổi semantics** |
| Grain | `source + business_date + project + recruiter + provider_type + employment_type = recruited_count` |
| Trạng thái | Khóa cho P1-W02 (reporting layer); chưa build dashboard, chưa sửa DB, chưa có access gate |
| Fixture | `docs/contracts/fixtures/p1-reporting/input.json` · `expected.json` |

## 1. Nguyên tắc

- Đọc duy nhất bảng `daily_recruitment_breakdown` (+ `data_sources`/`sync_runs` cho scope/coverage/freshness).
- Latest run và presence đọc qua view service-role-only: `reporting_latest_sync_runs_v01`, `reporting_sources_with_current_facts_v01`.
- **Data completeness:** không bao giờ công bố dữ liệu bị truncate như dữ liệu đầy đủ (xem §11).
- Không tính target, KPI, conversion, commission hoặc payroll.
- Không suy luận/AI phân loại. Không đọc/hiển thị dữ liệu ứng viên (D–I/M).
- `Không xác định` và `Không hợp lệ` **vẫn được tính** vào tổng và **phải hiển thị thành nhóm/filter riêng**, không ẩn.
- `recruited_count` là số người; **không** dùng số dòng aggregate làm số người (một dòng = một nhóm, không phải một người).

## 2. Metric

### 2.1. `recruited_total`
- Công thức: `sum(daily_recruitment_breakdown.recruited_count)`.
- Đơn vị: người.
- Chỉ tính các source thuộc reporting scope hiện hành (xem §3).

### 2.2. `recruited_by_date`
- Group theo `business_date`.
- Tổng luôn bằng `recruited_total` trong cùng filter/scope.

### 2.3. Breakdown
- Theo `project`, `recruiter`, `provider_type`, `employment_type`, và tổ hợp các chiều (AND).
- Mỗi breakdown dùng `*_key` làm identity group; `*_display` chỉ để trình bày.

> **Clarification (W02-R2):** breakdown group theo **key** (`project_key`/`recruiter_key`/`provider_type_key`/`employment_type_key`), không theo display. Bucket đầu ra có dạng `{ key, display, recruitedCount }`. Chọn display khi nhiều source cùng key nhưng khác casing: (1) display có tổng `recruited_count` lớn nhất; (2) hòa thì chọn ổn định bằng `localeCompare("vi")`; (3) `__unknown__` → “Không xác định”, `__invalid__` → “Không hợp lệ”. Tổng `recruitedCount` mọi bucket vẫn bằng `recruited_total`. Đây là clarification, không đổi version.

### 2.4. Source coverage (từ `data_sources` + `sync_runs`)
| Field | Định nghĩa |
|---|---|
| `sources_expected` | Số source trong reporting scope (`active=true AND is_test=false`) |
| `sources_succeeded` | Số source có latest run `succeeded` |
| `sources_partial` | Số source có latest run `partial` |
| `sources_failed` | Số source có latest run `failed` |
| `sources_never_succeeded` | Số source có `last_successful_sync_at IS NULL` (chưa từng có snapshot) |
| `coverage_ratio` | `(sources_expected − sources_never_succeeded) / sources_expected` |

> **Clarification (W02-R2):** `coverage_ratio` dựa trên **everSucceeded** (`last_successful_sync_at != null`), không dựa trên trạng thái run hiện tại. Khi có filter `source=<uuid>`, coverage và source-status list chỉ phản ánh source được chọn; không có `source` filter thì phản ánh toàn reporting scope. `dateExtent` là extent của **result sau mọi filter** (min/max `business_date` của facts đã lọc), không phải toàn scope.

> **Clarification (W02):** `coverage_ratio` mang nghĩa **“tỷ lệ nguồn đã từng có snapshot”**, **không** phải tỷ lệ nguồn healthy. Các trạng thái `succeeded`/`partial`/`failed` vẫn phải trả riêng. Khi `sources_expected = 0`, `coverage_ratio = null` (không chia 0, không giả thành 100%). Đây là clarification, không đổi công thức hay version.

### 2.5. Freshness
- Hiển thị `last_successful_sync_at` và trạng thái run gần nhất (per-source).
- **Chưa** tự đặt ngưỡng stale theo giờ vì cadence chưa bật. Khi schedule 6 giờ được kích hoạt, stale threshold là quyết định/version riêng.

### 2.6. Source status / contribution (clarification W02-R2)
Mỗi source trong status list có 3 field tách biệt:

| Field | Định nghĩa |
|---|---|
| `everSucceeded` | `last_successful_sync_at != null` (đã từng có snapshot thành công) |
| `hasCurrentFacts` | source có ≥1 fact trong snapshot hiện hành (độc lập filter) |
| `contributes` | source có facts đang được cộng vào result (sau filter), kể cả snapshot từ partial |

Status:
- `succeeded` → `covered`
- `partial` → `incomplete`
- `failed` + có snapshot/facts cũ → `stale_snapshot`
- `failed` + không có snapshot → `never_succeeded`
- `running` → `running` (riêng, **không** gán `stale_snapshot`/`no_run`)
- chưa có run → `no_run`

Source `partial` lần đầu có valid facts: facts vẫn được tính, `contributes=true`, `everSucceeded=false` (coverage_ratio chưa tính source đó là từng succeeded), `status=incomplete`.

## 3. Source scope

Reporting scope (nguồn BoD P1): `data_sources.active = true AND data_sources.is_test = false`.

### 3.1. Cô lập fixture (quyết định W01, thực thi ở P1-W02)
- **Đề xuất:** thêm cột `data_sources.is_test boolean NOT NULL DEFAULT false`.
- Migration P1-W02 sẽ đánh dấu hai fixture hiện có thành `is_test=true`:
  `P0FIXTURE_DRIVE_FILE_A` và `P0FIXTURE_DRIVE_FILE_B`.
- Source mới do RPC phát hiện mặc định `is_test=false`.
- Reporting scope dùng `active=true AND is_test=false`.
- Trong W01 **không** tạo migration, **không** sửa schema/RPC, **không** xóa fixture.

### 3.2. Nguồn thật hiện tại và mục tiêu
- Hiện có 2 source thật, tổng 2 người.
- Mục tiêu vận hành sau onboarding: khoảng 40–50 file trong report folder.
- **Không** hard-code hai source thật thành allowlist lâu dài.

## 4. Semantics nguồn lỗi / dữ liệu thiếu

| Trạng thái latest run | Đóng góp metric | Cảnh báo |
|---|---|---|
| `succeeded` | Dùng snapshot hiện hành; tính là covered | không |
| `partial` | Dùng các hàng valid đã publish (partial vẫn publish theo R1) | `incomplete`; không tính fully covered |
| `failed` (có snapshot cũ) | Dùng snapshot thành công cũ | hiển thị lỗi/freshness |
| `failed` (chưa từng succeeded) | Không đóng góp metric | thuộc `sources_never_succeeded` |
| `running` | Không đóng góp metric (run chưa xong) | trạng thái `running` riêng |
| `partial` (lần đầu, chưa từng succeeded) | Dùng các hàng valid đã publish; `contributes=true` | `incomplete`; vẫn thuộc `sources_never_succeeded` |
| DB/query error | Trả error state | **không** hiển thị số 0 như dữ liệu thật |

- Không biến source failed thành 0 người. Không giả số rejected thành 0 người hợp lệ.

## 5. Cross-source duplicate

- Mỗi hàng hợp lệ trong mỗi source được tính một người.
- Hệ thống hiện **không đọc PII** nên **không thể deduplicate ứng viên giữa hai file**.
- Nếu cùng một người được nhập ở hai source, hiện sẽ bị đếm hai lần.
- Quy tắc vận hành P1: mỗi tuyển dụng chỉ được ghi ở **một source authoritative**.
- Đây là giới hạn phải hiển thị trong handoff; **không** tự tạo logic fuzzy/AI dedup.

## 6. Filter contract (URL query)

| Param | Giá trị |
|---|---|
| `from` / `to` | `YYYY-MM-DD` |
| `project` | normalized key (NFC→trim→gộp khoảng trắng→lowercase) của project |
| `recruiter` | normalized key của recruiter |
| `provider` | `hrp` \| `vendor` \| `__unknown__` \| `__invalid__` |
| `employment` | `thời vụ` \| `chính thức` \| `__unknown__` \| `__invalid__` |
| `source` | `source-id` (uuid) |

Quy tắc:
- Thiếu `from/to` ⇒ toàn bộ khoảng ngày hiện có. Chỉ có một đầu ngày ⇒ áp dụng đúng đầu đó.
- `from > to` ⇒ validation error; **không** âm thầm đảo ngày.
- Date inclusive ở cả hai đầu, theo `business_date` (Asia/Ho_Chi_Minh).
- Các filter chiều kết hợp bằng **AND**. Thiếu filter chiều ⇒ All.
- URL dùng **normalized key / source UUID**, không dùng display label làm identity.
- Giá trị filter không hợp lệ phải được validate; **không** tạo SQL động.
- **Clarification (W02-R2):** dimension/date filters chỉ ảnh hưởng recruited metrics/breakdowns và `dateExtent`; coverage/source-status list chỉ phụ thuộc `source` filter (không có `source` thì là toàn scope). `source` filter không fallback “All” khi UUID ngoài scope — trả validation error.
- Không hard-code dependency `nuqs` trong contract; lựa chọn thư viện thuộc W02/UI review.

## 7. Trend và ngày không có record

- Trend group theo từng `business_date`.
- Trong date range hữu hạn, UI có thể điền ngày thiếu bằng 0 để vẽ liên tục.
- Số 0 chỉ có nghĩa **“không có recruitment fact trong snapshot hiện hành của reporting scope”**.
- Nếu coverage không đầy đủ, phải hiển thị data-status warning cạnh chart; không để người dùng hiểu 0 là dữ liệu đã đầy đủ.

## 8. Fixture machine-readable

- `docs/contracts/fixtures/p1-reporting/input.json`: 4 source thật giả lập (succeeded/partial/failed-có-snapshot/failed-chưa-từng-succeeded) + 1 source `is_test=true`; nhiều ngày; project/recruiter thường + `Không xác định` + `Không hợp lệ`; HRP/Vendor; Thời vụ/Chính thức; 1 failed source có snapshot cũ.
- `expected.json`: kết quả cho 8 case (no-filter, date range, project+provider, recruiter+employment, unknown/invalid, fixture exclusion, coverage, breakdown-consistency).
- Không chứa dữ liệu thật/PII.

## 9. Acceptance — câu trả lời dứt khoát

1. **Số người tính thế nào?** `recruited_total = sum(recruited_count)` của snapshot hiện hành trong reporting scope.
2. **Source nào được tính?** `active=true AND is_test=false`.
3. **Fixture bị loại thế nào?** `is_test=true` (P1-W02 migration); không nằm trong scope.
4. **Ngày/filter thế nào?** date range `from/to` inclusive (Asia/Ho_Chi_Minh); chiều kết hợp AND; missing ⇒ All.
5. **Partial/failed ảnh hưởng số và cảnh báo?** partial dùng hàng đã publish + cảnh báo incomplete; failed dùng snapshot cũ nếu có, nếu chưa từng succeeded thì không đóng góp; DB error ⇒ error state (không 0).
6. **Unknown/invalid hiển thị thế nào?** thành nhóm/filter riêng, vẫn tính vào tổng.
7. **Vì sao chưa dedup giữa source?** không đọc PII; mỗi hàng hợp lệ = 1 người; quy tắc vận hành một source authoritative; không fuzzy/AI dedup.
8. **Dashboard nào được phép ở W02–W05?** overview tổng + breakdown 4 chiều + filter URL + data status/freshness/coverage; không team hierarchy/candidate drill-down/KPI.

## 10. Dành cho P1-W03 (access gate) — chưa quyết ở đây

- Cơ chế access gate cụ thể (hosting auth, basic auth, proxy…).
- Nguyên tắc giữ nguyên: **gate chạy trước query**; chưa có gate thì **không** bật `/pipeline-check` hoặc dashboard dữ liệu thật trên production.

## 11. Data completeness & pagination (clarification W02-R3)

- Fact query (`daily_recruitment_breakdown`) phải phân trang đầy đủ: page size ≤ 1.000, order ổn định theo đúng khóa chính (`source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key`), `.range(from, to)` inclusive.
- Mọi page áp dụng **cùng** reporting scope + toàn bộ filter (source/from/to/project/recruiter/provider/employment).
- Lấy `count: "exact"` và xác nhận tổng số dòng thu được bằng exact count trước khi trả kết quả.
- Nếu page lỗi, count thiếu/null, count không khớp, hoặc vượt hard ceiling: trả lỗi reporting (`REPORTING_QUERY_FAILED` / `REPORTING_COUNT_MISMATCH` / `REPORTING_RESULT_TOO_LARGE`); **tuyệt đối không** trả `ok:true` với dữ liệu một phần, **không** biến lỗi thành tổng 0.
- Scope rỗng ⇒ không query presence/facts, trả empty state hợp lệ với `coverage_ratio = null`.
