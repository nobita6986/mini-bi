# MINI BI — WORK REPORTS, FORM BUILDER & REPORTING ANALYTICS
## Master Plan v1.0 — F1 → F1.5 → F2 (phase cuối theo quyết định Owner)

**Ngày lập:** 21/10/2026  
**Repository:** https://github.com/nobita6986/mini-bi  
**Source baseline khảo sát:** `8bf16afe9360e5eebe0dd9183c8ef9d85fc39b0c` (sau PR #96). Khi khởi động coding, T0 phải xác nhận lại `origin/main`, vì R2.2 Visual Completion có thể đang tiếp tục.  
**Đích tài liệu trong repository (đề xuất):** `docs/work-reports/master-plan.md` (KHÔNG ghi đè master plan Mini BI hiện hữu).  
**Trạng thái tài liệu:** Master plan định hướng + hợp đồng nghiệm thu; không dùng tài liệu này làm bằng chứng runtime/DB. F1 và F1.5 đã được Owner nghiệm thu; F2 chưa hoàn tất.

**Quyết định phạm vi hiện tại của Owner (21/10/2026):** F1.5 đã UAT PASS; F2 là phase cuối. Không triển khai F3, F4 hoặc F5 trong phạm vi Work Reports hiện tại. Các mô tả các phase đó dưới đây chỉ còn là tham chiếu lịch sử, không phải backlog.

---

## 0. Executive Decision — Những điều đã chốt và những điều đề xuất

### 0.1. Đã thống nhất từ các cuộc trao đổi

1. Xây module **Báo cáo công việc (Work Reports)** tích hợp Mini BI; có **Form Builder**, giao mẫu, nhân viên nộp báo cáo, tổng hợp và phân tích cho cấp quản lý.
2. Mỗi **mẫu báo cáo** được chọn **có duyệt / không duyệt**; **mặc định KHÔNG DUYỆT**. Người được giao nộp báo cáo hợp lệ là hoàn tất nghĩa vụ nếu mẫu không yêu cầu duyệt.
3. Lộ trình hiện hành: **F1** Form Builder + Assignment + Submission; **F1.5** tổng hợp; **F2** Review & Delegation và là phase cuối theo quyết định Owner. F3–F5 nằm ngoài phạm vi hiện tại.
4. Bổ sung **F1.5 Basic Reporting** ngay sau F1: tổng hợp số đã/chưa nộp, chỉ tiêu định lượng theo nhân viên/team/kỳ, xem chi tiết nguồn báo cáo. Không được chỉ xây công cụ thu thập rồi để công đoạn tổng hợp bằng tay.
5. Dùng **RBAC theo actor + capability + effective scope**, không suy quyền từ tên vai trò; **Full Admin và BoD (`lienvu`, `ngattt`) có đầy đủ quyền Work Reports** theo capability/scope đã cấp.
6. **Owner trực tiếp UAT và quyết định PASS/FAIL.** T0/T1/T0-VPS chỉ code, kiểm thử tự động, chuẩn bị TEST và checklist.
7. Không động vào **Spreadsheet Grid/Form Core** đã khóa của `/direct-entry`; module mới sử dụng UI riêng, không dùng visual redesign làm thay đổi bảng nhập liệu.
8. Không chạm hoặc deploy Production nếu chưa được Owner phê duyệt riêng.

### 0.2. Đề xuất mặc định của master plan — Owner có thể điều chỉnh trước F0/P0

- V1 hỗ trợ báo cáo theo **ngày/tuần/tháng**, báo cáo một lần (ad hoc); quý/năm ở tầng *truy vấn tổng hợp* ngay từ F1.5 và cân nhắc chu kỳ nộp trực tiếp trong F3/F5.
- Một nghĩa vụ báo cáo chuẩn là **một người × một mẫu/version được giao × một kỳ báo cáo**; các ngoại lệ nhóm/miễn nộp/ủy quyền được mô hình hóa tường minh.
- F1 ưu tiên các trường **text, textarea, integer, decimal, date, boolean, single/multiple choice**, grouping/section và validation cơ bản; không tự xây biểu thức tùy ý, workflow nhiều tầng, nested repeaters hay upload file phức tạp ở F1.
- Chuỗi trạng thái: `DRAFT`, `SUBMITTED`/`COMPLETED`, và (sang F2) `PENDING_REVIEW`, `APPROVED`, `REJECTED`; biểu hiện `OVERDUE/MISSING` được tính từ **nghĩa vụ + hạn nộp**, không đánh đồng với một submission đã tồn tại.
- Phiên bản đã publish là bất biến; cấu hình báo cáo/aggregation của mẫu cũng được version hóa.
- Ở F1.5 phải có **KPI tổng hợp thực**, không chỉ danh sách bài nộp và đếm số dòng.

> **Không tự coi các mặc định tại §0.2 đã được Owner chốt vĩnh viễn.** T0 đưa những điểm ảnh hưởng nghiệp vụ vào decision log F0 để Owner duyệt trước migration đầu tiên.

---

## 1. Mục tiêu và định nghĩa ranh giới

### 1.1. Mục tiêu

Biến các báo cáo công việc rải rác trong Google Sheets, tin nhắn hoặc biểu mẫu tùy biến thành **một quy trình dữ liệu có cấu trúc**:

`Tạo mẫu → Publish version → Giao nghĩa vụ → Nhân viên nhập/nộp → Tùy mẫu: tự hoàn tất hoặc chờ duyệt → Chuẩn hóa chỉ tiêu → Tổng hợp theo scope & thời gian → Drill-down → Excel / nhắc việc`.

Công cụ quản lý phải trả lời nhanh **ai phải nộp, ai đã nộp, số liệu cộng dồn là bao nhiêu, nguồn số liệu ở đâu và có bất thường gì**, mà không buộc Team Leader/BoD mở từng form.

### 1.2. Không nhầm với module sẵn có

- **Dashboard tuyển dụng** hiện tại: các báo cáo theo dữ liệu `direct_entries` và những RPC reporting hiện hành.
- **Work Reports** mới: dữ liệu do người dùng **khai báo qua Form Builder**, có template/version/assignment/period/metric riêng.
- Có thể liên kết hoặc so sánh *sau này*, nhưng **không tự đồng nhất** số NLĐ đi làm do nhân viên báo cáo với số thực tế trong Direct Entry: nguồn, độ tin cậy và quy tắc đối chiếu khác nhau.
- Không dùng Work Reports để sửa hồ sơ NLĐ, thanh toán, quyền Direct Edit hay dữ liệu báo cáo tuyển dụng cũ.

### 1.3. Bản dùng được sớm nhất

Một người quản trị có quyền tạo **mẫu báo cáo tuyển dụng ngày**, giao cho hai nhóm; nhân viên nộp số cuộc gọi, số ứng viên quan tâm, số NLĐ đi làm; Team Leader vào trang tổng hợp thấy tỷ lệ hoàn thành nghĩa vụ, tổng chỉ tiêu của nhóm, so sánh các nhân viên và click đến bài nộp gốc; BoD theo quyền thấy cùng dashboard ở toàn công ty.

---

## 2. Nhóm người dùng và quyền nghiệp vụ

| Audience | Công việc chính | Scope dự kiến |
|---|---|---|
| Nhân viên | Xem nhiệm vụ, lưu nháp, nộp, tra cứu lịch sử của mình | `own` + assignment có hiệu lực |
| Team Leader | Xem tiến độ và tổng hợp của các nhóm được giao, xem bài nộp thuộc phạm vi, duyệt nếu có quyền riêng | `team` hiện hành, có chính sách lịch sử rõ ràng |
| Project Manager | Xem báo cáo được giao quản lý, nếu thực sự cần quan hệ dự án | `project` theo quan hệ thực, KHÔNG suy diễn từ `team` |
| BoD (`lienvu`, `ngattt`) | Đầy đủ quyền Work Reports và drill-down toàn công ty | `all` + các capability Work Reports đã cấp |
| Full Admin | Đầy đủ quyền Work Reports: quản lý mẫu, giao, đọc, analytics, duyệt và ủy quyền | `all` + các capability Work Reports đã cấp |
| Form Admin thuần | Quản trị cấu hình/mẫu theo grant; không mặc nhiên có quyền đọc nội dung | `all` + `report_form_manage`; cần grant riêng cho các thao tác đọc |
| Người được ủy quyền | Giao mẫu, nhắc hoặc duyệt trong thời hạn ủy quyền | Phạm vi đã ủy quyền, không được vượt quyền gốc |

**Hợp đồng quyền ban đầu (cần rà theo capability registry hiện hành):**

- `report_form_manage`: thiết kế, publish, đóng mẫu/version.
- `report_assign`: giao/thu hồi/tạm dừng nghĩa vụ báo cáo.
- `report_submit`: có thể suy ra từ assignment + actor active; nếu thêm token thì không bắt account thiếu token hợp lệ.
- `report_view`: đọc báo cáo nguồn trong current effective resource scope.
- `report_review`: xét duyệt báo cáo mẫu yêu cầu duyệt, có kiểm tra reviewer authority và chống tự duyệt.
- **Đề xuất thêm độc lập:** `report_analytics_view` (dashboard/tổng hợp) và `report_export` (xuất file), vì đọc dashboard không đồng nghĩa tải dữ liệu hàng loạt.
- `report_delegate` chỉ khi F2 thiết kế ủy quyền.

**Bắt buộc:** server/DB ra quyết định `actor → action → resource → scope`; menu, route, button chỉ là presentation. `scope=all` đơn lẻ không cấp toàn bộ capability. Actor inactive/unmapped phải fail closed. Quyền lịch sử cá nhân đọc bản nộp không tạo quyền sửa hoặc đọc dữ liệu hiện tại ngoài scope.

---

## 3. Trải nghiệm sản phẩm (Information Architecture)

### 3.1. Điều hướng đề xuất

Một menu cha **“Báo cáo công việc”** gồm màn con hiển thị theo quyền:

1. **Cần báo cáo:** danh sách việc cần nộp, hạn nộp, trạng thái, tạo/lưu nháp/nộp.
2. **Báo cáo của tôi:** lịch sử cá nhân, các kỳ báo cáo, xem chi tiết.
3. **Tổng hợp báo cáo:** dashboard F1.5+; lựa chọn mẫu, kỳ, nhóm, người, trạng thái, KPI, bảng và drill-down.
4. **Duyệt báo cáo:** F2, chỉ mẫu/nhân sự nằm trong thẩm quyền duyệt.
5. **Quản lý mẫu:** Form Builder, version, preview, publish/retire.
6. **Giao báo cáo:** chọn template/version, nhân viên/nhóm, kỳ, deadline, theo dõi nghĩa vụ.
7. **Nhắc báo cáo:** F4, cấu hình schedule/notification theo quyền.

Không cần tạo hết menu từ F1; nav chỉ xuất hiện khi chức năng có thật, với capability/scope được kiểm tra ở server.

### 3.2. UX chung

- Đồng bộ định hướng **Modern Soft Enterprise** đã chốt cho Mini BI: page header, toolbar, card, table/list, trạng thái, toast, dialog.
- Reuse design system đã/đang hoàn thiện trong R2.2, không tạo một hệ style thứ hai.
- Form Builder **là form nghiệp vụ mới**, không được can thiệp hoặc tái cấu trúc Spreadsheet Grid/Form Core `/direct-entry` đã khóa.
- Đảm bảo responsive, keyboard, focus, `aria-*`, light/dark, loading/empty/error, autosave draft có trạng thái server xác nhận rõ.

---

## 4. F1 — Form Builder, giao việc và nộp báo cáo

### 4.1. Form Builder

Quản lý mẫu theo `DRAFT → PUBLISHED → ARCHIVED`; mỗi lần publish là một **template_version bất biến**. Cho phép:

- Tên, mã mẫu, mô tả, đơn vị phụ trách, hướng dẫn nhập; cấu hình chu kỳ và timezone.
- Khối/section và thứ tự trường; trường `field_key` ổn định, `label`, `type`, `required`, mặc định, giới hạn min/max/length, lựa chọn, thông báo lỗi.
- Đánh dấu trường **có thể tổng hợp hay không**, `metric_key`, đơn vị, phương thức tổng hợp, phép so sánh thời gian, các chiều phân tích hợp lệ.
- Preview trước khi publish, validate schema, hiển thị lỗi khi field config không hợp lệ.
- `requires_review`: `false` theo mặc định; F1 persist config, F2 kích hoạt workflow xét duyệt.
- Clone version để chỉnh sửa; không thay schema của version đã có submission.

**V1 không triển khai tùy ý**: script chạy từ client, HTML tự do, công thức JS/SQL do người tạo form nhập, nested subform nhiều cấp, biểu thức tùy ý không có allowlist. Kiểu file upload, repeater và conditional branching phức tạp cần riêng spike/approval.

### 4.2. Phân công (assignment)

- Giao một version của mẫu tới người dùng riêng, nhóm, hoặc tập người được chọn; chọn khoảng hiệu lực.
- Cấu hình tần suất, ngày bắt đầu, thời điểm chốt kỳ, deadline, timezone `Asia/Ho_Chi_Minh`, lịch nghỉ hoặc kỳ loại trừ (nếu duyệt nghiệp vụ).
- Khi giao theo nhóm, **snapshot người phải nộp cho từng kỳ**, không đếm thành viên nhóm hiện tại thay cho nghĩa vụ của các kỳ quá khứ.
- Thay đổi membership sau khi đã đóng kỳ không làm tự viết lại lịch sử nợ báo cáo; có cơ chế adjustment + audit nếu cần.
- Có quyền thu hồi/tạm dừng assignment và giải thích hiệu lực; không xóa mất lịch sử nghĩa vụ đã phát sinh.
- Idempotency để một nhân viên không sinh hai nghĩa vụ cho cùng mẫu/kỳ do overlapping assignments; quy tắc ưu tiên hoặc conflict được chốt ở F0.

### 4.3. Nộp và lịch sử

- Danh sách báo cáo cần làm: **Sắp đến hạn / Chưa nộp / Quá hạn / Đã nộp / Chờ duyệt** (F2).
- Nhập form, validate client + server cùng schema đã publish, lưu nháp riêng, submit có `idempotency_key`/version OCC.
- Mỗi submission gắn actor thực, obligation, template_version, kỳ, thời điểm nộp và snapshot dữ liệu.
- **Mẫu không duyệt:** nộp hợp lệ là `COMPLETED` (hoặc lưu `SUBMITTED` + `completion_state=COMPLETE`, phải chọn một hợp đồng thống nhất).
- **Mẫu có duyệt (F2):** nộp chuyển `PENDING_REVIEW`; chỉ `APPROVED` được coi là số liệu cuối theo policy.
- Không sửa ngầm submission đã nộp; nếu cho bổ sung/sửa sau hạn phải có amendment/revision versioned, audit, không mất bản gốc.
- Phân biệt submitted_at, kỳ báo cáo, deadline, reviewed_at và last_updated_at.

### 4.4. Definition of Done F1

Owner đăng nhập TEST, bằng UI tạo một mẫu 3 chỉ tiêu định lượng và một câu ghi chú; publish, giao cho nhân viên hai team, tạo được nghĩa vụ theo kỳ, nhân viên nhập/lưu nháp/nộp; báo cáo không duyệt hoàn tất ngay; không thấy dữ liệu người khác; template version cũ vẫn đọc được khi xuất bản version mới; không trùng submission do double-click/retry.

---

## 5. F1.5 — Basic Reporting & Aggregation (BẮT BUỘC, làm ngay sau F1)

**Đây là phần trọng tâm mới của master plan. Không được coi đây là danh sách submission đơn thuần.**

### 5.1. Màn hình “Tổng hợp báo cáo” F1.5

Đối tượng: Team Leader, BoD và Admin/người được cấp quyền, theo effective scope.

**Bộ lọc:** mẫu/version tương thích, ngày/tuần/tháng/khoảng ngày, team, người nộp, trạng thái, kỳ báo cáo. Lọc theo project **chỉ** khi assignment/submission có project dimension được xác thực.

**Bốn lớp thông tin bắt buộc:**

1. **Compliance KPI:** số nghĩa vụ phải nộp, số đã nộp, chưa đến hạn, thiếu/quá hạn, nộp muộn, chờ duyệt (sang F2); tỷ lệ hoàn thành **trên mẫu số đúng**.
2. **Metric summary:** tổng, trung bình, số bản ghi có số liệu cho từng chỉ tiêu `aggregatable` (không bắt buộc mọi field phải cộng được).
3. **Breakdown:** bảng theo nhân viên/team/kỳ; chọn nhóm/người là drill-down xuống danh sách submissions tạo ra KPI.
4. **Evidence:** xem đúng submission snapshot đã được phép đọc, có mã báo cáo, kỳ, thời gian nộp, version mẫu, trạng thái và thông tin đóng góp vào chỉ tiêu.

**F1.5 phải trả lời bằng ví dụ:** Trong kỳ có 40 nghĩa vụ, đã nộp 36 (trong đó 4 nộp muộn), thiếu 4 sau deadline; tổng cuộc gọi 1.240, tổng NLĐ đi làm 86; mở số 86 thấy bài nộp nào đã đóng góp, chỉ trong scope actor.

### 5.2. Nguyên tắc tính đúng

- **Mẫu số nộp:** đếm obligations hợp lệ trong kỳ và scope; không đếm những người nộp thực tế rồi gọi là 100%.
- **Trước hạn:** chưa nộp là `UPCOMING`/`DUE`, chưa được tính `MISSING` nếu deadline chưa tới.
- **Nộp muộn:** là thuộc nhóm **đã nộp**, đồng thời được phân loại late; không cộng nó thêm vào mẫu số.
- **Báo cáo 0 hợp lệ khác với chưa nộp và khác với field bị bỏ trống**; không tự thay null bằng 0 khi tính trung bình.
- Không tổng hợp text vào SUM/AVG; enum dùng breakdown/COUNT; boolean tính true_count/total.
- **Tỷ lệ**: tính từ **SUM(numerator) / SUM(denominator)** theo đơn vị và chính sách zero denominator; không lấy trung bình đơn giản của các tỷ lệ người gửi.
- Không cộng gộp chỉ tiêu có `metric_key`, đơn vị hay định nghĩa khác nhau giữa các version. Việc gộp version cần mapping do Admin xác nhận và test chống sai số.
- Khi cùng một kỳ có nhiều bản amendment, chỉ bản hiệu lực theo policy được đếm; loại trừ bản bị thay thế/cancelled để tránh đếm kép.
- F1.5 ưu tiên số **đã nộp hoàn tất**; khi F2 có approval, dashboard tách `submitted/provisional` với `approved/final` bằng nhãn rõ ràng.
- Thống nhất timezone `Asia/Ho_Chi_Minh`, kỳ theo ngày nghiệp vụ và phạm vi đầu/cuối `[start, end)`; tránh lệch ngày giữa UTC và UI.

### 5.3. API/reporting contract

Đề xuất route/API **đặt tên riêng để không va** `/api/reporting` hiện hành:

- `GET /api/work-reports/analytics/overview`
- `GET /api/work-reports/analytics/metrics`
- `GET /api/work-reports/analytics/breakdown`
- `GET /api/work-reports/analytics/contributions` (drill-down những bài nộp đóng góp)
- `GET /api/work-reports/submissions/:id` (đọc snapshot theo quyền)

Bộ lọc được validate server, repo/SQL query scoped từ DB; pagination **keyset/server side** với breakdown/submissions. Không tải tất cả JSON lên client rồi tự filter/tổng hợp. Response có `as_of`, `period`, `effective_scope`, `template_version`/compatible_versions, `metric_unit`, `count_valid`, `missing`, `denominator`, `partial/final` khi áp dụng.

### 5.4. Definition of Done F1.5

Owner với tài khoản Leader thấy kết quả của team mình, BoD có quyền all thấy toàn công ty; số nộp/phải nộp khớp obligations; tính SUM/AVG/tỷ lệ trên fixture độc lập có kết quả đã biết; drill-down vào report gốc; không thấy nhóm khác; đổi filter không bị pha dữ liệu; không có mất quyền hay lộ dữ liệu trên direct API.

**F1.5 không được chuyển sang F2 khi Owner chưa xác nhận KPI tổng hợp đã hoạt động đúng trên TEST.**

---

## 6. F2 — Review & Delegation (có duyệt theo từng mẫu)

### 6.1. Lựa chọn duyệt

- `requires_review=false` mặc định khi tạo/publish template: nộp hợp lệ = hoàn tất.
- `requires_review=true`: nộp → `PENDING_REVIEW` → `APPROVED` hoặc `REJECTED`.
- Quy tắc reviewer theo scope hiện hành, có thể nhiều nguồn grant nhưng **self-approval phải bị chặn ở server/DB**.
- Cấu hình reviewer route/ủy quyền có effective-from/to, issuer, resource limit; không tự chuyển sang Admin toàn quyền khi thiếu reviewer.
- Từ chối có lý do, lịch sử; nộp lại tạo revision/event mới, giữ bản đã từ chối; OCC và audit cho mọi quyết định.

### 6.2. Hệ quả reporting

Phải thống nhất rõ cho từng KPI/metric:
- `Submission compliance`: đã nộp hay chưa, dù còn chờ duyệt.
- `Approved completion`: số báo cáo được duyệt.
- `Provisional metric`: các báo cáo đã nộp, chưa được duyệt.
- `Final metric`: chỉ từ báo cáo APPROVED hoặc mẫu không yêu cầu duyệt đã COMPLETED.

Không silently trộn hai loại số liệu hoặc đổi định nghĩa metric mà không đổi nhãn dashboard.

### 6.3. Definition of Done F2

Một mẫu A không duyệt tự hoàn tất; mẫu B có duyệt được chuyển đúng hàng đợi; Leader được quyền duyệt theo scope, không tự duyệt, không duyệt thay team; từ chối và nộp lại có version/audit; dashboards ghi rõ pending/final.

---

## 7. F3 — Advanced Reporting & Analytics

Bổ sung trên F1.5 (KHÔNG làm lại engine):

1. Biểu đồ ngày/tuần/tháng/quý/năm; so sánh kỳ hiện tại/kỳ trước, % biến động có xử lý trường hợp mẫu số bằng 0.
2. Team comparison, top/bottom contributors, phân bố, biểu đồ theo trường danh mục có schema cho phép.
3. Định nghĩa metric nâng cao dạng **cấu hình declarative có whitelist**, không chạy SQL/JS do người dùng cung cấp. Tỷ lệ từ metric tử và mẫu có cùng version/quy tắc đơn vị.
4. Data-quality cảnh báo: kỳ thiếu, số liệu khác thường, sửa mẫu làm metric không so sánh được, tổng và chi tiết không khớp.
5. Sắp xếp, tìm kiếm, filter/saved views nếu được duyệt; drill-down `company → team → employee → submissions` theo quyền.
6. Xuất XLSX **tổng hợp và chi tiết** theo filter, audit người xuất + thời gian + scope, tối đa dòng và streaming/background export nếu cần benchmark.
7. Nếu nghiệp vụ xác nhận, so sánh số tự khai báo với nguồn tuyển dụng Direct Entry bằng mapping/cross-source report **riêng**, hiển thị chênh lệch, không tự coi hai nguồn là một.

**Không làm ngay trong F3 mặc định:** BI semantic layer đa tenant phức tạp, SQL query builder tự do, pivot trên mọi JSON tùy ý, ML scoring tự động, AI tự suy luận dữ liệu báo cáo không có định nghĩa.

### DoD F3

So sánh kết quả hai kỳ, drill-down giải thích số chênh, XLSX tải đúng số được phép, test đối soát tổng và chi tiết, benchmark kỳ dài, Owner UAT.

---

## 8. F4 — Reminders & Deadline Operations

- Nhắc trước deadline, sắp đến hạn, quá hạn; lựa chọn in-app/email/kênh sẵn có theo hạ tầng và quyết định vận hành.
- Gửi nhắc theo obligations idempotent (đúng kỳ/người/mẫu), tránh spam hoặc phát lặp sau retry.
- Leader theo scope có danh sách chưa nộp, quyền nhắc/hỗ trợ; không tự động phạt hoặc chấm KPI nhân sự chỉ vì chậm nộp.
- Có cấu hình timezone, giờ gửi, quiet hours, opt-out cho loại thông báo được phép; log gửi/thất bại/audit.
- Có thể sử dụng hạ tầng background jobs sẵn có; nếu tích hợp n8n sau thì n8n là orchestration, **Supabase/PostgreSQL vẫn là source of truth cho nghĩa vụ và quyền**.

---

## 9. F5 — Mở rộng sau khi có dữ liệu vận hành

Các khả năng để dành, **không cam kết triển khai ở F1–F3**: bảng con lặp, upload file/chứng cứ, conditional rules phức tạp, công thức metric nâng cao, chia sẻ báo cáo ngoài tổ chức, scheduled PDF, mẫu báo cáo liên phòng ban, đối soát đa nguồn tự động, AI tóm tắt báo cáo (tùy phê duyệt). Chỉ bổ sung theo nhu cầu có thật và evidence sử dụng.

---

## 10. Kiến trúc dữ liệu đề xuất (v1)

### 10.1. Sơ đồ quan hệ

```text
work_report_templates (identity, owner, status)
   └─ work_report_template_versions (schema_json, metric_contract_json, requires_review, immutable publish)
        └─ work_report_assignments (assignee/team rule, recurrence, effective window, deadlines)
             └─ work_report_obligations (person × template/version × period, due_at, snapshot team)
                  └─ work_report_submissions (current pointer/state, author, submitted_at)
                       ├─ work_report_submission_revisions (immutable payload, schema version, audit)
                       ├─ work_report_metric_values (normalized metric_key, unit, numeric value, eligibility)
                       └─ work_report_review_events (F2, append-only)
   work_report_assignment_events / work_report_audit_events (append-only, grants & changes)
```

**Tên bảng là đề xuất và phải kiểm tra collision với repo trước khi tạo migration.** Không được tự áp dụng SQL trong bước viết master plan.

### 10.2. Cột/hợp đồng quan trọng

| Entity | Khóa/hợp đồng |
|---|---|
| Template | `template_id`, `template_code`, creator, status, timestamps |
| Template version | `version_id`, `template_id`, `version_no`, `schema_jsonb`, `metrics_jsonb`, `requires_review`, `published_at`, checksum, immutable |
| Assignment | `assignment_id`, `template_version_id`, target/selection rule, recurrence, timezone, `effective_from/to`, `created_by` |
| Obligation | `obligation_id`, `assignment/source`, `assignee_app_user_id`, `period_start/end`, `due_at`, **team/scope snapshot**, exemption/cancel reason |
| Submission | `submission_id`, `obligation_id`, state, latest_revision_id, `submitted_at`, `version` OCC, creator |
| Revision | `revision_id`, `submission_id`, payload JSONB validated against version, seq, operation actor, created_at; append-only |
| Metric value | `revision_id`, `field_key`, `metric_key`, numeric value, unit, eligible/final flag, period/team/user dims with traceable source |
| Review event | event id, version/revision, reviewer, decision, reason, timestamp, acting scope; audit append-only |

**Quan trọng:** Không chỉ lưu một JSONB rồi tính mọi báo cáo bằng thao tác parse JSON trên client. Giữ **raw immutable JSONB làm chứng cứ**, song song **projection chuẩn hóa, có nguồn revision rõ ràng** để query tổng hợp có chỉ mục, chính xác và đủ nhanh.

### 10.3. Chốt thiết kế liên quan đổi nhóm/quyền

- Nghĩa vụ đã phát sinh giữ **snapshot team/người phụ trách tại kỳ** để tổng kết quá khứ không thay đổi khi chuyển nhóm.
- **Khả năng truy cập hiện tại** được kiểm tra theo quyền hiệu lực của actor; có policy riêng cho báo cáo đã xem/đã duyệt trong lịch sử, không mặc định chiếm hữu dữ liệu team cũ.
- `OWN` luôn xem bản nộp của mình nếu actor active, theo chính sách lịch sử đã chốt; không đọc dữ liệu quản lý nhóm cũ chỉ vì từng thuộc team đó.
- Dashboard lịch sử có mode rõ: **theo cơ cấu tổ chức của kỳ** hay **cơ cấu hiện tại**. F1.5 mặc định theo kỳ để tránh biến động số; UI phải đặt nhãn cụ thể.
- Các thay đổi owner/assignment/delegation luôn có audit, không trust `team_id`, `app_user_id` hoặc `scope` lấy từ browser.

### 10.4. Hiệu năng & dữ liệu

- F1.5 ưu tiên SQL aggregate/index hợp lý; có thể materialize metric projection lúc nộp/review, **trong transaction nhất quán** với revision.
- Recompute hoặc repair projection qua job idempotent có checksum và reconciliation; không cho silently lệch submission snapshot.
- Phân trang keyset cho lịch sử/bài nộp; pagination offset có kiểm soát cho bảng quản trị nhỏ.
- Tránh N+1 khi tính bảng theo team; benchmark trên fixture vài chục người và lịch sử một năm; chỉ thêm materialized view/async rollup khi số liệu đo đạc chứng minh cần thiết.
- Versioned migrations + forward-only; không sửa migration lịch sử; tránh function ownership/grant drift. Test trên PostgreSQL non-superuser và version Supabase TEST tương ứng.

---

## 11. Metric Contract — trung tâm để F1.5 và F3 không phải viết lại

### 11.1. Ví dụ mẫu tuyển dụng theo ngày

| Field key (ổn định) | Nhãn hiển thị | Type | Metric key | Tổng hợp | Đơn vị |
|---|---|---|---|---|---|
| `calls_made` | Số cuộc gọi | integer ≥ 0 | `calls_made` | SUM / AVG / COUNT_VALID | cuộc |
| `interested_candidates` | Ứng viên quan tâm | integer ≥ 0 | `interested_candidates` | SUM / AVG | người |
| `workers_started` | NLĐ đi làm | integer ≥ 0 | `workers_started` | SUM / AVG | người |
| `notes` | Nội dung công việc | textarea | — | không tổng hợp | — |

**Tỷ lệ ứng viên quan tâm** (F3): `SUM(interested_candidates)/SUM(calls_made)`, chỉ khi mẫu số dương. Không tự gộp với kỳ/version khác định nghĩa `interested_candidates` hoặc `calls_made`.

### 11.2. Metadata hợp đồng cho mỗi metric

- `metric_key`, `field_key`, `type`, `unit`, `aggregation_allowed`, `null_policy`, `zero_policy`, `valid_range`, `compatible_group` (nếu cross-version), `date_dimension`, `organization_dimension`.
- `metric_key` định danh ý nghĩa **kinh doanh**, không dựa vào label tùy chỉnh hay vị trí trên form.
- Version cập nhật label giữ metric_key nếu ý nghĩa/đơn vị không đổi; thay ý nghĩa phải sinh metric_key mới hoặc mapping explicit có audit.
- Danh sách nhóm/đơn vị/tháng/kỳ phải được kiểm chứng bên server để không truy vấn tùy ý trường nhạy cảm.

---

## 12. Phân quyền ở API và DB (không suy diễn từ menu)

### 12.1. Hợp đồng server

- Tái sử dụng resolve session/actor hiện hữu, capability & scope từ DB; từ chối actor disabled/unmapped.
- API Form Builder, assignment, submit, review, overview, breakdown, drill-down, export có guard riêng; không tin `role`, `app_user_id`, `team_id` do client gửi.
- Bản ghi chi tiết, tổng hợp và export phải kiểm tra **cùng một scope**; tránh dashboard công ty cho người không có quyền đọc nhân viên ngoài team.
- Service role chỉ ở server/private adapter; `PUBLIC/anon/authenticated` không EXECUTE trực tiếp protected privileged RPC.
- Reviewer không tự duyệt ngay cả khi có nhiều grant chồng lấp.
- Assignment không tự cấp quyền xem toàn bộ bài nộp của team; quyền đọc cần `report_view`/resource relation tương ứng.
- Có audit cho create/publish/assign/withdraw/submit/amend/review/export/delegate.

### 12.2. Phép thử negative bắt buộc

1. Staff Team A thử xem nộp báo cáo Team B qua ID/URL/API → denied.
2. Leader A giả `team_id=B` ở query → denied.
3. Form Admin thuần chỉ có `report_form_manage` và không có `report_view` thử mở nội dung nhân viên → denied; Full Admin và BoD dùng grants hiện hành của mình.
4. Có `report_analytics_view@team` nhưng không có `report_export` → dashboard đúng scope, export denied.
5. Disabled actor có cookie cũ → denied.
6. Người nộp vừa bị chuyển team vẫn xem được lịch sử cá nhân hợp lệ, không sửa được bản khóa.
7. Người được ủy quyền hết hạn không còn xem/duyệt ngoài scope.
8. Approval self/overlap forbidden; submission double-click chỉ một final revision.
9. Template version đã publish không được sửa schema/metric mapping in-place.
10. Drill-down không hiển thị dữ liệu ngoài scope dù tổng hợp có cache.

---

## 13. Tái sử dụng codebase — audit source tại baseline #96

**Phần đã thấy trong repo:**

| Component / Library hiện có | Tái sử dụng được | Phần vẫn phải xây |
|---|---|---|
| Next.js 16.3.8, React 19.2.8, App Router | Routes, SSR/page gate, server/API flow | Module `/work-reports` riêng |
| Supabase PostgreSQL + actor/session/capability | Identity, security model, database/migration runner | Các entity/guards/queries riêng Work Reports |
| `src/lib/navigation/registry.ts` & capability predicates | Nav/menu theo actor | Predicate/report capabilities mới |
| `src/lib/reporting/p3-w05a-audience.ts` | Pattern all/team/own, scope sanitization | Scope riêng áp dụng obligations/submissions của module mới |
| `src/app/api/reporting/team-report/route.ts` | Pattern server-auth reporting | API Work Reports, không sửa business semantics dashboard tuyển dụng |
| `src/components/dashboard/team-report-view.tsx`, Recharts 3.10.1 | Card/KPI/chart/trend/drill-down patterns | Dynamic metrics/template-specific config |
| `src/components/dashboard/dashboard-filters.tsx`, `nuqs` | Date/filter URL state, presets | Template/assignee/report status filters |
| `src/components/ui/card.tsx`, `form-dialog.tsx`, `offset-pager.tsx`, Radix UI, Lucide | UI primitives, dialog, list/pager | Builder canvas, form renderer, workflow cards |
| Zod 4.6.5 | Schema/config/request validation | Registry type-to-Zod, publish & submission validators |
| ExcelJS 4.4.0 | Workbook format/XLSX export | Export Work Reports, audit, permission, async strategy |
| CI manifest/shards/Real PostgreSQL suites | Test harness/invariants | Tests và fixtures Work Reports, PG17 rehearsal |

**Có thể bổ sung có điều kiện:** React Hook Form + `@hookform/resolvers` nếu Form Renderer nhiều trường mang lợi ích rõ ràng; `@dnd-kit` cho Builder drag-and-drop khi owner duyệt UX; TanStack Table cho bảng quản trị phân tích lớn nếu shared list hiện có không đủ. **Không mặc định thêm cả ba**; làm reuse/build spike trước, khai báo chi phí bundle và tác động codebase.

**Không viết lại:** auth/session, Role–Scope engine, global dashboard, báo cáo tuyển dụng, Spinner/Toast/Dialog pattern, spreadsheet nhập liệu, export engine chung nếu tái sử dụng được.

---

## 14. Work Packages & phase execution

### F0 — Pre-coding Technical & Business Contract (ngắn, nhưng bắt buộc)

**T0 + T1 Survey (read-only):**
- Chốt 01–02 mẫu biểu thực tế đại diện, loại trường và cách tính KPI.
- Chốt quyền theo actor/scope; hiện tại/đổi team/historical; mẫu nào có duyệt; deadline/timezone; user assignment conflict.
- Kiểm kê source và migrations/capabilities trùng tên; xác nhận R2.2 grid-lock.
- Đề xuất ERD, template schema v1, `metric_contract`, API versioning, security matrix, aggregation fixtures.
- Bàn giao `F0-decision-log.md`, `F0-reuse-inventory.md`, `F0-data-contract.md`, `F0-acceptance-matrix.md`.
- **Dừng để Owner duyệt những điểm chưa chốt trước migration đầu tiên.**

### F1 — Work Packages

- **F1-WP1 (T1-A):** SQL foundation, immutable template versions, authorization, audit, forward-only migrations.
- **F1-WP2 (T1-B):** Template management / Form Builder / version preview + publish.
- **F1-WP3 (T1-C):** Assignment, recurrence, obligations snapshot, deadlines, idempotency, staff tasks UI.
- **F1-WP4 (T1-B/C, ownership tách file):** Form renderer, draft, submit, validation, history.
- **F1-WP5 (T0):** Integration, end-to-end/CI, TEST preflight/migration gate, handoff checklist.

### F1.5 — Work Packages

- **F1.5-WP1 (T1-A):** normalized metric projection, eligibility rules, scoped SQL aggregation, reconciliation.
- **F1.5-WP2 (T1-B):** Leader/BoD summary page, filters, KPI, team/person table, drill-down.
- **F1.5-WP3 (T1-C):** aggregation fixture oracle, cross-version/null/zero/timezone/permission tests, performance.
- **F1.5-WP4 (T0):** release gates, UAT checklist và Owner sign-off.

### F2 — Work Packages

- **F2-WP1:** Review policy per template version; SQL transitions/authorization/OCC/audit.
- **F2-WP2:** Reviewer inbox UI, approve/reject/resubmit, delegated review if approved; gom điều hướng hiện hữu vào hai menu **Báo cáo cấp mới** và **Báo cáo hàng ngày → Báo cáo công việc**. Chưa tạo mục Chấm công.
- **F2-WP3:** Distinguish provisional/final metrics; tests & acceptance.

### F3 — Tham chiếu lịch sử (ngoài phạm vi theo quyết định Owner)

Các hạng mục analytics liên kỳ, biểu đồ và XLSX không được triển khai sau F2 trong phạm vi hiện tại.

### F4/F5 — Ngoài phạm vi theo quyết định Owner

Không lập backlog hay triển khai nhắc hạn và mở rộng sau vận hành cho module này.

**Không lập thời lượng cố định khi chưa có F0 code-level estimate.** Để T0 đưa effort theo WP (S/M/L), critical path và kế hoạch branch/PR không xung đột.

---

## 15. Migration, TEST, Blue–Green, CI và UAT gates

1. **Source gate:** chốt SHA từ `main` sau các hotfix R2.2 đang diễn ra; kiểm tra clean source + zero pending migration bất thường.
2. **Migration gate:** migration mới `forward-only`, stable checksums, transaction/rollback plan; explicit SQL function definitions, correct owner/`SECURITY DEFINER`/`search_path`, revoke EXECUTE; không sửa file lịch sử.
3. **DB TEST gate:** làm preflight read-only trên Supabase TEST `oyykqfxkyqhxgrfntokl`, operator tương ứng PostgreSQL thực; chỉ apply khi được Owner cho phép. Không viết Production.
4. **CI:** typecheck, lint, build, docs, zero orphan, functional tests, DB authorization matrix PG non-superuser, reconciliation/aggregation tests, no grid regression.
5. **Release gate:** TEST deploy live verified SHA; authenticated smoke/security verification kỹ thuật do agent; không đồng nhất với UAT nghiệp vụ.
6. **Owner UAT:** T0 soạn checklist UI step-by-step với dữ liệu mẫu, actor, kỳ, expected KPI, PASS/FAIL **để trống**, Owner trực tiếp thử và chốt.
7. **Production:** quyết định riêng bởi Owner; expand→migrate→contract, backup/restore rehearsal phù hợp Blue–Green. Không cho auto-deploy migration/Production.

**Ràng buộc `NO TOUCH`:** Các file/hook/CSS vùng Spreadsheet Grid/Form Core `/direct-entry` thuộc Owner Lock; không chỉnh sửa trong các phase này và kiểm tra tác động gián tiếp khi thay global design tokens.

---

## 16. Test Matrix nghiệp vụ & phân tích bắt buộc

| ID | Test | Expected |
|---|---|---|
| AG-01 | 20 người × 1 kỳ, 18 nộp, 2 quá hạn | Due=20; submitted=18; overdue_missing=2; completion=90% |
| AG-02 | 18 đã nộp, trong đó 3 nộp muộn | Submitted=18; late=3 là tập con của submitted; due vẫn=20 |
| AG-03 | Nghĩa vụ chưa đến deadline | `upcoming`, không gắn `missing` |
| AG-04 | Field số=0, field null, người không nộp | `0` được tính hợp lệ, null không làm count_valid, không nộp không tạo metric |
| AG-05 | SUM cuộc gọi 10+20+0 | 30; AVG theo 3 values=10 |
| AG-06 | Tỷ lệ 1/2 và 9/18 | Tỷ lệ nhóm = (1+9)/(2+18)=50%, **không AVG tỷ lệ không trọng số** |
| AG-07 | Đổi tên nhãn nhưng không đổi metric definition | Cộng gộp được nếu compatible; nếu đổi unit/meaning thì chặn |
| AG-08 | Reassign từ Team A sang B giữa hai kỳ | Hai kỳ giữ snapshot team riêng; không mất số liệu / trộn scope |
| AG-09 | Staff/Leader/Admin ngoài scope | Không thấy card, detail, API hoặc export ngoài scope |
| AG-10 | Nhân viên nộp 2 lần/retry | Không nhân đôi nghĩa vụ, submission hoặc metric contribution |
| AG-11 | Bản đã duyệt bị sửa có lịch sử / resubmit F2 | Không đè bản gốc; chỉ revision hiệu lực được tính final |
| AG-12 | Template không yêu cầu duyệt | Nộp xong final, không phát sinh queue bắt duyệt |
| AG-13 | Template yêu cầu duyệt | PENDING_REVIEW → final chỉ sau APPROVED; REJECTED không cộng final |
| AG-14 | Tạo XLSX vượt scope / thiếu quyền export | 403/no download; ghi audit khi export hợp lệ |
| AG-15 | Lọc kỳ ở ranh giới 00:00 HCM | Không lệch ngày hoặc nhân đôi kỳ |
| AG-16 | Từ KPI drill-down đến dòng nguồn | Tổng contributions = KPI theo cùng query/scope/version policy |
| AG-17 | Thay đổi trạng thái account | Disabled/unmapped deny; không leak từ stale caching |
| AG-18 | Schema published có submission | Không sửa in place; publish version mới và giữ lịch sử cũ |

**UAT thực tế:** chuẩn bị fixture riêng trên TEST, tránh sửa dữ liệu nghiệp vụ thực không được phép; Agent có thể kiểm thử kỹ thuật tự động nhưng không tự đánh PASS/FAIL Owner UAT.

---

## 17. Performance, chất lượng dữ liệu, UX và vận hành

- Người dùng tham chiếu ban đầu ~50 tài khoản, 5–15 hoạt động thường xuyên; thực hiện benchmark fixture tăng trưởng (ví dụ 50 user × 365 kỳ = 18.250 nghĩa vụ/năm/mẫu) thay vì over-engineer.
- Đề xuất mục tiêu kiểm thử ban đầu (chưa phải SLO cam kết): dashboard F1.5 p95 dưới 3s với fixture tham chiếu; không tải hàng nghìn row vào browser để tổng hợp.
- Cache theo **actor + effective scope + template/version + filters + as_of**, không cache dùng chung khiến lộ số liệu.
- Tất cả API trả empty/denied/unavailable khác biệt; có retry idempotent và trace correlation để debug.
- Metric projection có reconciliation job/test để bảo đảm không lệch raw source; audit export và sửa report.
- UI có skeleton, empty/error banner, toast thao tác ngắn, accessibility/responsive; không lạm dụng modal khiến người dùng mất dữ liệu draft.
- Không ép quy tắc “nộp trễ = KPI kém” trước khi Owner phê duyệt chính sách nhân sự.

---

## 18. Quy tắc thay đổi và ngăn scope creep

- F1 + F1.5 cần **đem lại giá trị cho BoD/Team Leader sớm**, không đi quá sâu vào Form Builder phức tạp trước khi nhìn thấy dashboard thực.
- Mọi feature mới phải khai báo: `Reuse`, `Adapter`, hay `Custom` cùng lý do, file ownership, tests, acceptance.
- Không đổi nghĩa vụ lịch sử tự động khi đổi team/version/deadline.
- Không xây AI analytics, drag-and-drop form engine phức tạp, workflow nhiều cấp, upload ảnh chứng cứ, CRM integration, mobile app trong F1 nếu chưa được Owner chốt.
- Nếu tính năng mới cần thay đổi nền authorization hoặc schema hiện hành, tách PR backward-compatible và xin phê duyệt migration.
- Tuyệt đối không làm hỏng R1.2/R2.1/R2.2 và no-touch Spreadsheet Grid.

---

## 19. Đầu ra cần bàn giao từng chặng

| Phase | Artifacts tối thiểu | Owner acceptance |
|---|---|---|
| F0 | Decision log; reuse inventory; ERD + metric contract; security matrix; UAT scenarios | Duyệt hợp đồng trước coding |
| F1 | Form Builder + Assignment + Submission chạy TEST; PR/SQL checksum; test + Owner checklist | Tạo/giao/nộp được mẫu và có lưu lịch sử |
| **F1.5** | **Dashboard tổng hợp + SQL metrics + drill-down + reconciled fixtures** | **Leader/BoD tự UAT và xác nhận số tổng đúng** |
| F2 | Per-template review/delegation + UI + audit | Có/không duyệt đúng cấu hình, chống tự duyệt |
| F3 | Ngoài phạm vi hiện tại theo quyết định Owner | Không triển khai sau F2 |
| F4 | Ngoài phạm vi hiện tại theo quyết định Owner | Không triển khai sau F2 |
| F5 | Ngoài phạm vi hiện tại theo quyết định Owner | Không triển khai sau F2 |

---

## 20. Lệnh khởi động T0 (CHỈ F0, không tự viết SQL)

> **T0 — WORK REPORTS F0 START**  
> Read `docs/work-reports/master-plan.md`. R2.1 đã Owner UAT PASS, R2.2 UI/UX đang được hoàn thiện riêng. Khóa vùng Spreadsheet Grid/Form Core `/direct-entry` không được thay đổi.  
> Chỉ khảo sát/read-only repo hiện tại và đối chiếu 01–02 report template thực tế được Owner cung cấp. Lập `F0-decision-log.md`, `F0-reuse-inventory.md`, `F0-authorization-and-data-contract.md`, `F0-aggregation-oracle-and-UAT-scenarios.md`, `F0-execution-backlog.md` phân công T1-A/B/C.  
> Đặc biệt: thiết kế **kho nghĩa vụ phải nộp** và **metric projection** từ F1, không cho F1 chỉ lưu JSONB rồi F1.5 phải làm lại. Chốt cách đếm nộp đúng hạn/trễ/thiếu, version compatibility, approval optional default false, actor/scope, lịch sử đổi team.  
> Trình Owner duyệt decision log và thiết kế F1.5 dashboard trước migration. Không chạm Supabase Production, không sửa SQL và không tự thực hiện Owner UAT.

---

## 21. Tiêu chí hoàn thành toàn module

**Module được coi là đạt mục tiêu khi:**

1. Owner có thể tạo và xuất bản mẫu báo cáo mới mà không cần sửa code.
2. Có thể giao theo người/team và kỳ; xác định **ai phải nộp** từ nguồn nghĩa vụ chuẩn.
3. Nhân viên có thể lưu nháp, nộp và xem lịch sử chính mình; mẫu không duyệt hoàn tất ngay.
4. Team Leader/BoD có công cụ tổng hợp, thống kê, phân tích, drill-down và kiểm chứng số từ report gốc theo đúng quyền.
5. Các thay đổi version, nhóm, thời hạn, duyệt và nộp lại không làm sai số quá khứ.
6. Dashboard & XLSX không lộ dữ liệu ngoài scope; DB/API enforce không phụ thuộc menu.
7. Test kỹ thuật, CI, DB gate đạt; TEST sẵn sàng; **Owner trực tiếp UAT và chốt PASS** từng phase.
8. Không tác động Spreadsheet Grid/Form Core đã khóa hoặc Production ngoài phê duyệt riêng.

**Tuyên bố thiết kế cốt lõi:** *Hệ thống báo cáo chỉ có ý nghĩa khi vừa thu thập được dữ liệu, vừa chuyển dữ liệu đó thành thông tin quản trị chính xác và có thể truy ngược nguồn. Vì vậy F1.5 là một deliverable bắt buộc, không phải hạng mục “để sau”.*


---

## 22. Phụ lục F0 — Hồ sơ Khảo sát & Hợp đồng Kỹ thuật trình Product Owner (21/10/2026)

- **Baseline `origin/main` đã xác minh tại F0:** `8bf16afe9360e5eebe0dd9183c8ef9d85fc39b0c` (sau PR #96).
- **Trạng thái F0:** Đã hoàn tất khảo sát read-only và lập 06 tài liệu hợp đồng F0 (chưa sửa code nghiệp vụ, chưa tạo/chạy SQL migration, không chạm Supabase TEST/Production, không chạm vùng khóa `/direct-entry` Spreadsheet Grid/Form Core):
  1. [`F0-codebase-reuse-inventory.md`](./F0-codebase-reuse-inventory.md) — Kiểm kê tái sử dụng codebase kèm bằng chứng file/symbol/line và ranh giới `NO TOUCH`.
  2. [`F0-product-contracts-and-open-decisions.md`](./F0-product-contracts-and-open-decisions.md) — Hợp đồng Form Builder, Versioning, Submission Lifecycle, Reporting Obligations (10 kịch bản) và 08 quyết định mở (`OD-01` → `OD-08`) chờ Product Owner phê duyệt.
  3. [`F0-data-model-and-analytics-contract.md`](./F0-data-model-and-analytics-contract.md) — Mô hình thực thể logic (ERD), hợp đồng `work_report_obligations` & `work_report_metric_values`, quy tắc tổng hợp F1.5/F3.
  4. [`F0-authorization-matrix.md`](./F0-authorization-matrix.md) — Ma trận phân quyền `Actor × Action × Scope`, grants đầy đủ cho Full Admin/BoD, quy tắc lịch sử đổi nhóm và 12 phép thử bảo mật phủ định (`SEC-WR-01` → `SEC-WR-12`).
  5. [`F0-architecture-and-test-strategy.md`](./F0-architecture-and-test-strategy.md) — Kiến trúc zero-dependency mới, idempotency/OCC, chiến lược migration forward-only tương thích `S0-T1-C` & `P3.1`, và ma trận kiểm thử `AG-01` → `AG-18`.
  6. [`F0-execution-roadmap.md`](./F0-execution-roadmap.md) — Phân rã Work Packages `F1` → `F5`, phân công độc quyền file `T1-A/B/C/T0` và bảng kiểm soát rủi ro thiết kế lại.
