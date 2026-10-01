# Master Plan — Sales Performance & Reporting System V1

- **Phiên bản:** 1.0
- **Ngày:** 01/10/2026
- **Trạng thái:** Baseline kế hoạch; chưa phải đặc tả triển khai chi tiết.
- **Phạm vi:** P0–P4 — Foundation, BoD Dashboard, Data Platform, Auth/Organization, KPI/Performance.
- **Đội thực thi:** AI Coding Web và AI Assistant n8n.
- **Chủ dự án:** xác nhận nghiệp vụ, cung cấp dữ liệu/môi trường và nghiệm thu milestone.

## 1. Mục tiêu và nguyên tắc

Xây hệ thống báo cáo kết quả kinh doanh và quản trị KPI cho BoD, Leader và Staff. Google Sheets tiếp tục là nơi nhập liệu; Supabase là nguồn dữ liệu trung tâm phục vụ web app. BoD được sử dụng dashboard với dữ liệu thật từ P1, sau đó hệ thống được hoàn thiện về độ tin cậy, phân quyền và KPI.

Các nguyên tắc bắt buộc:

1. Không hard-code số lượng nhân viên, team, leader, project hoặc Google Sheet. Thêm đối tượng qua dữ liệu/cấu hình.
2. Ưu tiên P1 để chứng minh giá trị; các kiểm soát tối thiểu về dữ liệu và bảo mật vẫn phải có từ đầu.
3. Hai Agent làm việc qua data contract có version; không tự ý đổi schema hoặc tên trường.
4. Một nơi tính cho mỗi chỉ số nghiệp vụ; UI và n8n không tự tính hai phiên bản khác nhau.
5. Dữ liệu lịch sử giữ đúng bối cảnh tại thời điểm phát sinh; chuyển team không viết lại kết quả cũ.
6. Secrets chỉ nằm trong môi trường server/credentials; không đưa vào frontend, Git hoặc file bàn giao.
7. Commission/Payroll chỉ là hướng mở rộng kiến trúc, không triển khai trong V1.

## 2. Phạm vi

### Trong V1

- Dashboard kết quả theo công ty, team, nhân viên và project.
- Bộ lọc ngày/kỳ/team/nhân viên/project; so sánh kỳ và drill-down.
- Đồng bộ Google Sheets qua n8n vào Supabase.
- Master data, source registry, validation, chống trùng, retry, sync history và audit.
- Đăng nhập, tổ chức, lịch sử phân công và phân quyền BoD/Leader/Staff.
- Quản lý target tối thiểu; Actual/Target, Achievement, Remaining, Run Rate và lịch sử hiệu suất.
- Trang vận hành tối thiểu để xem tình trạng nguồn dữ liệu và lỗi đồng bộ.

### Ngoài V1

- Tính hoa hồng, incentive, lương, khấu trừ, kỳ lương và khóa kỳ lương.
- UI, workflow, business rule hoặc estimate công sức cho Commission/Payroll.
- Forecast, anomaly detection và phân tích nâng cao cần dữ liệu lịch sử dài.
- Admin portal toàn diện, CRM hoặc thay thế toàn bộ quy trình nhập Google Sheets.

Các màn hình cấu hình cần thiết cho vận hành V1 có thể nằm trong scope từng phase; không mặc nhiên mở rộng thành management platform đầy đủ.

## 3. Kiến trúc mục tiêu

| Lớp | Công nghệ dự kiến | Trách nhiệm |
|---|---|---|
| Nhập liệu | Google Sheets | Dữ liệu nguồn theo mẫu đã thống nhất |
| Ingestion/automation | n8n self-hosted trên VPS | Đọc nguồn, chuẩn hóa, validate, đồng bộ, retry, cảnh báo |
| Data platform | Supabase/PostgreSQL | Master data, facts, lịch sử, constraints, audit và reporting |
| Web | Next.js/TypeScript | UI, API/server layer, phân quyền và báo cáo |
| Hosting web | Vercel | DEV/preview và PROD theo cấu hình triển khai |
| Source control | GitHub | Code, migrations, contract và workflow export đã loại secrets |

Luồng chính: **Google Sheets → n8n → Supabase → Next.js → Người dùng**.

Supabase là điểm tích hợp chung. Next.js không xây pipeline đọc Google Sheets thứ hai. n8n không trở thành backend nghiệp vụ song song.

