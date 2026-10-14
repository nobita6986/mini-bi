# Pre-W2-HF-D2 — Active duplicate-CCCD reporting semantics

- Base: `origin/main@a056f37` (87 migrations, HF-C `20261013130000_...` là slot cuối).
- Branch: `feature/pre-w2-hf-d2-active-duplicate-cccd-semantics`.
- Status: **awaiting T0 review** (không deploy, không apply migration Production/Vercel, không UAT).

## Yêu cầu Owner đã đóng

- Báo cáo `direct_entry_duplicate_cccd_report` chỉ nhóm CCCD có **>= 2 episode** ở trạng thái authoritative `ON` ("Đang làm việc"); OFF/UNCONFIRMED không làm nhóm đủ điều kiện và không xuất hiện trong projection.
- PM đóng một episode (OFF) -> lần đọc tiếp theo loại nhóm nếu số episode `ON` còn dưới 2.
- Báo cáo giữ nguyên quyền đọc global HF-C, pagination/ceiling, thứ tự ổn định, projection an toàn (che 4 số cuối CCCD, tên, mã NLĐ, dự án, ngày bắt đầu, trạng thái). Không trả CCCD đầy đủ, không trả `project_id`/actor/internal UUID ra client, không thêm CTA sửa hồ sơ, không thêm lịch sử/tuỳ chọn báo cáo lịch sử.

## Preflight (bắt buộc)

- Xác minh ledger trên `origin/main`: **87 migrations**, slot kế tiếp là **#88**; không có DB change nào khác đang chờ T0 chiếm slot #88.
- Predicate trạng thái làm việc chuẩn: `direct_entry_employment_status_events.status = 'ON'` (canonical latest status theo `version desc`, `coalesce(..., 'UNCONFIRMED')`), KHÔNG suy từ `leave_date is null`/`<> 'OFF'`/nhãn UI. Nguồn: `EMPLOYMENT_STATUS_LABELS` (ON = "Đang làm việc", OFF = "Đã nghỉ", UNCONFIRMED = "Không xác định") và migration `20261008170000_p2_5_initial_employment_status_on.sql`.
- Đọc định nghĩa RPC live hiện hành: `direct_entry_duplicate_cccd_report` vẫn là body của #74 (HF-C #87 chỉ thay reader guard), signature/ACL/search_path/projection giữ nguyên.

## Thay đổi

### 1. Migration append-only #88

`supabase/migrations/20261013140000_pre_w2_hf_d2_active_duplicate_cccd_semantics.sql`

- Patch-in-place qua helper `prosrc` tự tạo (bỏ sau khi dùng), expected-count chính xác, abort-on-drift, không re-emit body từ source:
  - `l.latest_status <> 'OFF'` -> `l.latest_status = 'ON'` (count 2: `active_profile_count` + field `active`).
  - `live` CTE thêm filter `coalesce((... latest status ...), 'UNCONFIRMED') = 'ON'` (count 1), nên group count/project count/date range/episodes đều chỉ mô tả episode đang làm việc; `having count(*) >= 2` giờ là `active_count >= 2`.
- Giữ nguyên ACL (`service_role` only), `search_path=pg_catalog, public`, STABLE, SECURITY DEFINER, masked projection, bounded, read-only; không sửa reader guard HF-C (#87).
- Self-check data-free (install trên DB rỗng lẫn Production-shaped): khẳng định predicate ON hiện diện, predicate `<> 'OFF'` biến mất, mask/UUID-boundary/ACL/reader-delegation không drift.

### 2. TS contract

`src/lib/direct-entry/duplicate-cccd-report-contract.ts`

- `active` giờ = `latest_status === "ON"` (trước là `!== "OFF"`). Key projection, allowlist, mask/pagination/authority không đổi.

### 3. Tests

- **Lane mới** `test:pre-w2-hf-d2-active-duplicate-cccd-semantics` (đã đăng ký trong `pnpm test` chain): contract test + `scripts/pre-w2-hf-d2-active-duplicate-cccd-semantics-db.test.mjs`.
- Kịch bản DB (8 test): chỉ episode OFF; 1 active + 1 inactive; 2 active; sau khi PM đóng 1 episode; 3 episode nhưng 2 active (chỉ trả 2 active); pagination/count sau lọc; projection không lộ PII/internal ID; boundary/reader guard không đổi.
- **Mutation probes** `scripts/pre-w2-hf-d2-active-duplicate-cccd-semantics-mutation.mjs` (chạy tay): 3/3 RED, khôi phục byte-for-byte — (1) bỏ predicate active, (2) lộ raw CCCD, (3) lộ `project_id` ra client projection.
- Cập nhật test hiện có cho đúng ngữ nghĩa: `p3-1-hf-duplicate-cccd-report-db` (cặp mask giờ 2 ON), `pre-w2-hf-c-...-db` (seed thêm ON event), contract/api test fixtures -> chỉ ON.
- **Rebaseline migration pins 87 -> 88** trên toàn bộ test suite (48 file): count pins, `names.length - (N)`, `.at(-N)`, `slice(0, -N)`, `BASE_MIGRATION_COUNT`, allowlist `git status` của vendor-lifecycle.

## Gates đã chạy (worktree)

- `pnpm typecheck` — exit 0.
- `pnpm lint` — 0 errors, 13 pre-existing warnings (không thêm warning mới).
- Lane focused: `test:pre-w2-hf-d2-active-duplicate-cccd-semantics` — pass; `p3-1-hf-duplicate-cccd-report` (10/10), `pre-w2-hf-c` (4/4), `pre-w2-p1-worker-export` (6/6), contract+api+repository (18/18), labor-type/vendor-lifecycle/w03a (43/43).
- Mutation checks: 3/3 RED, sources restored byte-for-byte.
- `git diff --check` — exit 0.

## Chưa làm (đúng scope)

- Không apply migration vào Production/Vercel, không deploy VPS/Vercel, không UAT.
- Không đổi menu/tab Dashboard (thuộc D1).
- Không thêm CTA sửa hồ sơ / tự sửa trạng thái; không thêm lịch sử/tuỳ chọn báo cáo lịch sử; không xoá dữ liệu nguồn.

## UAT checklist (Owner thực hiện)

1. Happy path: tạo 2 hồ sơ cùng CCCD đều "Đang làm việc" ở 2 dự án -> báo cáo hiện 1 nhóm, 2 episode, cả hai trạng thái "Đang làm việc", CCCD che 4 số cuối.
2. 1 active + 1 "Đã nghỉ" cùng CCCD -> không hiện trong báo cáo.
3. 2 active, PM chuyển 1 hồ sơ thành "Đã nghỉ" -> tải lại báo cáo -> nhóm biến mất.
4. 3 hồ sơ cùng CCCD (2 active + 1 nghỉ) -> báo cáo chỉ hiện 2 episode active.
5. Phân trang: nhiều nhóm, page/page_size hoạt động; `total_groups`/`total_entries` chỉ đếm nhóm/episode active.
6. Kiểm tra rò rỉ: không thấy CCCD đầy đủ, `project_id`, UUID nội bộ trong response client.
