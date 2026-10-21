# F0 — Deliverable D: Authorization Matrix (`F0-authorization-matrix.md`)

> [!NOTE]
> - **Initial Survey Baseline (`origin/main`):** `8bf16afe9360e5eebe0dd9183c8ef9d85fc39b0c` (`8bf16afe`)
> - **Delta Review & Effective Baseline (`origin/main` after PR #97 R2.2 Visual Completion):** `bd67c4b88106d6147b1fd043fadc4326366a0e69` (`bd67c4b`). Delta PR #97 không thêm migration và không thay đổi auth capability registry ([`../../src/lib/auth/direct-entry-v2.ts`](../../src/lib/auth/direct-entry-v2.ts#L7-L30)), navigation registry ([`../../src/lib/navigation/registry.ts`](../../src/lib/navigation/registry.ts#L104-L177)), hay DB authorization contract; tổng số migration hiện hữu vẫn là **129**.

## 1. Kiến trúc Phân quyền — Tái sử dụng RBAC Hiện hữu (FACT + RECOMMENDATION)

### 1.1. Tái sử dụng Hạ tầng RBAC `direct-entry-auth` (FACT)

Theo đúng hợp đồng R1 ([`../renewal/R1-authorization-contract.md`](../renewal/R1-authorization-contract.md#L6-L59)) và R2.1 ([`../renewal/R2.1-authorization-contract.md`](../renewal/R2.1-authorization-contract.md#L11-L61)), hệ thống hiện có tại [`../../src/lib/auth/direct-entry-v2.ts`](../../src/lib/auth/direct-entry-v2.ts#L7-L103) và [`../../supabase/migrations/20261020200000_r1_current_state_authorization.sql`](../../supabase/migrations/20261020200000_r1_current_state_authorization.sql#L361-L652) vận hành theo chuỗi quyết định 6 bước:
1. Xác thực phiên Supabase qua `auth.getUser()` trên server.
2. Ánh xạ `auth_subject` sang đúng 01 `direct_entry_app_users` có `enabled = true` (`direct_entry_assert_actor_mapping`).
3. Bác bỏ mọi trường quyền hạn do client gửi (`validateClientBusinessPayload`).
4. Kiểm tra capability hiện hành trong `direct_entry_capability_grants WHERE is_current = true` (`direct_entry_has_capability`).
5. Kiểm tra phạm vi tài nguyên hiện hành trong `direct_entry_scope_grants WHERE is_current = true` (`own`, `team`, `all`) kết hợp `direct_entry_team_leader_assignments WHERE is_current = true`.
6. Thực thi toàn bộ kiểm tra quyền, OCC (`expected_version`), idempotency và ghi audit ngay bên trong hàm `SECURITY DEFINER` của PostgreSQL.

**Bất biến về Legacy DB Tokens (FACT):**
- Trên cả baseline khảo sát ban đầu (`8bf16afe`) và effective baseline sau PR #97 (`bd67c4b`), constraint DB `direct_entry_capability_grants_capability_check` có **23 token**, trong khi hằng số TypeScript `CAPABILITIES` ([`../../src/lib/auth/direct-entry-v2.ts`](../../src/lib/auth/direct-entry-v2.ts#L7-L30)) có **19 active token** (chênh lệch đúng **4 legacy DB token đã ngừng cấp ở tầng ứng dụng**: `pii_view`, `pii_export`, `payment_view`, `payment_edit`, được kiểm chứng tại [`../../scripts/p3-1-w01a-capability-contract.test.mjs`](../../scripts/p3-1-w01a-capability-contract.test.mjs#L29-L39)).
- **Tuyệt đối giữ nguyên trạng thái đã loại bỏ của 4 legacy token này khỏi active TypeScript contract; không khôi phục chúng và không xây dựng policy engine thứ hai.**

### 1.2. Bộ Capability Token theo Phase & Số lượng Token Chính xác cho Từng Nhánh Quyết định (RECOMMENDATION)

Để thỏa mãn đồng thời **Nguyên tắc #3** (*"Admin không mặc nhiên được đọc mọi nội dung báo cáo chỉ vì là Admin"*) và **Nguyên tắc #4** (*"Dashboard, API, drill-down và export phải áp dụng cùng một authorization contract"*), các capability của Work Reports được phân bổ theo đúng phase triển khai (phụ thuộc quyết định `OD-06` và `OD-07`, `Status: OPEN` tại [`./F0-product-contracts-and-open-decisions.md`](./F0-product-contracts-and-open-decisions.md#L220-L234)):

- **`report_submit` tiếp tục là quyền dẫn xuất (Derived Right), KHÔNG phải capability token:** Mọi tài khoản nhân sự đang hoạt động (`u.enabled = true`) được giao nghĩa vụ trong `work_report_obligations` (`assignee_app_user_id = p_app_user_id`) mặc nhiên có quyền xem nghĩa vụ, lưu nháp, nộp/nộp lại báo cáo và xem lịch sử bài nộp cá nhân của chính mình (`own`).
- **F1 / F1.5 Core chỉ thêm 4 capability token:**
  1. `report_form_manage`
  2. `report_assign`
  3. `report_view`
  4. `report_analytics_view`
- **`report_export` phụ thuộc kết quả `OD-06` (`Status: OPEN`):**
  - Chỉ thêm `report_export` ở **F1.5** nếu Product Owner chọn **`OD-06 = PA1`** (đưa XLSX cơ bản vào F1.5).
  - Nếu Product Owner chọn **`OD-06 = PA2`** (Master Plan baseline: XLSX ở F3), thì `report_export` chỉ được thêm ở **F3**.
- **`report_review` và `report_delegate` chỉ thêm khi triển khai F2:**
  - Tuyệt đối không thêm trước ở F1 để tránh tồn tại capability chưa có luồng thực thi.

#### Bảng Số lượng Token DB CHECK vs Active TypeScript `CAPABILITIES` theo Phase và Nhánh `OD-06`

| Giai đoạn (Phase) | Nhánh quyết định `OD-06` (`Status: OPEN`) | Các token `report_*` được thêm mới ở phase này | Tổng số token trong DB CHECK `direct_entry_capability_grants_capability_check` (gồm 4 retired legacy DB tokens) | Tổng số active token trong TypeScript `CAPABILITIES` ([`../../src/lib/auth/direct-entry-v2.ts`](../../src/lib/auth/direct-entry-v2.ts#L7-L30)) |
|---|---|---|---|---|
| **Baseline hiện tại (`origin/main` `bd67c4b`)** | — | *(Chưa thêm)* | **23** (`19 active + 4 retired legacy`) | **19** |
| **F1 / F1.5** | **Nhánh `OD-06 = PA2` (Master Plan baseline — XLSX ở F3)** | **+4 token:** `report_form_manage`, `report_assign`, `report_view`, `report_analytics_view` | **27** (`23 + 4`) | **23** (`19 + 4`) |
| **F1 / F1.5** | **Nhánh `OD-06 = PA1` (Đưa XLSX cơ bản vào F1.5)** | **+5 token:** `report_form_manage`, `report_assign`, `report_view`, `report_analytics_view`, `report_export` | **28** (`23 + 5`) | **24** (`19 + 5`) |
| **F2 (Review & Delegation)** | **Nhánh `OD-06 = PA2`** | **+2 token:** `report_review`, `report_delegate` | **29** (`27 + 2`) | **25** (`23 + 2`) |
| **F2 (Review & Delegation)** | **Nhánh `OD-06 = PA1`** | **+2 token:** `report_review`, `report_delegate` | **30** (`28 + 2`) | **26** (`24 + 2`) |
| **F3 (Advanced Analytics & XLSX)** | **Nhánh `OD-06 = PA2`** | **+1 token:** `report_export` | **30** (`29 + 1`) | **26** (`25 + 1`) |
| **F3 (Advanced Analytics & XLSX)** | **Nhánh `OD-06 = PA1`** | *(0 token mới — `report_export` đã có từ F1.5)* | **30** | **26** |

#### Đặc tả Chi tiết Từng Quyền / Capability

| Capability / Quyền | Phase bổ sung | Ý nghĩa nghiệp vụ | Scope hợp lệ (`scope_kind`) | Ai được cấp mặc định? |
|---|---|---|---|---|
| *(Derived — không phải token)* `report_submit` | **F1** | Xem nghĩa vụ được giao cho chính mình, lưu nháp, nộp/nộp lại báo cáo và xem lịch sử bài nộp cá nhân | `own` (`assignee_app_user_id = p_app_user_id`) | Mọi tài khoản nhân sự đang hoạt động (`u.enabled = true`) có nghĩa vụ được giao trong `work_report_obligations`. |
| `report_form_manage` | **F1** | Tạo mẫu báo cáo, chỉnh sửa bản nháp, preview, publish version mới, archive mẫu | `all` | Quản trị viên biểu mẫu (Form Admin / Catalog Operator được cấp quyền). **Không cấp quyền đọc bài nộp hay xem dashboard.** |
| `report_assign` | **F1** | Giao mẫu báo cáo đã publish cho Cá nhân (`USER`), Nhóm (`TEAM`) hoặc Tập người dùng (`USER_SET` qua `work_report_assignment_targets`), tạm dừng/thu hồi assignment, miễn nghĩa vụ (`EXEMPT`) có lý do | `all` (giao toàn công ty) hoặc `team` (Team Leader giao cho nhóm mình — phụ thuộc `OD-03`) | Admin điều phối báo cáo (`@ all`) và Team Leader (`@ team`, phụ thuộc `OD-03` & `OD-04`). |
| `report_view` | **F1** | Đọc nội dung chi tiết bài nộp (`work_report_submissions` & `revisions`) và danh sách drill-down nguồn trong phạm vi được cấp | `team` hoặc `all` (riêng `own` luôn cho phép tác giả đọc bài của chính mình) | Team Leader (`@ team`), BoD (`@ all`), hoặc người được cấp quyền đọc báo cáo. **Admin chỉ có `report_form_manage` sẽ KHÔNG có `report_view`.** |
| `report_analytics_view` | **F1 / F1.5** | Xem màn hình Tổng hợp báo cáo (F1.5/F3): KPI tuân thủ, tổng/trung bình chỉ tiêu, bảng breakdown | `team` hoặc `all` | Team Leader (`@ team`), BoD (`@ all`). |
| `report_export` | **F1.5** *(nếu `OD-06 = PA1`)* hoặc **F3** *(nếu `OD-06 = PA2`)* | Xuất file Excel (`.xlsx`) tổng hợp và chi tiết trong đúng phạm vi `effective_scope` (đòi hỏi đồng thời có `report_analytics_view` + `report_view` ở cùng scope) | `team` hoặc `all` | Team Leader (`@ team`, phụ thuộc `OD-04`), BoD (`@ all`) hoặc người được cấp quyền xuất dữ liệu. |
| `report_review` | **F2** | Duyệt (`APPROVE`) hoặc Từ chối (`REJECT`) các bài nộp thuộc mẫu có `requires_review = true` (kèm chặn tự duyệt `submitted_by_user_id <> p_app_user_id`) | `team` hoặc `all` | Team Leader (`@ team`), BoD / Reviewer cấp công ty (`@ all`). |
| `report_delegate` | **F2** | Tạo/thu hồi ủy quyền có thời hạn (`report_assign` hoặc `report_review`) cho người khác trong phạm vi con của quyền gốc | `team` hoặc `all` | Team Leader (`@ team`), BoD / Admin điều phối (`@ all`). |

---

## 2. Ma trận Phân quyền Chi tiết (`Actor × Action × Resource Scope × Expected Result`)

| Actor | Action | Resource Scope yêu cầu | Expected Result | Cách Enforce ở Server / Database (`SECURITY DEFINER` RPC) |
|---|---|---|---|---|
| **Staff (Nhân viên)** | Xem danh sách nghĩa vụ cần nộp & lịch sử cá nhân | `own` (`obligation.assignee_app_user_id = p_app_user_id`) | **ALLOW** (chỉ thấy nghĩa vụ & bài nộp của chính mình) | `direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id)` + `WHERE o.assignee_app_user_id = p_app_user_id` |
| **Staff (Nhân viên)** | Lưu nháp / Nộp báo cáo (`work_report_submit`) | `own` (`obligation.assignee_app_user_id = p_app_user_id` AND `obligation_status = 'ACTIVE'`) | **ALLOW** (chuyển `COMPLETED` nếu `requires_review=false`, hoặc `PENDING_REVIEW` nếu `requires_review=true`) | Kiểm tra `o.assignee_app_user_id = p_app_user_id`, validate payload theo `template_version.schema_json`, kiểm tra OCC `expected_version` và `direct_entry_rpc_idempotency`. |
| **Staff (Nhân viên)** | Xem bài nộp của đồng nghiệp cùng Team hoặc xem Dashboard tổng hợp F1.5 | `team` / `all` | **DENY (`403 WORK_REPORT_ACCESS_DENIED`)** | Không có `report_view` / `report_analytics_view` ở scope `team`/`all`; SQL raise `sqlstate '42501'`. |
| **Team Leader (`report_assign @ team`, nếu `OD-03 = PA1`)** | Giao báo cáo theo `TEAM`, `USER`, hoặc `USER_SET` (`work_report_assignment_targets`) | `team` (mọi mục tiêu phải thuộc `v_authorized_team_ids` hiện hành của Leader) | **ALLOW** nếu 100% đối tượng thuộc nhóm của Leader; **DENY (`403 WORK_REPORT_SCOPE_DENIED`)** nếu có bất kỳ `target_team_id` hoặc `target_user_id` nào (trong `work_report_assignments` hoặc `work_report_assignment_targets`) nằm ngoài nhóm của Leader | Với `target_kind = 'USER_SET'`, RPC kiểm tra mọi `target_user_id` được chèn vào `public.work_report_assignment_targets` đều có membership hiện hành (`recruiter_team_memberships.is_current = true` qua `direct_entry_app_user_recruiter_links`) thuộc `v_authorized_team_ids`; nếu thiếu dù chỉ 1 người thì rollback và raise `42501`. |
| **Team Leader** | Xem Dashboard tổng hợp F1.5 (`overview`, `metrics`, `breakdown`) | `team` (các nhóm mà Leader đang có `scope_kind='team' AND is_current` VÀ `direct_entry_team_leader_assignments.is_current`) | **ALLOW** (chỉ tổng hợp trên các nghĩa vụ/bài nộp thuộc `team_ids` được quản lý) | Hàm SQL `work_report_resolve_analytics_scope` kiểm tra `report_analytics_view` + trả về mảng `v_authorized_team_ids`; mọi câu `SELECT` đều lọc `WHERE snapshot_team_id = ANY(v_authorized_team_ids)`. |
| **Team Leader** | Drill-down (`contributions`) & Mở đọc bài nộp gốc (`submissions/:id`) | `team` (`submission/obligation` thuộc `v_authorized_team_ids`) | **ALLOW** | Kiểm tra đồng thời `report_analytics_view` + `report_view` và `o.snapshot_team_id = ANY(v_authorized_team_ids)` (hoặc `current_team_id` nếu ở chế độ current org ở F3). |
| **Team Leader (Team A)** | Giả mạo query `?team_id=<Team_B>` trên Dashboard, Drill-down, Assignment `USER_SET` hoặc Export | Ngoài scope (`Team B` không thuộc `v_authorized_team_ids`) | **DENY (`403 WORK_REPORT_SCOPE_DENIED`)** | RPC đối chiếu `p_filter_team_id` / `target_user_id` với `v_authorized_team_ids`; nếu không thuộc tập được phép thì raise `42501` ngay lập tức (không trả mảng rỗng giả). |
| **Team Leader (F2)** | Tự duyệt bài nộp của chính mình (khi Leader cũng được giao nộp báo cáo ở mẫu `requires_review=true`) | `own` (`s.assignee_app_user_id = p_app_user_id`) | **DENY (`403 WORK_REPORT_SELF_REVIEW_FORBIDDEN`)** | Trong RPC `work_report_decide_review` (F2): `IF v_submission.assignee_app_user_id = p_app_user_id OR v_submission.submitted_by_user_id = p_app_user_id THEN RAISE EXCEPTION 'self review forbidden' USING ERRCODE = '42501'; END IF;` |
| **BoD (Ban Giám đốc)** | Xem Dashboard tổng hợp F1.5/F3, Drill-down nhóm/nhân viên, Đọc bài nộp nguồn toàn công ty | `all` (`scope_kind = 'all' AND is_current`) + `report_analytics_view` + `report_view` | **ALLOW** (toàn công ty hoặc lọc theo bất kỳ nhóm/nhân viên nào) | `direct_entry_has_scope(p_app_user_id, 'all')` AND `direct_entry_has_capability(p_app_user_id, 'report_analytics_view')` (và `report_view` khi mở bài nộp chi tiết / contributions). |
| **BoD / Team Leader** | Xuất Excel (`.xlsx`) tổng hợp và chi tiết *(ở **F1.5** nếu `OD-06 = PA1`, hoặc ở **F3** nếu `OD-06 = PA2`)* | `all` hoặc `team` (khớp đúng scope đang xem) | **ALLOW** nếu có đủ `report_export` + `report_analytics_view` + `report_view`; **DENY (`403`)** nếu thiếu `report_export` | RPC `work_report_export_data` kiểm tra cả 3 capability ở cùng `effective_scope`, áp dụng giới hạn `10,000` dòng và ghi bắt buộc vào `work_report_audit_events`. |
| **Form Admin (Quản trị biểu mẫu)** | Tạo, sửa nháp, publish, archive mẫu báo cáo (`work_report_templates` / `versions`) | `all` + `report_form_manage` | **ALLOW** | Kiểm tra `direct_entry_has_capability(p_app_user_id, 'report_form_manage')` VÀ `direct_entry_has_scope(p_app_user_id, 'all')`. |
| **Form Admin / Full Admin (KHÔNG có `report_view` / `report_analytics_view`)** | Mở xem nội dung báo cáo của nhân viên, gọi API tổng hợp F1.5, hoặc xuất Excel | `all` nhưng **thiếu** `report_view` / `report_analytics_view` | **DENY (`403 WORK_REPORT_ACCESS_DENIED`)** | Thực thi **Nguyên tắc #3**: RPC đọc báo cáo và tổng hợp F1.5 kiểm tra tường minh `report_view` / `report_analytics_view`, **không** chấp nhận `entry_admin`, `catalog_master_manage` hay `report_form_manage` làm quyền đọc nội dung báo cáo. |
| **Người được ủy quyền (Delegated Actor — F2)** | Giao báo cáo (`report_assign`) hoặc Duyệt báo cáo (`report_review`) trong thời hạn ủy quyền | Scope con của người ủy quyền (`delegation.is_current = true` AND `grantor` vẫn còn quyền gốc hiện hành) | **ALLOW** trong phạm vi ủy quyền; **DENY** ngay khi thu hồi hoặc khi `grantor` mất quyền gốc | Hàm SQL `work_report_has_delegated_authority` kiểm tra đồng thời: (1) dòng `work_report_delegations` có `is_current = true AND revoked_at IS NULL`, VÀ (2) `grantor_user_id` vẫn đang thỏa mãn quyền gốc hiện hành trên cùng team/scope. |
| **Actor có nhiều vai trò (VD: Team Leader Team A + đồng thời là người phải nộp báo cáo lên BoD)** | Nộp báo cáo của chính mình (`own`) VÀ xem tổng hợp/duyệt báo cáo của nhân viên Team A (`team`) | `own` + `team` | **ALLOW** cả 2 luồng đúng ngữ cảnh; **DENY** tự duyệt bài của chính mình | Quyền `own` và `team` được tách bạch theo từng route/action; quy tắc chống tự duyệt (`assignee_app_user_id <> p_app_user_id`) luôn thắng mọi grant chồng lấp. |
| **Disabled / Unmapped Actor** | Mọi thao tác đọc/ghi/export dù còn giữ cookie phiên cũ | Bất kỳ | **DENY (`403 ACTOR_NOT_AVAILABLE`)** | `direct_entry_assert_actor_mapping` kiểm tra `u.enabled = true`; trigger `direct_entry_clear_authority_on_disable` tự động hạ `is_current = false`. |

---

## 3. Quyền Hiện hành so với Lịch sử khi Đổi Nhóm / Thu hồi Quyền (RECOMMENDATION)

Áp dụng nhất quán triết lý của **R1** ([`../renewal/R1-authorization-contract.md`](../renewal/R1-authorization-contract.md#L54-L58)) và **R2.1** ([`../renewal/R2.1-authorization-contract.md`](../renewal/R2.1-authorization-contract.md#L46-L61)):

1. **Quyền cá nhân của người nộp (`AUTHOR_HISTORY` / `OWN`):**
   - Nhân viên A nộp báo cáo ở Kỳ 10 khi đang thuộc Team Alpha. Sang Kỳ 11, nhân viên A chuyển sang Team Beta.
   - Nhân viên A (khi tài khoản còn `enabled = true`) **luôn được xem lại các bài nộp lịch sử của chính mình (`assignee_app_user_id = A`)** ở chế độ chỉ đọc (`read-only snapshot`), nhưng **không được xem tổng hợp hay bài nộp của các thành viên khác trong Team Alpha**.
2. **Quyền của Team Leader khi nhân viên chuyển nhóm:**
   - Nghĩa vụ và bài nộp của nhân viên A ở Kỳ 10 mang `snapshot_team_id = Team Alpha`.
   - **Team Leader của Team Alpha** (người đang có quyền hiện hành quản lý Team Alpha) khi xem Dashboard lịch sử Kỳ 10 theo chế độ mặc định (*Cơ cấu tổ chức tại kỳ*) **vẫn thấy đầy đủ nghĩa vụ và bài nộp Kỳ 10 của nhân viên A trong tổng số của Team Alpha**, giúp số liệu lịch sử của Team Alpha không bao giờ bị biến động.
   - **Team Leader của Team Beta** (nhóm mới của nhân viên A từ Kỳ 11) xem số liệu của nhân viên A từ Kỳ 11 trở đi (các nghĩa vụ có `snapshot_team_id = Team Beta`); **không** tự động đọc ngược các bài nộp cũ của nhân viên A ở Team Alpha.
3. **Quyền của Team Leader / Reviewer sau khi bị bãi nhiệm hoặc đổi nhóm (`DECIDER_HISTORY` — F2):**
   - Khi Team Leader X không còn quản lý Team Alpha, X **mất ngay lập tức** quyền xem Dashboard tổng hợp và danh sách bài nộp của Team Alpha.
   - Ở F2 (nếu bật workflow duyệt), X chỉ giữ quyền tra cứu chỉ-đọc các quyết định duyệt mà chính X đã trực tiếp ký (`reviewed_by_user_id = X`) trong tab *"Lịch sử tôi đã duyệt"*, tương tự `REVIEWER_RESOLVED` của R2.1.

---

## 4. 12 Kịch bản Kiểm thử Bảo mật Phủ định Bắt buộc (`SEC-WR-01` → `SEC-WR-12`)

Mỗi kịch bản dưới đây phải được tự động hóa bằng bài test PGlite + PostgreSQL (`scripts/work-reports-authorization-matrix-db.test.mjs`) tại đúng phase tương ứng:

1. **`SEC-WR-01` (Cross-User Read — F1):** Staff A gọi `GET /api/work-reports/submissions/<id_của_Staff_B>` → `403 WORK_REPORT_ACCESS_DENIED`.
2. **`SEC-WR-02` (Cross-Team Filter & `USER_SET` Target Spoofing — F1/F1.5):**
   - Team Leader Team A gọi `/api/work-reports/analytics/overview?template_id=...&team_id=<Team_B>` → `403 WORK_REPORT_SCOPE_DENIED`.
   - Team Leader Team A (`report_assign @ team` nếu `OD-03 = PA1`) tạo assignment `USER_SET` trong đó `work_report_assignment_targets` chứa 1 thành viên Team A và 1 thành viên Team B → toàn bộ giao dịch bị từ chối với `403 WORK_REPORT_SCOPE_DENIED` (`SQLSTATE 42501`), không có dòng nào được chèn vào `work_report_assignments` hay `work_report_assignment_targets`.
3. **`SEC-WR-03` (Admin Without `report_view` — F1/F1.5):** Tài khoản Full Admin hoặc Form Admin (`report_form_manage @ all`, `entry_admin @ all`) nhưng không được cấp `report_view` / `report_analytics_view` gọi API xem bài nộp hoặc dashboard F1.5 → `403 WORK_REPORT_ACCESS_DENIED`.
4. **`SEC-WR-04` (Analytics View Without `report_export` — Phase phụ thuộc `OD-06`: F1.5 nếu `OD-06 = PA1`, hoặc F3 nếu `OD-06 = PA2`):** Tài khoản có `report_analytics_view @ team` và `report_view @ team` nhưng không có `report_export` gọi `POST /api/work-reports/analytics/export` → `403 WORK_REPORT_EXPORT_DENIED`.
5. **`SEC-WR-05` (Client Authority Payload Injection — F1):** Client gửi kèm `app_user_id`, `auth_subject`, `capability`, `scope_kind` trong body nộp báo cáo hoặc tạo mẫu → `400 CLIENT_AUTHORITY_FIELD_FORBIDDEN`.
6. **`SEC-WR-06` (Disabled Actor Stale Session — F1):** Tài khoản vừa bị chuyển `enabled = false` dùng session cookie còn hạn gọi bất kỳ API Work Reports nào → `403 ACTOR_NOT_AVAILABLE`.
7. **`SEC-WR-07` (Revoked Team Leader Immediate Denial — F1.5):** Ngay sau khi `direct_entry_revoke_team_leader` chạy cho Leader A trên Team A, Leader A gọi lại API tổng hợp Team A → `403 WORK_REPORT_ACCESS_DENIED`.
8. **`SEC-WR-08` (Drill-Down Scope Isolation — F1.5):** Trên mẫu báo cáo giao cho cả Team A và Team B, Team Leader Team A gọi `/api/work-reports/analytics/contributions` không truyền `team_id` → kết quả chỉ trả về các dòng thuộc Team A, tuyệt đối không rò rỉ dòng nào của Team B.
9. **`SEC-WR-09` (Self-Approval Block — F2):** Team Leader A vừa là người nộp báo cáo vừa có `report_review @ team` (hoặc `@ all`) gọi RPC duyệt bài nộp của chính mình → `403 WORK_REPORT_SELF_REVIEW_FORBIDDEN`.
10. **`SEC-WR-10` (Expired / Revoked Delegation — F2):** Người nhận ủy quyền gọi RPC duyệt sau khi ủy quyền đã bị thu hồi hoặc người ủy quyền gốc (`grantor`) đã bị bãi nhiệm Team Leader → `403 WORK_REPORT_ACCESS_DENIED`.
11. **`SEC-WR-11` (Immutable Published Schema Mutation — F1):** Form Admin gọi SQL/API sửa `schema_json` hoặc `metric_contract_json` trực tiếp trên một `template_version` đã `PUBLISHED` → DB trigger chặn cứng (`SQLSTATE 55000`).
12. **`SEC-WR-12` (Direct PostgREST RPC & Table Access by `anon`/`authenticated` — F1):** Gọi trực tiếp bất kỳ hàm hoặc bảng `public.work_report_*` nào bằng role `anon` hoặc `authenticated` → `42501 permission denied` (chỉ `service_role` qua server repository mới có quyền `EXECUTE` trên các RPC `work_report_*` nằm trong allowlist).