### Thư viện định hướng

| Nhóm | Lựa chọn | Thời điểm |
|---|---|---|
| UI | Tailwind CSS, shadcn/ui, Lucide | P0–P1 |
| Biểu đồ | Recharts | P1 |
| Bảng | TanStack Table | P1 |
| Filter URL | nuqs | P1 |
| Ngày/kỳ | date-fns; xử lý timezone rõ ràng | P1 |
| Dữ liệu tương tác/cache | TanStack Query khi cần | P1 trở đi |
| Validation | Zod, kết hợp DB constraints | P0 trở đi |
| Form | React Hook Form + Zod | Khi có form quản trị/target |
| Database/Auth client | Supabase JS SDK; SSR integration khi cần | P0/P3 |

Agent Web kiểm tra compatibility và khóa dependency version lúc scaffold. shadcn/ui được quản lý dưới dạng component trong source. Server Component dùng cho tải ban đầu phù hợp; Client Component cho filter, chart và tương tác. Chưa bổ sung Redux, Prisma, GraphQL, Redis hoặc các lớp hạ tầng khác khi chưa có nhu cầu cụ thể.

## 4. Phân quyền trách nhiệm giữa hai Agent

| Hạng mục | Owner | Phối hợp |
|---|---|---|
| Schema, migrations, constraints, indexes, reporting views/RPC | AI Coding Web | n8n góp yêu cầu ingestion |
| Data contract và payload mẫu | AI Coding Web | n8n xác nhận khả năng đọc/ghi |
| Workflow đọc Sheets, mapping, đồng bộ và retry | AI Assistant n8n | Web cung cấp contract |
| Quy tắc nghiệp vụ, công thức chỉ số và target | AI Coding Web | Chủ dự án xác nhận; n8n cung cấp dữ liệu |
| Auth, RLS, API và UI | AI Coding Web | n8n kiểm tra tác động tới tài khoản ingestion |
| Sync logs, ingestion audit payload và vận hành workflow | AI Assistant n8n | Web tạo schema và UI giám sát |
| Đối soát end-to-end | Cả hai | Chủ dự án nghiệm thu |

**Chỉ AI Coding Web tạo/sửa DB migration.** AI n8n đề xuất thay đổi bằng contract change request; không tự sửa schema trực tiếp trên PROD.

Quyền nghiệp vụ không suy ra từ người sở hữu Sheet hoặc account chạy n8n. Tài khoản ingestion là tài khoản hệ thống, tách khỏi tài khoản người dùng.

## 5. Roadmap và cổng nghiệm thu

| Phase | Mục tiêu | Web | n8n | Milestone |
|---|---|---|---|---|
| P0 | Nền kỹ thuật và contract đầu tiên | Chính | Chính | Một dòng test chạy xuyên pipeline |
| P1 | BoD Dashboard MVP | Chính về trải nghiệm | Chính về dữ liệu | BoD xem, filter và drill-down dữ liệu thật |
| P2 | Dữ liệu đáng tin và nguồn động | Chính về DB/reporting | Chính về ingestion | Thêm nguồn qua registry; sync có đối soát và phục hồi |
| P3 | Auth, tổ chức và phân quyền | Chính | Phối hợp | Ba role chỉ thấy dữ liệu đúng phạm vi |
| P4 | KPI và hiệu suất | Chính | Phối hợp | Target/Actual và báo cáo hiệu suất được nghiệm thu |

Thực hiện theo P0 → P1 → P2 → P3 → P4. Các phần độc lập trong một phase có thể làm song song sau khi contract được thống nhất. Chưa cam kết lịch/công sức trước khi kiểm tra mẫu Sheet, quy mô và định nghĩa chỉ số.

## 6. P0 — Foundation

**Đầu vào:** mẫu Sheet, danh sách chỉ số sơ bộ, quyền truy cập môi trường và một bộ dữ liệu test không nhạy cảm.

### AI Coding Web

- Dựng repository Next.js/TypeScript, layout và bộ component nền.
- Thiết lập cấu hình DEV/PROD, file env mẫu và kết nối Supabase.
- Tạo migration tối thiểu cho master data, nguồn và dữ liệu kết quả.
- Viết contract v0.1, fixture hợp lệ/không hợp lệ và quy ước lỗi.
- Tạo reporting query tối thiểu và trang hiển thị kết quả test.
- Thiết lập triển khai web theo stack đã thống nhất.

