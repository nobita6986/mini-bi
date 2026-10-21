# F0 — Deliverable F: Execution Roadmap (`F0-execution-roadmap.md`)

> [!IMPORTANT]
> Lộ trình này chỉ được kích hoạt **sau khi Product Owner xem xét và phê duyệt kết quả khảo sát & hợp đồng F0**. Không một Work Package nào của F1/F1.5 được tự ý bắt đầu trước khi có lệnh `START F1` từ Product Owner.

---

## 1. Sơ đồ Phụ thuộc & Đường Găng (Critical Path)

```mermaid
flowchart TD
    F0["F0 Sign-off (Owner chốt OD-01..OD-08)"] --> F1_WP0["F1-WP0 (T0): Shared TypeScript Contracts & Schema/Metric Validators"]
    F1_WP0 --> F1_WP1["F1-WP1 (T1-A): SQL Foundation, RBAC/ACL, Obligations & Metric Projection RPCs"]
    F1_WP0 --> F1_WP2["F1-WP2 (T1-B): Form Builder UI, Template/Version API & Preview"]
    F1_WP0 --> F1_WP3["F1-WP3 (T1-C): Assignment Management, Staff Tasks UI & Dynamic Form Renderer"]
    F1_WP1 --> F1_WP4["F1-WP4 (T0): F1 Integration, S0-T1-C ACL Gate, PGlite/PG16 Suite & TEST Preflight"]
    F1_WP2 --> F1_WP4
    F1_WP3 --> F1_WP4
    F1_WP4 --> F15_WP1["F1.5-WP1 (T1-A): Scoped SQL Analytics RPCs (Overview, Breakdown, Contributions, Export)"]
    F1_WP4 --> F15_WP2["F1.5-WP2 (T1-B): Leader/BoD Summary Dashboard UI, Filters, Drill-down & XLSX Trigger"]
    F1_WP4 --> F15_WP3["F1.5-WP3 (T1-C): Aggregation Oracle Suite (AG-01..AG-18) & Cross-Scope Security Tests"]
    F15_WP1 --> F15_WP4["F1.5-WP4 (T0): F1.5 Integration, CI Gate & Owner UAT Handover"]
    F15_WP2 --> F15_WP4
    F15_WP3 --> F15_WP4
    F15_WP4 -->|"Owner UAT PASS"| F2["F2: Optional Review Workflow & Delegation"]
    F2 -->|"Owner UAT PASS"| F3["F3: Advanced Multi-Period Analytics & Cross-Source Comparison"]
    F3 --> F4["F4: Reminder Schedules & Deadline Operations"]
    F4 --> F5["F5: Post-Operational Extensions (if approved)"]
```

---

## 2. Phân rã Work Packages & Ma trận Sở hữu File Độc quyền (`F1` & `F1.5`)

Để 3 luồng agent (`T1-A`, `T1-B`, `T1-C`) có thể phát triển song song mà không xảy ra merge conflict hay tự diễn giải nghiệp vụ khác nhau, **T0 khóa trước file contract dùng chung (`F1-WP0`)**, sau đó phân chia quyền sở hữu file độc quyền như sau:

### 2.1. Giai đoạn F1 — Form Builder, Giao Báo cáo, Nộp Báo cáo & Lưu trữ Chuẩn hóa

