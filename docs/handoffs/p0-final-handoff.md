# Handoff — P0 → P1 (Final)

| Thuộc tính | Giá trị |
|---|---|
| Trạng thái | P0 **PASS**; bàn giao đầu vào P1 |
| Contract | `daily-recruitment-breakdown/0.2` (R1) |
| Workflow | P0-T2-WF01 (ID `rnjvFA81uOBrVRQJ`), draft/manual |
| Web commit | xem commit cuối P0-FINAL |
| Vercel | project `mini-bi` (team `thuans-projects-0b7f4d74`) — xem report mục V |

## 1. Đã bàn giao

- Code web + migration + RPC + contract + fixture + runbook + acceptance evidence (repo `main`).
- `/pipeline-check` hiển thị dữ liệu thật (DEV; production bị khoá mặc định).
- Workflow n8n quản lý trực tiếp trong n8n; repo chỉ lưu runbook + metadata.

## 2. Known limitations — KHÔNG được coi là đã hoàn thành

1. **DEV vẫn còn hai fixture source `P0FIXTURE_*` tổng 14 người** — không được dùng tổng toàn DB làm số BoD thật.
2. **Hai source thật hiện tổng 2 người** (chưa phải toàn bộ folder 40–50 file).
3. **Không tự xoá fixture hoặc dữ liệu DEV trong task này.**
4. **`/pipeline-check` production bị khoá mặc định** (`PIPELINE_CHECK_ENABLED` ≠ `true`).
5. **Chưa có P1-W03 access gate** — chưa an toàn để mở dữ liệu thật ra Internet.
6. **Chưa có schedule 6 giờ hoặc bot `/sync`.**
7. **Chưa có run-start lease** — phải xử lý trước khi bật chạy đồng thời/schedule.
8. **Chưa kiểm thử restart/import workflow trên instance mới.**
9. **Không có workflow JSON trong Git** (quyết định của Owner).

## 3. Đầu vào cho P1

- Grain đã chốt: `source + business_date + project + recruiter + provider_type + employment_type = recruited_count`.
- Reporting read-model (`src/lib/reporting/pipeline-check.ts`) có thể tái sử dụng cho query/aggregate.
- Các mục rebaseline P1 xem `docs/P1.md` (đã cập nhật).