### AI Assistant n8n

- Kiểm tra môi trường n8n/VPS, credentials và kết nối Google/Supabase.
- Dựng workflow đọc một Sheet mẫu, map payload và ghi đúng contract.
- Thiết lập run ID, log và nhánh xử lý lỗi tối thiểu.
- Export workflow đã loại secrets, ghi hướng dẫn cấu hình/chạy lại.

### Bàn giao và nghiệm thu

Web giao migration + contract + fixture trước; n8n xác nhận contract rồi triển khai pipeline. Một dòng test đi từ Sheet tới dashboard, có thể truy ngược về nguồn và run đồng bộ. Chạy lại không tạo bản ghi trùng. Payload lỗi được từ chối hoặc cách ly có lý do. Không có secrets trong source/browser.

## 7. P1 — BoD Dashboard MVP

**Đầu vào:** P0 PASS. Grain R1 đã chốt: `source + business_date + project + recruiter + provider_type + employment_type = recruited_count`.

### Phạm vi báo cáo BoD (rebaseline theo nghiệp vụ thật)

- Tổng số người tuyển; theo ngày/khoảng ngày; theo dự án; theo người tuyển; theo HRP/Vendor; theo loại hình làm việc; **kết hợp** các chiều.
- Source coverage, freshness và trạng thái dữ liệu (per-source).
- Date range + filter lưu trên URL; responsive mobile/desktop; loading/empty/error rõ ràng.

### Ngoài phạm vi P1 (đã loại)

- Company → Team → Employee hierarchy; Employee daily result; Candidate drill-down.
- Dữ liệu cột D–I/M; KPI/target/commission/payroll; suy luận hoặc AI phân loại.

### Các bước bắt buộc

1. **P1-W01** — metric/filter/source-scope contract.
2. **P1-W02** — reporting query/read-model theo grain R1.
3. **P1-W03** — access gate pilot trước khi mở dữ liệu thật.
4. Overview dashboard BoD.
5. Báo cáo chi tiết theo project / recruiter / HRP-Vendor / employment type.
6. Date range/filter URL.
7. Data status/freshness/source coverage.
8. Cô lập fixture khỏi số liệu BoD.
9. Mobile/performance.
10. Đối soát tổng dashboard với DB.
11. Sau khi access/source scope ổn định: schedule mỗi 6 giờ + trigger bot `/sync` (cùng gọi ingestion workflow idempotent).

Không đổi contract v0.2 âm thầm; nếu P1 cần schema mới phải version/review riêng.

**Bảo mật P1:** bắt buộc access gate P1-W03 trước khi mở dữ liệu thật; không coi `PIPELINE_CHECK_ENABLED=true` là đủ an toàn cho URL public.

## 8. P2 — Data Platform & Reliability

**Đầu vào:** dữ liệu thật P1, lỗi thực tế và contract được bổ sung từ pilot.

### AI Coding Web

- Hoàn thiện employee/team/project/customer master và source registry.
- Hoàn thiện khóa định danh, constraints, staging/raw/facts và reporting aggregation khi cần.
- Đưa bối cảnh tổ chức theo thời gian vào mô hình từ đây hoặc sớm hơn; không đợi P3 mới bắt đầu lưu lịch sử.
- Tạo schema sync runs/errors/audit; UI xem trạng thái nguồn, freshness và data quality.
- Tối ưu reporting theo quy mô đo được; xác nhận quyền truy cập của view/RPC.

### AI Assistant n8n

- Đọc source registry động; bật/tắt/thêm nguồn bằng cấu hình.
- Ingestion theo mapping có version; incremental sync nếu nguồn hỗ trợ, kèm reconciliation định kỳ.
- Chống trùng và idempotency; xử lý dòng sửa/xóa theo chính sách đã duyệt.
- Retry có giới hạn, cách ly lỗi, xử lý lỗi credentials và nguồn không truy cập được.
- Theo dõi watermark/checkpoint; chỉ cập nhật checkpoint sau khi dữ liệu đã ghi thành công.
- Ghi source ID, run ID, raw reference/hash và change metadata; cảnh báo vận hành theo kênh cấu hình.

### Bàn giao và nghiệm thu

