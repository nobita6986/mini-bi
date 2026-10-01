# P0-T1-G1-R1 — Bằng chứng kiểm thử contract `daily-recruitment-breakdown/0.2` (R1)

| Thuộc tính | Giá trị |
|---|---|
| Task | P0-T1-G1-R1 — Contract reconciliation |
| Môi trường | Supabase **DEV**, project ref `kiam…` (không dùng PROD) |
| Lệnh | `pnpm db:migrate` rồi `pnpm fixtures:check` |
| Kết quả | **208/208 kiểm tra PASS, 0 fail** |
| Fixture | `docs/contracts/fixtures/daily-recruitment-breakdown/` (30 file) |

Script `scripts/check-daily-recruitment-fixtures.mjs` tự dọn các source `P0FIXTURE_*` trước khi chạy,
nên kết quả tất định và chạy lại được nhiều lần. Script không dùng cho PROD.

> Bằng chứng của bản trước R1 đã bị thay thế hoàn toàn bởi tài liệu này.

## 1. Kết quả theo case

| Case | Nội dung | Kết quả |
|---|---|---|
| A | Snapshot đầu: 2 dự án, 2 người tuyển, HRP + Vendor, Thời vụ + Chính thức, 2 ngày | `succeeded`; 5 dòng; tổng 15; mọi breakdown và filter kết hợp đúng |
| B | Replay cùng snapshot, run mới | `unchanged`; vẫn 5 dòng; tổng 15; không duplicate |
| C | Sửa một tổ hợp 3 → 2 | `applied`; đúng một dòng đổi; tổng 14 |
| D | Bỏ một tổ hợp khỏi snapshot | `applied`; còn 4 dòng; `breakdown_rows_removed = 1`; tổng 10 |
| E | Chuỗi bẩn: `"  Dự   án  A "`, `"NGUYỄN   VĂN A"`, `" hrp "`, `"Thời   vụ"` | project/recruiter: key chuẩn hóa + display giữ nguyên; J/L: key danh mục + display canonical (`HRP`, `Thời vụ`) |
| F | Cùng grain, display khác | `applied`; **vẫn 1 dòng** |
| G | Chiều phân loại trống (`null`, khoảng trắng, field vắng mặt) | nhóm `__unknown__` / "Không xác định" cho cả 4 chiều; **không** warning; `succeeded` |
| H | Hai source độc lập | Ghi B không đổi A và ngược lại |
| I | PARTIAL do có hàng bị loại | `MISSING_DATE` + `INVALID_DATE`; `partial`; **aggregate vẫn bị thay** |
| J | PARTIAL do cảnh báo | `__invalid__` cho J/L + một hàng hai warning; `partial`; `rows_warned = 3`, `warning_issues = 4` |
| K | Canonical hóa sentinel | `" hrp "` → `hrp` / `HRP`; `"chính   thức"` → `chính thức` / `Chính thức`; `null` → `__unknown__` |
| L | Lỗi đọc nguồn (`SOURCE_READ_FAILED`) | `recorded`; run `failed`; **aggregate giữ nguyên**; `last_successful_sync_at` không đổi |
| M | `FILE_NOT_NATIVE_SHEET` cho source B | run `failed` với đúng error code; aggregate B giữ nguyên |
| X | 16 payload sai | `rejected` đúng error code; mỗi lần đều ghi `sync_runs` `failed` + `sync_errors`; aggregate **không đổi** |
| Y | `error_code` nguồn ngoài danh mục | `UNSUPPORTED_SOURCE_ERROR_CODE`; aggregate không đổi |

## 2. Bằng chứng snapshot PARTIAL được publish

Case I — 2 hàng bị loại vì ngày trống/ngày sai, 5 hàng hợp lệ:

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| `outcome` | `applied` | PASS |
| `run_status` | `partial` | PASS |
| `sync_runs` | `partial`, `rows_read = 7`, `rows_valid = 5`, `rows_rejected = 2`, `rows_warned = 0` | PASS |
| `sync_errors` | 2 dòng `issue_level = error`: `MISSING_DATE` và `INVALID_DATE` | PASS |
| Aggregate sau lệnh | **đã thay** bằng snapshot partial: 2 dòng, tổng 5; dữ liệu ngày cũ không còn | PASS |
| `last_successful_sync_at` | **không đổi** | PASS |

Case J — 3 hàng có J/L ngoài danh mục, trong đó một hàng sai cả hai:

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| `outcome` / `run_status` | `applied` / `partial` | PASS |
| Response | `rows_warned = 3`, `warning_issues = 4` | PASS |
| `sync_runs` | `partial`, `7/7/0`, `rows_warned = 3`, `warning_issues = 4` | PASS |
| `sync_errors` | 4 dòng `issue_level = warning`; hàng 22 có **2** warning | PASS |
| Breakdown HRP/Vendor | "Không hợp lệ" = 6, Vendor = 1 | PASS |
| Breakdown loại hình | "Không hợp lệ" = 5, Thời vụ = 2 | PASS |
| Aggregate | **đã thay** bằng snapshot partial (3 dòng, tổng 7) | PASS |
| Truy vết | `partial` đọc được từ `sync_runs` mới nhất và `sync_errors` của run đó | PASS |

