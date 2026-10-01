# P0-T1-G1 — Bằng chứng kiểm thử contract `daily-recruitment-breakdown/0.2`

| Thuộc tính | Giá trị |
|---|---|
| Task | P0-T1-G1 + **T0 Change Request — P0/P1 Reporting Grain Update** |
| Môi trường | Supabase **DEV**, project ref `kiam…` (không dùng PROD) |
| Contract version | `daily-recruitment-breakdown/0.2` (thay thế `daily-recruitment-count/0.1`) |
| Lệnh | `pnpm db:migrate` rồi `pnpm fixtures:check` |
| Kết quả | **115/115 kiểm tra PASS** |
| Fixture | `docs/contracts/fixtures/daily-recruitment-breakdown/` (16 file) |

Script `scripts/check-daily-recruitment-fixtures.mjs` tự dọn các source `P0FIXTURE_*` trước khi chạy,
nên kết quả tất định và chạy lại được nhiều lần. Script không dùng cho PROD.

> Bằng chứng của contract v0.1 trước đây đã bị thay thế hoàn toàn bởi tài liệu này.

## 1. Kết quả theo case

| Case | Yêu cầu của change request | Thao tác | Kết quả mong đợi | Thực tế |
|---|---|---|---|---|
| A | Breakdown theo dự án / người tuyển / HRP-Vendor / loại hình; kết hợp filter | Snapshot đầu: 2 dự án, 2 người tuyển, HRP + Vendor, Thời vụ + Chính thức, 2 ngày | `applied`, run `succeeded`, 5 dòng grain, tổng 15 | PASS |
| B | Replay cùng snapshot | Replay A bằng run mới | `unchanged`, vẫn 5 dòng, tổng 15, không duplicate, run vẫn được ghi | PASS |
| C | Chỉnh sửa dữ liệu nguồn | Sửa một tổ hợp 3 → 2 | `applied`, đúng 1 dòng đổi, vẫn 5 dòng, tổng 14 | PASS |
| D | Xóa dữ liệu nguồn | Bỏ một tổ hợp khỏi snapshot | `applied`, còn 4 dòng, `breakdown_rows_removed = 1`, tổng 10, tổ hợp bị xóa không còn, tổ hợp khác cùng dự án/loại hình vẫn còn | PASS |
| E | Chuẩn hóa chuỗi | Gửi `"  Dự   án  A "`, `"NGUYỄN   VĂN A"`, `" hrp "`, `"Thời   vụ"` | key đã trim/gộp space/lowercase; display giữ nguyên chữ hoa/thường | PASS |
| F | Gộp nhóm sau chuẩn hóa | Cùng grain, display khác hoa/thường | `applied`, **vẫn 1 dòng** (không sinh grain trùng), display cập nhật | PASS |
| G | Trường phân loại bị trống | `null`, chuỗi chỉ có khoảng trắng, và field vắng mặt | Một nhóm `__unknown__` / `"Không xác định"` cho cả 4 chiều; vẫn tồn tại song song nhóm có giá trị thật | PASS |
| H | Hai source độc lập | Ghi source B, rồi ghi lại source A | Mỗi source giữ aggregate riêng; thao tác trên source này không đổi source kia | PASS |
| J | Payload không hợp lệ | 9 payload sai | `rejected` đúng error code; **snapshot thành công gần nhất không đổi** | PASS |

### Chi tiết case A (breakdown và filter kết hợp)

Dữ liệu nguồn:

| Ngày | Dự án | Người tuyển | HRP/Vendor | Loại hình | Số người |
|---|---|---|---|---|---:|
| 2026-10-01 | Dự án A | Nguyễn Văn A | HRP | Thời vụ | 3 |
| 2026-10-01 | Dự án A | Nguyễn Văn A | HRP | Chính thức | 1 |
| 2026-10-01 | Dự án A | Trần Thị B | Vendor | Thời vụ | 2 |
| 2026-10-01 | Dự án B | Trần Thị B | Vendor | Chính thức | 4 |
| 2026-10-02 | Dự án B | Nguyễn Văn A | HRP | Chính thức | 5 |

Kết quả kiểm chứng tự động:

| Phép tính | Kỳ vọng | Kết quả |
|---|---|---|
| Tổng theo ngày | 2026-10-01 = 10, 2026-10-02 = 5 | PASS |
| Breakdown theo dự án | Dự án A = 6, Dự án B = 9 | PASS |
| Breakdown theo người tuyển | Nguyễn Văn A = 9, Trần Thị B = 6 | PASS |
| Breakdown theo HRP/Vendor | HRP = 9, Vendor = 6 | PASS |
| Breakdown theo loại hình | Thời vụ = 5, Chính thức = 10 | PASS |
| Kết hợp ngày + dự án + HRP + Thời vụ | 3 | PASS |
| Tổng | 15 | PASS |
| `sync_runs` | `succeeded`, `rows_read=15`, `rows_valid=15`, `rows_rejected=0` | PASS |

## 2. Payload sai và error code (case J)

| Fixture | Vi phạm | Error code | Thực tế |
|---|---|---|---|
| `j-unsupported-contract-version.json` | `contract_version` = bản 0.1 | `UNSUPPORTED_CONTRACT_VERSION` | PASS |
| `j-unknown-field.json` | Field lạ ở cấp payload | `UNKNOWN_FIELD` | PASS |
| `j-unknown-breakdown-field.json` | Field lạ trong phần tử `breakdown` | `UNKNOWN_FIELD` | PASS |
| `j-invalid-date.json` | `2026-02-30` | `INVALID_DATE` | PASS |
| `j-invalid-value.json` | `recruited_count = -1` | `INVALID_VALUE` | PASS |
| `j-invalid-dimension.json` | `project` là số | `INVALID_DIMENSION` | PASS |
| `j-rows-count-mismatch.json` | `rows_valid + rows_rejected ≠ rows_read` | `ROWS_COUNT_MISMATCH` | PASS |
| `j-count-mismatch.json` | tổng `breakdown` ≠ `rows_valid` | `COUNT_MISMATCH` | PASS |
| `j-duplicate-grain-key.json` | Hai dòng cùng grain, chỉ khác hoa/thường và khoảng trắng | `DUPLICATE_GRAIN_KEY` | PASS |

Mỗi payload sai còn được kiểm chứng: lớp TS contract từ chối với **cùng error code**, `sync_runs` ghi `failed`,
có dòng `sync_errors` tương ứng, và sau cả 9 payload thì snapshot của source A **không đổi**.

## 3. Kiểm tra không lưu dữ liệu cá nhân ứng viên

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| Tập cột của `daily_recruitment_breakdown` | đúng bằng 15 cột mong đợi, không có cột phát sinh | PASS |
| Tên cột bị cấm (họ tên, ngày sinh, CCCD, địa chỉ, SĐT, email, ghi chú, raw row…) trên **mọi bảng** | không xuất hiện | PASS |

Danh sách cột mong đợi: `source_id`, `business_date`, `project_key`, `project_display`,
`recruiter_key`, `recruiter_display`, `provider_type_key`, `provider_type_display`,
`employment_type_key`, `employment_type_display`, `recruited_count`, `sync_run_id`,
`snapshot_at`, `created_at`, `updated_at`.

## 4. Kiểm tra bảo mật truy cập

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| `anon` gọi `replace_daily_recruitment_breakdown_snapshot_v02` | bị từ chối | PASS |
| `anon` `select` `daily_recruitment_breakdown` | 0 dòng | PASS |
| `anon` `insert` `data_sources` | bị từ chối | PASS |

## 5. Build và secret

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint | `pnpm lint` | PASS |
| Typecheck | `pnpm typecheck` | PASS |
| Build | `pnpm build` | PASS |
| Secret trong client bundle và source | `pnpm secrets:check` | PASS |

## 6. Sai lệch phát hiện trong quá trình kiểm thử

1. **v0.1 — `daily_rows_removed`:** lần chạy đầu của contract cũ trả 2 thay vì 1 khi bỏ một ngày, do xóa toàn bộ
   rồi ghi lại. Đã sửa bằng migration `20261001120200`; ngữ nghĩa này được giữ trong v0.2.
2. **Harness v0.2:** hai assertion đầu tiên sai do (a) so sánh object phụ thuộc thứ tự key và
   (b) kiểm tra "tổ hợp bị xóa" chỉ dựa trên dự án + loại hình thay vì toàn bộ khóa grain.
   Đã sửa harness; không có lỗi trong RPC hay schema.

## 7. Chưa được kiểm chứng

- Chạy đồng thời hai run cho cùng một source (chưa có cơ chế lease).
- `RUN_SOURCE_MATCH`… `RUN_SOURCE_MISMATCH` có logic nhưng chưa có ca tự động.
- Dữ liệu Sheet thật (40–50 file) và cột nguồn thật của từng chiều phân loại — xem contract §14.
- Ánh xạ `on/off` → Thời vụ/Chính thức và nguồn của HRP/Vendor.