- Thêm một nguồn mới qua registry mà không sửa workflow chính hoặc code dashboard.
- Replay cùng dữ liệu không làm tăng kết quả; sửa dòng cập nhật đúng và có audit.
- Dòng lỗi không âm thầm biến mất hoặc biến thành 0; các nguồn hợp lệ vẫn xử lý được theo chính sách.
- Mô phỏng lỗi giữa run rồi chạy lại: không mất/trùng dữ liệu, checkpoint nhất quán.
- Có reconciliation cho thay đổi ở dòng cũ mà incremental sync bỏ sót.
- Dashboard thể hiện dữ liệu cũ/đồng bộ chưa hoàn tất, tránh hiểu là số liệu đã đầy đủ.
- Có hướng dẫn backup/restore và phục hồi workflow; kiểm tra phục hồi trên môi trường test.

Khả năng mở rộng là yêu cầu cấu hình và kiến trúc; số lượng nguồn thực tế hỗ trợ và lịch sync phải được kiểm chứng theo quota Google, năng lực VPS và DB.

## 9. P3 — Authentication + Organization + Permission

**Đầu vào:** danh sách người dùng, role, team membership/leader history và chính sách xem lịch sử được chủ dự án duyệt.

### AI Coding Web

- Supabase Auth, session phía server, login/logout và user–employee mapping.
- BoD: phạm vi công ty; Leader: team được phân công; Staff: bản thân.
- Tạo RLS/backend authorization cho tables, views, RPC và API; role quản lý ở nguồn tin cậy.
- UI phù hợp từng role; không dùng ẩn menu làm cơ chế bảo mật.
- Hoàn thiện lịch sử employee-team và leader-team với ngày hiệu lực.
- Cung cấp thao tác quản trị tối thiểu hoặc quy trình có kiểm soát để quản lý user/role/membership.

### AI Assistant n8n

- Map source → employee → organization chính xác; team lịch sử xác định theo business date.
- Duy trì sync độc lập với account login của nhân viên.
- Rà quyền credentials ingestion; thao tác đặc quyền chỉ trong workflow server đã kiểm soát.
- Kiểm tra pipeline vẫn chạy sau khi bật chính sách truy cập.

### Bàn giao và nghiệm thu

Kiểm tra ma trận role bằng truy cập trực tiếp API/DB và đổi filter URL, không chỉ bằng UI. Staff không xem người khác; Leader không xem ngoài phạm vi; user chưa được cấp quyền bị từ chối. BoD có báo cáo đúng scope.

Nhân viên chuyển team không làm thay đổi phân bổ kết quả lịch sử. Quyền Leader xem dữ liệu trước/sau thời điểm nhận team phải có quy tắc được duyệt và ca kiểm tra riêng; không mặc định mọi Leader hiện tại thấy toàn bộ lịch sử.

## 10. P4 — KPI & Performance

**Đầu vào:** định nghĩa KPI, target, kỳ đo, cách tính ngày làm việc và quyền sửa target đã được duyệt.

### AI Coding Web

- Mô hình KPI definitions, target assignments và lịch sử thay đổi có ngày hiệu lực/version.
- Form quản lý target tối thiểu; quyền nhập/sửa target tách khỏi quyền chỉ xem báo cáo.
- Công thức dùng chung ở DB/application: Actual, Target, Achievement, Remaining, Run Rate, Required Run Rate.
- So sánh MoM/QoQ/YoY và progress kỳ hiện tại theo quy tắc nhất quán.
- Dashboard Company/Team/Employee; lịch sử performance và drill-down.
- Xử lý target thiếu/0, kỳ chưa kết thúc, ngày còn lại bằng 0 và dữ liệu chưa đầy đủ.

### AI Assistant n8n

- Ingest target/KPI từ nguồn ngoài nếu quy trình yêu cầu; không ghi đè target do web quản lý.
- Refresh/aggregation/snapshot theo lịch khi có nhu cầu đã thống nhất.
- Validate nguồn KPI, theo dõi lỗi và gọi logic dùng chung; không sao chép công thức trong nodes.

### Bàn giao và nghiệm thu