| Work Package | Phụ trách | Cỡ (Effort) | Phụ thuộc (Prerequisites) | Phạm vi công việc & File sở hữu độc quyền (Exclusive Ownership) |
|---|---|---|---|---|
| **F1-WP0: Shared Contracts & Pure Validators** | **T0** | **S** | Owner duyệt F0 (`OD-01`..`OD-08`) | - Khóa các kiểu dữ liệu dùng chung tại `src/lib/work-reports/contracts.ts`, `src/lib/work-reports/schema-validator.ts`, `src/lib/work-reports/metric-contract.ts`, `src/lib/work-reports/period-utils.ts` + unit tests.<br>- Mở rộng `CAPABILITIES` (`direct-entry-auth/1.5`) tại `src/lib/auth/direct-entry-v2.ts` và predicate điều hướng tại `src/lib/navigation/registry.ts`, `src/lib/navigation/registry-capability.ts`, `src/lib/auth/direct-entry-page-access.ts`. |
| **F1-WP1: Database Foundation, Obligations & Synchronous Metric Projection** | **T1-A** | **L** | `F1-WP0` | - Tạo migration forward-only `supabase/migrations/YYYYMMDDHHMMSS_work_reports_f1_foundation.sql` gồm các bảng: `work_report_templates`, `work_report_template_versions`, `work_report_assignments`, `work_report_obligations`, `work_report_submissions`, `work_report_submission_revisions`, `work_report_metric_values`, `work_report_audit_events`.<br>- Cài đặt các RPC `SECURITY DEFINER` cho Template CRUD/Publish, Assignment CRUD, `work_report_ensure_obligations_for_window`, `work_report_save_draft`, `work_report_submit` (kèm ghi đồng bộ `work_report_metric_values` ngay trong transaction nộp!).<br>- Cập nhật `direct_entry_apply_team_leader_mutation` để đồng bộ quyền báo cáo của Team Leader.<br>- Cập nhật `scripts/s0-t1-c-rpc-acl.test.mjs` và 6 file test P3.1 (`p3-1-w01a..w01d`).<br>- Viết `scripts/work-reports-f1-db.test.mjs`. |
| **F1-WP2: Form Builder, Version Management & Preview UI/API** | **T1-B** | **M** | `F1-WP0` (chạy song song với `F1-WP1` & `F1-WP3` qua repository interface) | - Repository & API quản lý mẫu: `src/lib/work-reports/template-repository.ts`, `src/lib/work-reports/template-api.ts`, `src/app/api/work-reports/templates/**`.<br>- Giao diện Quản lý Mẫu & Form Builder: `src/app/work-reports/templates/**`, `src/components/work-reports/form-builder/**` (thêm/sửa/sắp xếp section & field, bật/tắt `is_metric`, khai báo `metric_key`/`unit`, preview form, clone version, publish/archive).<br>- Tests: `src/lib/work-reports/template-api.test.mjs`, `src/components/work-reports/form-builder/form-builder.test.mjs`. |
| **F1-WP3: Assignment Management, Staff Obligations Inbox & Dynamic Form Renderer** | **T1-C** | **L** | `F1-WP0` (chạy song song với `F1-WP1` & `F1-WP2`) | - Repository & API giao việc / nộp báo cáo: `src/lib/work-reports/assignment-repository.ts`, `src/lib/work-reports/assignment-api.ts`, `src/lib/work-reports/submission-repository.ts`, `src/lib/work-reports/submission-api.ts`, `src/app/api/work-reports/assignments/**`, `src/app/api/work-reports/obligations/**`, `src/app/api/work-reports/submissions/**`.<br>- Giao diện Giao báo cáo (`/work-reports/assignments`), Cần báo cáo & Lịch sử của tôi (`/work-reports`, `/work-reports/my-reports`), và `WorkReportFormRenderer` (`src/components/work-reports/renderer/**` hỗ trợ nhập liệu, autosave/lưu nháp, nộp, sửa bổ sung và xem read-only snapshot).<br>- Tests: `src/lib/work-reports/assignment-api.test.mjs`, `src/lib/work-reports/submission-api.test.mjs`, `src/components/work-reports/renderer/form-renderer.test.mjs`. |
| **F1-WP4: F1 Integration, CI Gate & Owner UAT Checklist** | **T0** | **M** | `F1-WP1`, `F1-WP2`, `F1-WP3` | - Tích hợp 3 nhánh `T1-A/B/C`, đăng ký test vào `package.json` & `scripts/ci-test-manifest.mjs`.<br>- Chạy toàn bộ cổng kiểm tra: `typecheck`, `lint`, `build`, `s0-t1-c-rpc-acl`, `ci-test-manifest`, regression `/direct-entry` (0 chạm Spreadsheet Grid).<br>- Chuẩn bị checklist UAT F1 cho Product Owner. |

---

### 2.2. Giai đoạn F1.5 — Basic Reporting, Scoped SQL Aggregation, Drill-down & Excel Export (Làm ngay sau F1)