## 3. Bằng chứng SOURCE_READ_FAILED giữ snapshot cũ

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| `outcome` | `recorded` | PASS |
| `snapshot_unchanged` | `true` | PASS |
| Response | `breakdown_rows_current = 3`, `recruited_count_total = 7` (đúng bằng trạng thái trước lỗi) | PASS |
| `sync_runs` của run lỗi | status `failed` | PASS |
| `sync_errors` | có `SOURCE_READ_FAILED` mức `error` | PASS |
| `daily_recruitment_breakdown` | **giữ nguyên** (so khớp từng dòng với snapshot trước lỗi) | PASS |
| `last_successful_sync_at` | **không đổi** | PASS |
| Source B với `FILE_NOT_NATIVE_SHEET` | cùng hành vi; aggregate B giữ nguyên | PASS |

## 4. Payload sai và error code (case X, Y)

| Fixture | Vi phạm | Error code | TS contract khớp |
|---|---|---|---|
| `x-unsupported-contract-version.json` | `contract_version` bản cũ | `UNSUPPORTED_CONTRACT_VERSION` | PASS |
| `x-unknown-field.json` | field lạ ở payload | `UNKNOWN_FIELD` | PASS |
| `x-unknown-breakdown-field.json` | field lạ trong `breakdown` | `UNKNOWN_FIELD` | PASS |
| `x-pii-in-row-issue.json` | **`candidate_name` trong row_issues (PII)** | `UNKNOWN_FIELD` | PASS |
| `x-invalid-date.json` | `2026-02-30` | `INVALID_DATE` | PASS |
| `x-invalid-value.json` | `recruited_count = -1` | `INVALID_VALUE` | PASS |
| `x-invalid-dimension.json` | `project` là số | `INVALID_DIMENSION` | PASS |
| `x-invalid-uuid-version.json` | `sync_run_id` không phải UUID v4 | `INVALID_SYNC_RUN_ID` | PASS |
| `x-rows-count-mismatch.json` | `rows_valid + rows_rejected ≠ rows_read` | `ROWS_COUNT_MISMATCH` | PASS |
| `x-count-mismatch.json` | tổng breakdown ≠ `rows_valid` | `COUNT_MISMATCH` | PASS |
| `x-warning-count-mismatch.json` | `warning_issues` không khớp `row_issues` | `WARNING_COUNT_MISMATCH` | PASS |
| `x-invalid-warning-counts.json` | `rows_warned > rows_valid` | `INVALID_WARNING_COUNTS` | PASS |
| `x-rejected-count-mismatch.json` | `rows_rejected` không khớp số hàng error | `REJECTED_COUNT_MISMATCH` | PASS |
| `x-mixed-row-issue-level.json` | một hàng vừa error vừa warning | `MIXED_ROW_ISSUE_LEVEL` | PASS |
| `x-issue-linkage-mismatch.json` | nhóm `__invalid__` không có warning tương ứng | `ISSUE_LINKAGE_MISMATCH` | PASS |
| `x-duplicate-grain-key.json` | hai dòng cùng grain (khác hoa/thường, khoảng trắng) | `DUPLICATE_GRAIN_KEY` | PASS |
| `y-unsupported-error-code.json` | `error_code` nguồn ngoài danh mục | `UNSUPPORTED_SOURCE_ERROR_CODE` | PASS |

Với mỗi payload sai: lớp TS contract từ chối **cùng error code**, RPC ghi `sync_runs` `failed` và
`sync_errors`, và sau cả 17 payload thì aggregate của source A **không đổi**. Riêng `x-invalid-uuid-version`
không ghi được run vì `sync_run_id` không hợp lệ — response trả `run_logged = false` (có kiểm tra riêng).

## 5. Kiểm tra không lưu dữ liệu cá nhân ứng viên

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| Tập cột của `daily_recruitment_breakdown` | đúng bằng 15 cột mong đợi | PASS |
| Tên cột bị cấm trên **mọi bảng** | không xuất hiện | PASS |
| `row_issues` | chỉ nhận 3 field; thêm `candidate_name` ⇒ bị từ chối | PASS |

## 6. Truy cập ẩn danh

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| `anon` gọi `replace_daily_recruitment_breakdown_snapshot_v02` | bị từ chối | PASS |
| `anon` gọi `record_recruitment_source_failure_v01` | bị từ chối | PASS |
| `anon` đọc `daily_recruitment_breakdown` | 0 dòng | PASS |
| `anon` ghi `data_sources` | bị từ chối | PASS |

## 7. Build và secret

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint · Typecheck · Build | `pnpm lint` · `pnpm typecheck` · `pnpm build` | PASS |
| Secret trong client bundle và source | `pnpm secrets:check` | PASS — 134 file, 0 vi phạm |

## 8. Sai lệch phát hiện trong quá trình kiểm thử R1

1. **Helper ghi log khi từ chối gọi sai arity.** `reject_daily_recruitment_breakdown_snapshot_v02` gọi
   `upsert_daily_recruitment_run_v01` với 12 tham số trong khi hàm này chỉ có 10; exception bị khối bảo vệ nuốt mất
   nên payload bị từ chối **không** được ghi vào `sync_runs`/`sync_errors`. Phát hiện bởi case X.
   Đã sửa bằng forward migration `20261001140200_p0_r1_fix_rejection_run_log.sql` (gọi `…_v02` đủ 12 tham số).
2. **Hai assertion của harness sai** (số dòng mong đợi của source A sau case G; và `x-invalid-uuid-version`
   không thể ghi run). Đã sửa harness — không có lỗi trong RPC hay schema ngoài mục 1.

## 9. Chưa được kiểm chứng

- Chạy đồng thời hai run cho cùng một source (chưa có lease).
- `RUN_SOURCE_MISMATCH` có logic trong RPC nhưng chưa có ca tự động.
- Dữ liệu Sheet thật (40–50 file).
- Dedup cross-source và retention (chưa có quyết định của Owner).