Kết quả tính khớp bộ ví dụ nghiệp vụ đã duyệt và nhất quán giữa các dashboard. Target thiếu được thể hiện là chưa thiết lập; không biến thành 0% đạt. Kỳ so sánh ghi rõ so sánh toàn kỳ hay cùng tiến độ. Thay đổi target có người thực hiện, thời điểm và lý do; có thể giải thích báo cáo lịch sử.

Các công thức sơ bộ để chốt trong đặc tả:

- Achievement = Actual / Target × 100%, chỉ khi Target > 0.
- Remaining = max(Target − Actual, 0) với KPI tăng là tốt; KPI khác cần rule riêng.
- Run Rate = Actual / số ngày đã qua theo lịch đo thống nhất.
- Required Run Rate = Remaining / số ngày còn lại, chỉ khi số ngày còn lại > 0.
- Growth = (Current − Previous) / Previous × 100%, cần chính sách khi Previous = 0.

Đây chưa phải công thức nghiệp vụ đã phê duyệt. Không mặc định cộng tỷ lệ KPI hoặc cộng mọi target team/nhân viên thành target công ty.

## 11. Data contract và lịch sử

Contract được viết trước khi giao việc tích hợp của mỗi phase. Contract không cần khóa vĩnh viễn; mọi thay đổi phải có version và kế hoạch tương thích.

| Nội dung bắt buộc | Quy tắc |
|---|---|
| Định danh | Internal ID ổn định; employee code là business key theo quy tắc đã duyệt; không dùng tên người hoặc số hàng Sheet làm khóa lâu dài |
| Grain | Chốt một dòng là transaction, kết quả theo ngày hay grain khác; không gộp mất chi tiết nguồn trước khi được duyệt |
| Payload | Tên trường, kiểu, nullable/default, enum, valid/invalid examples |
| Nguồn | source ID, sheet/tab, stable record key, run ID và raw reference |
| Thời gian | Business date theo Asia/Ho_Chi_Minh; timestamp hệ thống lưu theo chuẩn UTC |
| Số/tiền | Đơn vị và độ chính xác rõ ràng; dùng decimal/numeric phù hợp cho tiền; không đoán định dạng số mơ hồ |
| Upsert | Unique key, quy tắc replay, revision và xử lý concurrent runs |
| Sửa/xóa | Chính sách explicit; không suy diễn mất dòng từ một lần đọc thất bại là xóa |
| Lỗi | Error code, reason, trạng thái cách ly và cách replay |
| Chỉ số | Định nghĩa Actual, bộ lọc hợp lệ, kỳ và nguyên tắc aggregation |
| Lịch sử | Membership theo hiệu lực, target versions, change audit và chính sách sửa dữ liệu nguồn |

Để mở đường cho Commission/Payroll, V1 giữ ID ổn định, business date, dữ liệu chi tiết phù hợp nguồn, project/employee linkage, lịch sử tổ chức và audit. Không tạo sẵn các bảng tính hoa hồng/lương hoặc triển khai engine tương lai.

## 12. Cách phối hợp và bàn giao

1. Chủ dự án xác nhận nghiệp vụ và dữ liệu mẫu.
2. Web đề xuất schema/migration + contract; n8n review mapping/ghi dữ liệu.
3. Thống nhất contract và fixture; mỗi Agent triển khai phần của mình.
4. n8n giao dữ liệu/run logs; Web giao reporting/UI và cách kiểm tra.
5. Cả hai đối soát end-to-end; ghi lỗi, sửa và kiểm tra lại phần bị ảnh hưởng.
6. Chủ dự án nghiệm thu gate; cập nhật baseline nếu scope thay đổi.

Mỗi task giao sau master plan phải có: **Task ID, owner, dependency, input, output, acceptance criteria, phần được phép sửa và handoff cho Agent còn lại**.

Gói bàn giao Web: code commit, migrations, contract version, env mẫu, hướng dẫn chạy và bằng chứng kiểm tra. Gói bàn giao n8n: workflow export, mapping version, danh sách credentials cần cấu hình, lịch chạy, log mẫu và hướng dẫn retry/recovery. Không kèm giá trị secrets.

Khi đổi contract: nêu lý do/tác động → Web tạo migration và cập nhật fixture → n8n điều chỉnh workflow → kiểm tra DEV → triển khai theo thứ tự tương thích → đối soát. Không sửa nóng schema PROD ngoài quy trình migration.

## 13. Các quyết định cần chốt trước khi triển khai

