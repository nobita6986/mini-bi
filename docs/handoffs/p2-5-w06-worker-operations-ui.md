# P2.5-W06 - Worker Operations UI

Status: `P2.5-W06_LOCAL_PASS`. Base `origin/main@32fa36ce72697fe7a799f4c41cd50012205543c4` (W02 #51 · W03 #52 · W04 #53 · W06A #54 · W05 #55 · W05-R1 #56). Branch `feature/p2-5-w06-worker-operations-ui`. No migration/schema/RPC, no Production apply, no deploy, no main merge.

## Delta

- Route `/direct-entry/workers` + nav entry `worker-operations` (cùng flag/actor resolver/access decision như `/direct-entry`). Không sửa W06A ngoài entry nav.
- `worker-operations-model.ts` (thuần): 3 tab không trộn quan hệ — `uploader` (submission API, chỉ tra cứu), `recruited`/`managed` (worker directory `scope=recruited|managed`); `proposeCta` đọc `allowed_actions.propose_change`; copy từ chối sanitized; nhãn pending/last-decision; `BANK_ACCOUNT_SECTION_LABEL`; parse fail-closed.
- `worker-operations.tsx`: tablist ARIA + Arrow/Home/End, filter có label, bảng read-only cuộn ngang (min-w), pending/last-decision chip, CTA **chỉ render khi server `propose_change === true`** (không có CTA disabled/ẩn hover), drawer Radix (focus trap + Escape không mutation) gửi đề xuất WORK_STATUS qua `POST /api/direct-entry/change-requests` bằng builder hiện hữu, 409 → conflict + tải lại.
- Copy nghiệp vụ: `PAYMENT` → "Thông tin tài khoản ngân hàng" (proposer + row); không mô tả thanh toán/chi tiền/giao dịch.
- Không hiển thị UUID thô: dùng `display_name`/`recruiter_display`/`project_display`; `entry_id` chỉ làm React key.

## Acceptance trước → sau

| Trước | Sau |
| --- | --- |
| Chưa có worker operations surface | `/workers` với 3 quan hệ tách biệt, cùng AppShell/nav |
| Bộ chọn/CTA chưa có | CTA đề xuất do server `allowed_actions` quyết định; không suy quyền client |
| Copy "thanh toán" | "Thông tin tài khoản ngân hàng" |
| Nav 3 entry | Nav 4 entry (rebaseline test nav) |

## Gates

`test:p2.5-w06` 21/21 (model 9 + component source 12) · `test:app-nav-02a` 90/90 · `test:server` 204/204 · typegen+typecheck 0 · lint 0 errors (13 pre-existing warnings) · build 0 · `git diff --check` clean. Không chạy lại full canonical DB regression (không chạm backend).

## Blocker

- Reviewer queue UI tái dùng nguyên `direct-entry-change-request-{list,reviewer}` trên `/direct-entry` (authority W05 backend `can_decide`); chưa nhúng vào `/workers` để tránh mở rộng scope.
- Production sequencing #50-#56 vẫn thuộc T0.