| Work Package | Phụ trách | Cỡ (Effort) | Phụ thuộc (Prerequisites) | Phạm vi công việc & File sở hữu độc quyền (Exclusive Ownership) |
|---|---|---|---|---|
| **F1.5-WP1: Scoped SQL Analytics & Reconciliation Engine** | **T1-A** | **M** | `F1-WP4` | - Tạo migration forward-only `supabase/migrations/YYYYMMDDHHMMSS_work_reports_f1_5_analytics.sql` gồm các RPC: `work_report_analytics_overview`, `work_report_analytics_breakdown`, `work_report_analytics_contributions` (drill-down), `work_report_export_data`, `work_report_reconcile_metric_projection`.<br>- Thực thi kiểm tra quyền `report_analytics_view`, `report_view`, `report_export` và lọc cứng theo `effective_scope` (`all` vs `team`).<br>- Mở rộng `scripts/s0-t1-c-rpc-acl.test.mjs`. |
| **F1.5-WP2: Summary Dashboard UI, Drill-down & XLSX Export** | **T1-B** | **M** | `F1-WP4` (chạy song song với `F1.5-WP1`) | - API & Repository tổng hợp: `src/lib/work-reports/analytics-contract.ts`, `src/lib/work-reports/analytics-repository.ts`, `src/lib/work-reports/analytics-api.ts`, `src/lib/work-reports/work-report-export-xlsx.ts`, `src/app/api/work-reports/analytics/**`.<br>- Màn hình **Tổng hợp báo cáo** (`/work-reports/analytics`, `src/components/work-reports/analytics/**`): Bộ lọc (`nuqs`), 4 thẻ Compliance KPI (Phải nộp, Đã nộp, Quá hạn, Nộp muộn, Tỷ lệ hoàn thành), thẻ Metric Summary (`SUM`, `AVG`, `COUNT_VALID`), bảng Breakdown theo Nhóm/Nhân viên/Kỳ, Drawer/Modal Drill-down xem danh sách bài nộp đóng góp và mở xem bài nộp gốc, nút Xuất Excel.<br>- Tests: `src/lib/work-reports/analytics-api.test.mjs`, `src/lib/work-reports/work-report-export-xlsx.test.mjs`, `src/components/work-reports/analytics/analytics-view.test.mjs`. |
| **F1.5-WP3: Aggregation Oracle (`AG-01`..`AG-18`) & Security Regression Suite** | **T1-C** | **M** | `F1.5-WP1` | - Xây dựng bộ fixture độc lập `scripts/lib/work-reports-oracle-fixture.mjs` và hai suite kiểm thử DB bắt buộc:<br>  1. `scripts/work-reports-aggregation-oracle-db.test.mjs` (kiểm chứng toàn bộ `AG-01` → `AG-18`: tỷ lệ hoàn thành, nộp trễ, `0` vs `NULL` vs `MISSING`, tỷ lệ có trọng số `SUM/SUM`, chuyển nhóm giữa 2 kỳ, nộp lại không đếm kép, ranh giới `00:00 HCM`, đối soát tổng KPI = tổng dòng drill-down).<br>  2. `scripts/work-reports-authorization-matrix-db.test.mjs` (kiểm chứng `SEC-WR-01` → `SEC-WR-12`). |
| **F1.5-WP4: F1.5 Release Gate & Owner UAT Sign-off** | **T0** | **S** | `F1.5-WP1`, `F1.5-WP2`, `F1.5-WP3` | - Tích hợp, chạy full CI + benchmark hiệu năng trên fixture 18.250 nghĩa vụ/năm.<br>- Bàn giao checklist UAT F1.5 cho Product Owner. **Dừng chờ Owner xác nhận UAT PASS trên TEST trước khi mở F2.** |

---

### 2.3. Các Giai đoạn Tiếp theo (`F2`, `F3`, `F4`, `F5`)