| Quyết định | Cần trước | Tác động |
|---|---|---|
| Kết quả kinh doanh đo gì: doanh thu, số người, số giao dịch hay chỉ số khác | Contract P0/P1 | Fact grain, cards và aggregation |
| Mẫu Sheet, định danh dòng, cách sửa/xóa và chất lượng dữ liệu | P0 | Mapping, upsert, reconciliation |
| Nguồn pilot, tổng nguồn và khối lượng/lịch cập nhật | P1/P2 | Sync schedule và performance |
| Đầu tuần, timezone, lịch làm việc, so sánh kỳ chưa kết thúc | P1/P4 | Filter và KPI |
| Nhân viên làm nhiều team/project; leader quản lý nhiều team | P2/P3 | Membership và scope |
| Chính sách xem lịch sử sau chuyển team/leader | P3 | RLS và truy vấn lịch sử |
| KPI, quyền sửa target và cách giữ lịch sử target | P4 | Công thức và workflow |
| Kênh cảnh báo, người vận hành, thời hạn lưu raw/log và mức freshness mong muốn | P2 | Vận hành và lưu trữ |

Các mục này là backlog quyết định, không phải giả định đã được xác nhận. Hai Agent không tự đặt business rule khi thiếu quyết định; ghi câu hỏi cùng đề xuất và tiếp tục phần không phụ thuộc.

## 14. Rủi ro và cách xử lý

| Rủi ro | Biện pháp trong V1 |
|---|---|
| Sheet khác mẫu, số/ngày mơ hồ | Mapping version, validation, cách ly và mẫu nhập thống nhất |
| Replay hoặc lỗi giữa run gây trùng | Stable key, idempotency, checkpoint và đối soát |
| Dữ liệu sửa ở dòng cũ bị bỏ sót | Reconciliation định kỳ ngoài incremental sync |
| Chuyển team làm sai lịch sử | Membership theo hiệu lực và phân bổ theo business date |
| Dashboard có số nhưng nguồn chưa cập nhật đủ | Last successful sync, completeness/freshness status |
| UI và n8n tính KPI khác nhau | Một implementation nghiệp vụ dùng chung |
| Lộ dữ liệu trước P3 hoặc qua view/API | Truy cập pilot có kiểm soát; kiểm tra quyền từ backend |
| Hai Agent sửa schema lệch nhau | Web sở hữu migrations; contract version và integration gate |
| Scope trượt sang hoa hồng/lương/admin toàn diện | Giữ danh sách ngoài scope; thay đổi phải cập nhật baseline |

## 15. Definition of Done — V1

V1 hoàn thành khi P0–P4 đều được nghiệm thu và:

- BoD/Leader/Staff dùng được báo cáo đúng phạm vi trên mobile và desktop.
- Kết quả và KPI khớp bộ đối soát; có thể truy nguồn và giải thích công thức.
- Thêm nguồn/nhân viên/team/project không cần đổi kiến trúc hoặc hard-code.
- Sync có chống trùng, xử lý lỗi, quan sát tình trạng và phục hồi đã được kiểm tra.
- RLS/API được kiểm tra cả ca được phép và bị từ chối; secrets không lộ ra frontend.
- Lịch sử tổ chức, dữ liệu và target được xử lý theo chính sách đã duyệt.
- Có code/workflow/migrations/contract và hướng dẫn triển khai, vận hành, backup/restore.
- Không có Commission/Payroll trong tính năng V1.

## 16. Tài liệu chi tiết ở bước tiếp theo

Master plan này là điểm tham chiếu cho các tài liệu sẽ viết sau:

- `data-contract.md`: schema logic, payload, grain, lịch sử, chỉ số và error contract.
- `phase-0-plan.md` đến `phase-4-plan.md`: task IDs, dependencies, deliverables và nghiệm thu.
- `agent-web-brief.md` / `agent-n8n-brief.md`: prompt giao việc cho từng Agent.
- `acceptance-checklist.md`: bộ đối soát dữ liệu, ma trận quyền và ví dụ tính KPI.
- `operations-runbook.md`: sync monitoring, retry, incident handling và phục hồi.

Các file trên chưa được tạo trong bước này. Ưu tiên tiếp theo là chốt dữ liệu mẫu và contract P0/P1, rồi chia task chi tiết cho hai Agent.
