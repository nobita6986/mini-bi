# P0-T1-G1 — Bằng chứng kiểm thử contract `daily-recruitment-count/0.1`

| Thuộc tính | Giá trị |
|---|---|
| Task | P0-T1-G1 |
| Môi trường | Supabase **DEV**, project ref `kiam…` (không dùng PROD) |
| Contract version | `daily-recruitment-count/0.1` |
| Lệnh | `pnpm db:migrate` rồi `pnpm fixtures:check` |
| Kết quả | **83/83 kiểm tra PASS** |
| Fixture | `docs/contracts/fixtures/daily-recruitment-count/` |

Script `scripts/check-daily-recruitment-fixtures.mjs` tự dọn các source có
`drive_file_id` bắt đầu bằng `P0FIXTURE_` trước khi chạy, nên kết quả tất định và
chạy lại được nhiều lần. Script không dùng cho PROD.

## 1. Thứ tự chạy và lý do

Thứ tự thực tế: **A → B → C → D → F → E → G**.

Case F (payload sai) chạy **trước** case E để chứng minh "payload sai không làm thay đổi
snapshot hiện hành" trên một snapshot **không rỗng** (1 dòng), mạnh hơn việc kiểm tra trên
snapshot rỗng.

## 2. Kết quả theo case

| Case | Thao tác | Kết quả mong đợi | Kết quả thực tế | Kết luận |
|---|---|---|---|---|
| A | Snapshot đầu cho source A | `applied`, run `succeeded`, 2 dòng: 2026-10-01=4, 2026-10-02=7, tổng 11, `rows_read=11/rows_valid=11/rows_rejected=0`, `last_successful_sync_at` được đặt | đúng toàn bộ | PASS |
| B | Replay A bằng run mới | `unchanged`, vẫn 2 dòng, tổng 11, `daily_rows_removed=0`, run replay vẫn được ghi | đúng toàn bộ | PASS |
| C | Sửa 2026-10-01: 4 → 3 | `applied`, vẫn **2** dòng (không tạo dòng thứ ba), tổng 10 | đúng toàn bộ | PASS |
| D | Snapshot mới bỏ 2026-10-02 | `applied`, còn 1 dòng 2026-10-01=3, `daily_rows_removed=1` | đúng toàn bộ | PASS |
| F | 7 payload sai (xem §3) | mỗi payload `rejected` đúng error code; snapshot của A **không đổi** (vẫn 2026-10-01=3); `sync_runs` ghi `failed`; có `sync_errors` | đúng toàn bộ | PASS |
| E | Snapshot rỗng hợp lệ | `applied`, 0 dòng, tổng 0, run `succeeded`, source vẫn active và `last_successful_sync_at` được cập nhật | đúng toàn bộ | PASS |
| G | Hai source | Ghi source B không ảnh hưởng A; ghi lại A không ảnh hưởng B | B có 2026-10-03=5; A vẫn rỗng; sau đó A có 2 dòng và B vẫn nguyên 1 dòng | PASS |

Ngoài ra case A xác nhận fixture hợp lệ cũng được **lớp TS contract** chấp nhận, và mỗi
fixture sai được **cả TS contract lẫn RPC** từ chối với **cùng một error code** (đối chiếu
hai lớp validation).

## 3. Payload sai và error code

| Fixture | Vi phạm | Error code mong đợi | Thực tế |
|---|---|---|---|
| `f-unsupported-contract-version.json` | `contract_version = daily-recruitment-count/0.2` | `UNSUPPORTED_CONTRACT_VERSION` | PASS |
| `f-unknown-field.json` | thêm field `source_sheet_id` | `UNKNOWN_FIELD` | PASS |
| `f-invalid-date.json` | `business_date = 2026-02-30` | `INVALID_DATE` | PASS |
| `f-invalid-value.json` | `recruited_count = -1` | `INVALID_VALUE` | PASS |
| `f-rows-count-mismatch.json` | `rows_read=5`, `rows_valid=4`, `rows_rejected=0` | `ROWS_COUNT_MISMATCH` | PASS |
| `f-count-mismatch.json` | tổng daily counts 3 ≠ `rows_valid=4` | `COUNT_MISMATCH` | PASS |
| `f-duplicate-business-date.json` | `2026-10-01` xuất hiện hai lần | `DUPLICATE_BUSINESS_DATE` | PASS |

## 4. Kiểm tra bảo mật truy cập

| Kiểm tra | Kỳ vọng | Thực tế |
|---|---|---|
| `anon` gọi `replace_daily_recruitment_snapshot_v01` | bị từ chối | PASS — lỗi quyền, không trả dữ liệu |
| `anon` `select` `daily_recruitment_counts` | không trả dòng nào | PASS — 0 dòng (RLS không có policy) |
| `anon` `insert` `data_sources` | bị từ chối | PASS |

## 5. Kiểm tra build và secret

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| Lint | `pnpm lint` | PASS (không lỗi) |
| Typecheck | `pnpm typecheck` | PASS (không lỗi) |
| Build | `pnpm build` | PASS — Next.js 16.3.8, route `/` là dynamic |
| Secret trong client bundle và source | `pnpm secrets:check` | PASS — 99 file đã quét, 0 vi phạm |

## 6. Sai lệch đã phát hiện và xử lý trong quá trình kiểm thử

Lần chạy đầu tiên: case D trả về `daily_rows_removed = 2` thay vì `1`. Nguyên nhân: bản
đầu của RPC xóa **toàn bộ** dòng của source rồi ghi lại, nên bộ đếm tính cả những ngày vẫn
còn trong snapshot mới. Đã sửa bằng migration
`20261001120200_p0_snapshot_row_removal_semantics.sql`: chỉ xóa những `business_date`
không còn trong snapshot mới và upsert phần còn lại (giữ `created_at`). Không sửa file
migration đã áp dụng.

## 7. Chưa được kiểm chứng trong bộ fixture này

- Chạy đồng thời hai run cho cùng một source (chưa có cơ chế lease; xem handoff).
- `RUN_SOURCE_MISMATCH` (cần hai source thật và một run_id dùng lại) — logic đã có, chưa có ca tự động.
- Lock/retry ở tầng gọi (PostgREST, n8n).
- Dữ liệu Sheet thật (40–50 file): mọi kiểm thử trên đây dùng fixture tổng hợp.