| Giai đoạn | Work Packages chính | Điều kiện tiên quyết |
|---|---|---|
| **F2: Optional Review Workflow & Delegation** | - **F2-WP1 (T1-A):** Migration RPC duyệt/từ chối (`work_report_decide_review` với chặn tự duyệt `reviewer <> author`), bảng & RPC ủy quyền `work_report_delegations`, tách bạch `is_provisional` vs `is_final`.<br>- **F2-WP2 (T1-B):** Màn hình **Duyệt báo cáo** (`/work-reports/reviews`), hộp thoại phê duyệt/từ chối kèm lý do, giao diện quản lý Ủy quyền có thời hạn.<br>- **F2-WP3 (T1-C):** Cập nhật hiển thị nhãn `Tạm tính (Chờ duyệt)` vs `Chốt (Đã duyệt)` trên Dashboard F1.5 và bộ test `AG-13`, `SEC-WR-09`, `SEC-WR-10`. | F1.5 đã được Product Owner nghiệm thu PASS. |
| **F3: Advanced Analytics & Cross-Period Comparison** | - **F3-WP1 (T1-A):** RPC so sánh liên kỳ (`Period-over-Period`), chỉ số tỷ lệ dẫn xuất (`SUM(num)/SUM(den)`), cảnh báo chất lượng dữ liệu, tùy chọn xem theo cơ cấu nhóm hiện tại vs tại kỳ.<br>- **F3-WP2 (T1-B):** Biểu đồ xu hướng (`TrendChart`), biểu đồ phân bổ theo trường danh mục (`single_select`/`multi_select`), bảng so sánh các Team.<br>- **F3-WP3 (T1-C):** Xuất Excel đa kỳ nâng cao + đối soát cross-source với Direct Entry (nếu Owner yêu cầu). | F2 đã được Product Owner nghiệm thu PASS. |
| **F4: Reminders & Deadline Operations** | - Cấu hình lịch nhắc trước hạn / sắp đến hạn / quá hạn theo `work_report_obligations` (`idempotent reminder log` chống gửi trùng), danh sách nhân sự chưa nộp cho Team Leader hỗ trợ. | F3 hoàn tất. |
| **F5: Post-Operational Extensions** | - Chỉ triển khai từng hạng mục khi có nhu cầu thực tế từ vận hành và được Product Owner duyệt riêng (repeater rows, file đính kèm R2, công thức nâng cao). | Theo quyết định thực tế của Owner. |

---

## 3. Các Rủi ro Thiết kế lại (Redesign Risks) & Cách F0 Đã Khóa Phòng ngừa

| Rủi ro có thể gây phải đập đi xây lại ở F1.5 / F2 / F3 | Nguyên nhân nếu thiết kế sai ở F1 | Cách Hợp đồng F0 đã khóa để triệt tiêu rủi ro |
|---|---|---|
| **Rủi ro 1: F1 chỉ lưu cục `payload_json`, sang F1.5 không thể tính tổng hay lọc nhanh** | Không thiết kế `metric_contract_json` và bảng `work_report_metric_values` ngay từ F1. | F0 bắt buộc `work_report_template_versions` có `metric_contract_json` và `work_report_submit` ở **F1-WP1** phải ghi đồng bộ `work_report_metric_values` ngay trong cùng transaction. Sang F1.5 chỉ việc viết câu `SELECT SUM/AVG` trên bảng đã có sẵn dữ liệu. |
| **Rủi ro 2: Tỷ lệ hoàn thành bị tính sai (luôn = 100%) hoặc biến động lịch sử khi nhân sự đổi Team** | Tính mẫu số bằng `COUNT(submissions)` hoặc `JOIN` trực tiếp vào bảng `recruiter_team_memberships` hiện tại. | F0 khóa bảng `work_report_obligations` có `UNIQUE(template_id, assignee_app_user_id, period_key)` và lưu cứng `snapshot_team_id` tại thời điểm kỳ báo cáo phát sinh. |
| **Rủi ro 3: Sửa báo cáo hoặc nộp lại sau khi bị từ chối làm nhân đôi số liệu KPI** | Lưu mỗi lần nộp lại thành một dòng `submission` mới và cộng tất cả các dòng. | F0 khóa `UNIQUE(obligation_id)` trên `work_report_submissions`, tách lịch sử vào `work_report_submission_revisions`, và dùng cờ `is_current_revision = true` duy nhất trên `work_report_metric_values`. |
| **Rủi ro 4: Đổi tên nhãn hoặc thêm trường ở Version 2 làm hỏng thống kê của Version 1** | Dùng `label` làm key lưu trữ hoặc cho phép sửa đè `schema_json` của version đã publish. | F0 khóa `field_key` và `metric_key` bất biến; `template_version` đã publish bị chặn sửa bằng trigger DB; kiểm tra tương thích đơn vị (`compatible_group`) trước khi cho phép gộp số liệu liên version. |
| **Rủi ro 5: Mở rộng Capability làm gãy 6 bài test CI hiện hữu của P3.1 hoặc hở quyền PostgREST** | Không kiểm tra các test hiện có trong `scripts/` trước khi sửa constraint `direct_entry_capability_grants_capability_check`. | F0 đã chỉ rõ chính xác 6 file test P3.1 (`p3-1-w01a..w01d`) và `scripts/s0-t1-c-rpc-acl.test.mjs` cần được cập nhật đồng bộ trong `F1-WP1`. |
