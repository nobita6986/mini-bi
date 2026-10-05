# Direct Entry → Reporting Reconciliation Contract — DRAFT v0.1

| Property | Value |
|---|---|
| Contract version | `direct-entry-reporting-reconciliation/0.1` (DRAFT) |
| Status | **DRAFT** — chưa phải Owner-approved contract; đang chờ P1.7 J01 + quyết định Owner/T0 |
| Task | P2-C01A — draft Direct Entry → reporting reconciliation contract |
| Base when drafted | `origin/main @ 27309ba295696b40ad97117e136d621a08265a29` |
| Companion rebaseline | `docs/handoffs/p2-r00-readiness-audit.md`, `docs/roadmaps/p2-post-direct-entry-rebaseline.md` |
| Companion P1 reporting | `p1-reporting/0.1` (`docs/contracts/p1-reporting-v0.1.md`) |
| Companion P1 ingestion | `daily-recruitment-breakdown/0.2` (`docs/contracts/daily-recruitment-breakdown-v0.2.md`) |
| Companion P1.6 lifecycle | `direct-entry/1.1` (`docs/contracts/p1.6-direct-entry-v1.md`) |
| Scope | Đối chiếu **tổng tuyển** và các chiều phân loại giữa Direct Entry (canonical) và dashboard read model (aggregate cũ) sau khi P1.7 đóng; **không** kéo bank/payment/CCCD/personal data vào phạm vi báo cáo |
| Out of scope (phải giữ) | Bank/payment PII · CCCD document lineage · employment status event sequencing · payroll/KPI/commission/target · role/RBAC policy (thuộc P3) |
| Runtime impact | **Tài liệu + truy vấn reconciliation dạng doc only.** Không sửa code, migration, RPC, view, package, lockfile, env, workflow, hay Production DB. |
| Reporting read model hiện đọc từ | `public.daily_recruitment_breakdown` (aggregate) + `public.data_sources` + `public.sync_runs` + `public.reporting_latest_sync_runs_v01` + `public.reporting_sources_with_current_facts_v01` + `public.reporting_dimension_options_view` |
| Direct Entry canonical nguồn dự kiến | `public.direct_entry_submissions` (state `SUBMITTED`) · `public.direct_entries` · `public.direct_entry_employment_status_events` (initial `UNCONFIRMED`/`ON`) · `public.recruiters` · `public.teams` · `public.recruiter_aliases` · `public.recruiter_provider_memberships` · `public.recruiter_team_memberships` · `public.direct_entry_projects` |

---

## 0. Tại sao cần contract này

Sau P1.7 J01, **Direct Entry trở thành canonical transaction source** cho dữ liệu tuyển dụng mới (xem `docs/handoffs/p2-r00-readiness-audit.md` E-01, E-05 và `docs/roadmaps/p2-post-direct-entry-rebaseline.md` §"Decision summary" 1). Read model dashboard hiện vẫn đọc từ `public.daily_recruitment_breakdown` — bảng aggregate được publish từ Google Sheets theo contract `daily-recruitment-breakdown/0.2` (xem P2-R00 E-04, F-04). Hai nguồn có **semantics khác nhau** và **không thể cộng trực tiếp** mà không có contract đối chiếu.

Contract này **chưa** xác nhận cutover. Nó chỉ khoá:

1. grain, metric, ngày ghi nhận;
2. quy tắc "không double-count" giữa aggregate cũ và Direct Entry mới;
3. truy vấn reconciliation có thể chạy sau khi P1.7 J01 đóng;
4. danh sách quyết định Owner/T0 còn cần trước khi freeze.

> **Tuyên bố trung thực:** Tài liệu này soạn dựa trên source-verify ngày 2026-10-05 tại `27309ba`. Nó **không** tuyên bố P2 PASS, cutover ready, hay Production ready.

---

## 1. Source-verify (đã đọc, chưa chạm runtime)

### 1.1. Reporting read model hiện hành (aggregate)

| Bảng / View | Schema | Vai trò trong reporting | Nguồn dữ liệu |
|---|---|---|---|
| `public.daily_recruitment_breakdown` | `20261001130100_p0_daily_recruitment_breakdown_foundation.sql` | Bảng fact dashboard; grain = `source_id + business_date + project_key + recruiter_key + provider_type_key + employment_type_key = recruited_count` | RPC `replace_daily_recruitment_breakdown_snapshot_v02` publish từ Google Sheets (Sheet ingestion — đã retire) |
| `public.data_sources` | P0 | Mỗi source = 1 Google Sheet (`drive_file_id` UNIQUE) | RPC snapshot upsert theo `drive_file_id` |
| `public.sync_runs` | P0 | Lịch sử run của mỗi source; `status` ∈ {`running`,`succeeded`,`partial`,`failed`} | RPC snapshot / failure |
| `public.reporting_latest_sync_runs_v01` | `20261001150100` | View service-role-only: latest run cho mỗi source (order: `started_at DESC, run_id DESC`) | Đọc `sync_runs` |
| `public.reporting_sources_with_current_facts_v01` | `20261001150200` | View service-role-only: `DISTINCT source_id` có ≥1 fact hiện hành | Đọc `daily_recruitment_breakdown` |
| `public.reporting_dimension_options_view` | `20261001150300` | Dropdown options cho filter UI | Đọc aggregate keys |

Server side: `src/lib/reporting/p1-reporting-server.ts` đọc các view trên + `daily_recruitment_breakdown` theo contract `p1-reporting/0.1`. Filter contract: `from/to/project/recruiter/provider/employment/source` — date range inclusive, dimension filters kết hợp AND (xem `p1-reporting-v0.1.md` §6).

### 1.2. Direct Entry canonical (P1.6 + P1.7)

| Bảng | Schema | Vai trò canonical | Ghi chú |
|---|---|---|---|
| `public.direct_entry_submissions` | `20261002170000_p1_6_direct_entry_foundation.sql` | Submission batch; state `DRAFT`/`REVIEW`/`SUBMITTED`; chỉ `SUBMITTED` mới là business fact | `submitted_at` set cùng `state = SUBMITTED` (CHECK constraint) |
| `public.direct_entries` | Cùng migration | Một dòng = một entry trong submission; soft delete qua `deleted_at` | Cột canonical: `submission_id`, `candidate_id`, `created_by_user_id`, `project_id`, `first_work_date`, `employee_code`, `worker_details` (jsonb), `recruiter_id`, `team_id`, `provider_type`, `labor_type`; `version`, `created_at`, `updated_at`, `deleted_at` |
| `public.direct_entry_employment_status_events` | Cùng migration | Append-only status events: `UNCONFIRMED`/`ON`/`OFF`; current status = latest applied event theo `version DESC` | `supersedes_event_id` chain; correction chỉ áp dụng cho latest event |
| `public.recruiters` | Cùng migration | Master `recruiter_id`; ổn định, không rekey | Effective inactive = `active=false` |
| `public.recruiter_aliases` | Cùng migration | Lịch sử reporting key theo effective date (half-open `[valid_from, valid_to)`) | Dùng để map display name ở dashboard → master `recruiter_id` |
| `public.recruiter_provider_memberships` | Cùng migration | Effective provider (`hrp`/`vendor`) theo date | Unique overlap rejected bởi CHECK (qua `unique (recruiter_id, valid_from)` + interval CHECK) |
| `public.recruiter_team_memberships` | Cùng migration | Effective team theo date | Cùng cơ chế |
| `public.teams` | Cùng migration | Master `team_id` | |
| `public.direct_entry_projects` | Cùng migration | Project master; `project_id text` PK; `display_name` | |
| `public.direct_entry_payments` | Cùng migration | 4 trạng thái (`omitted`/`unknown`/`intentionally_blank`/`provided`) | **NGOÀI phạm vi reporting** — không kéo bank/payment vào contract này |
| `public.direct_entry_document_versions` / `direct_entry_document_events` | Cùng migration | CCCD/employment contract documents | **NGOÀI phạm vi reporting** — không kéo document lineage vào |

P1.7 bổ sung:
- `public.direct_entry_list_own_drafts(uuid, uuid)` (P1.7-W03A, `20261006010000`) — projection draft cho UI; **không phải** reporting source.
- `20261007010000_p1_7_h03_server_employee_codes.sql` — cấp mã NLĐ phía server; ảnh hưởng `direct_entries.employee_code` (chỉ server mới ghi).
- `direct_entry_authorization_date()` trả `(statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date` — dùng cho mọi kiểm tra "hôm nay là ngày nào ở HCM" trong reporting reconciliation (tránh phụ thuộc server timezone).

### 1.3. Định nghĩa dữ liệu tính vào reporting

Dựa trên `direct-entry/1.1` §4–§5:

| Trạng thái submission | Trạng thái status event | Tính vào reporting tổng tuyển? | Lý do |
|---|---|---|---|
| `DRAFT` | bất kỳ | **Không** | Chưa published; có thể bị xóa/sửa. |
| `REVIEW` | bất kỳ | **Không** | Read-only, chờ quyết định gửi. |
| `SUBMITTED` | `UNCONFIRMED` (initial) | **Có** | Initial event luôn `UNCONFIRMED`; đây là fact canonical của entry. |
| `SUBMITTED` | `ON` (đã áp dụng) | **Có** (chỉ vào các metric tổng tuyển mới) | Status event là correction/super-session, không thay đổi fact "đã tuyển" của entry. |
| `SUBMITTED` | `OFF` (đã áp dụng) | **Có** với metric tuyển mới; **tách riêng** tỷ lệ OFF trong report `w04` (xem §3) | OFF không có nghĩa hủy entry; cần tránh trừ khỏi `recruited_total`. |
| `SUBMITTED` + `deleted_at IS NOT NULL` | bất kỳ | **Không** | Soft delete loại bỏ entry khỏi fact table; retained chỉ qua audit/revisions. |

Một "lần tuyển" = 1 `direct_entries` row với `submission.state = 'SUBMITTED' AND deleted_at IS NULL` tính tại `first_work_date`.

### 1.4. Cách project / recruiter / HRP-Vendor / team / labor / effective date lưu

- **Project** — `direct_entries.project_id` FK → `direct_entry_projects.project_id text` (PK).
- **Recruiter** — `direct_entries.recruiter_id` FK → `recruiters.recruiter_id uuid`.
- **HRP/Vendor** — `direct_entries.provider_type text` ∈ {`hrp`,`vendor`}; CHECK constraint.
- **Team** — `direct_entries.team_id` FK → `teams.team_id uuid`. Selection hợp lệ = team membership còn hiệu lực tại `first_work_date` (half-open `[valid_from, valid_to)`).
- **Labor type** — `direct_entries.labor_type` ∈ {`TEMPORARY`,`PERMANENT`}. Mapping sang reporting dimension `employment_type`: `TEMPORARY` → `Thời vụ`, `PERMANENT` → `Chính thức` (cùng giá trị key với `daily-recruitment-breakdown/0.2` §5.1, để có thể đối chiếu).
- **Effective date** — `first_work_date` (canonical). Status events dùng `effective_date` riêng (≥ `first_work_date`).
- **Recruiter historical attribution** — `recruiter_id` trên entry là **giá trị tại thời điểm ghi**; để tái dựng fact theo "người tuyển tại ngày tuyển" cần resolve qua `recruiter_aliases` (xem §3.4).
- **Recruiter reporting key** — alias `recruiter_aliases.reporting_key` (lower-cased, NFC, trim, gộp khoảng trắng) dùng để map display name ở dashboard cũ.

### 1.5. Google Sheets / n8n — không còn là ingestion mặc định

- `replace_daily_recruitment_breakdown_snapshot_v02` vẫn tồn tại nhưng chỉ là API history; WF01 runbook (`automation/n8n/docs/p0-t2-wf01-runbook.md`) mô tả là **Draft/manual, không schedule, DEV-only service role** (xem P2-R00 E-06, F-06). Từ P1.6 trở đi không có nguồn Sheets nào được publish `succeeded` ngoài fixture.
- `daily_recruitment_counts` (v01) đã retire (migration `20261001130000`); không còn pipeline v01 song song.
- Theo `p2-post-direct-entry-rebaseline.md` §"Capability decisions", N02–N04/N06 **không** build dispatcher Sheet định kỳ; nguồn ngoài Direct Entry chỉ được add khi N01 tìm ra và Owner duyệt.

**Kết luận:** Trong contract reconciliation này, "nguồn Sheets" = `daily_recruitment_breakdown` aggregate, đã được publish **từ trước P1.6**. Aggregate hiện hành **không nhận thêm dòng mới** từ Sheets; nó chỉ phình lên nếu vẫn còn source `active` được Owner duyệt replay (xem §4 quyết định còn cần).

---

## 2. Hợp đồng dự thảo (chưa phải final)

### 2.1. Grain của từng dòng báo cáo

**Aggregate cũ (giữ nguyên `p1-reporting/0.1`):**

```
grain_old = (source_id, business_date,
             project_key, recruiter_key,
             provider_type_key, employment_type_key)
         -> recruited_count
```

**Direct Entry projection (DRAFT):**

```
grain_new = (first_work_date,
             project_id, recruiter_id,
             team_id, provider_type, labor_type)
         -> 1 entry
```

Vì Direct Entry có 1 entry = 1 người nên **mỗi entry tạo ra một dòng projection ở grain_new với `recruited_count = 1`**. Khi cộng vào dashboard, áp dụng cùng normalization key (`NFC → trim → gộp whitespace → lowercase`) để project/recruiter/employment match cùng bucket.

> **Quyết định cần Owner (xem §4):** Có dùng `recruiter_id` (UUID) trong reporting key không, hay map ngược về `recruiter_aliases.reporting_key` để **giữ** bucket hiện hành? Mặc định an toàn: dùng alias key hiện tại, vì dashboard cũ đã nhóm theo display name; UUID mới sẽ phá bucket.

### 2.2. Metric & ngày ghi nhận

| Metric | Definition (DRAFT) | Aggregate cũ | Direct Entry |
|---|---|---|---|
| `recruited_total` | tổng số người đã tuyển (canonical) trong filter scope | `sum(daily_recruitment_breakdown.recruited_count)` của source trong scope | `count(*)` của projection rows với `state = SUBMITTED AND deleted_at IS NULL` trong filter scope |
| `recruited_by_date` | theo `business_date` (cũ) / `first_work_date` (mới) | `business_date` | `first_work_date` |
| `byProject` / `byRecruiter` / `byProvider` / `byEmployment` | breakdown chiều | theo `*_key` chuẩn hóa | theo normalized key (xem §3.1) |
| `project_provider_mix` | HRP/Vendor ratio theo dự án | từ aggregate | từ projection rows (không migration/view mới) |
| `coverage` | tỷ lệ source đã từng có snapshot | từ `data_sources + sync_runs` | chuyển sang: tỷ lệ entry theo status event có hiệu lực vs. toàn scope (xem §3.5) |
| `source_status` | trạng thái từng nguồn | từ `data_sources.latest_run_status` | **không áp dụng** cho Direct Entry (Direct Entry không phải "nguồn" theo nghĩa Sheets) |
| `freshness` | `last_successful_sync_at` | từ source run | từ `max(submitted_at)` của submission gần nhất (xem §3.5) |

**Quy tắc ngày ghi nhận:**

- `first_work_date` của entry là ngày canonical cho mọi `recruited_*` metric.
- `submitted_at` chỉ ảnh hưởng `freshness`, không ảnh hưởng `recruited_by_date` (tránh đếm trùng khi submit trễ so với `first_work_date`).
- Status event `effective_date` không tạo thêm dòng `recruited_*`; chỉ thay đổi derived status (UNCONFIRMED/ON/OFF) cho entry đã có.

### 2.3. Quy tắc cutoff giữa lịch sử aggregate cũ và Direct Entry

> Quy tắc này **chỉ có hiệu lực khi Owner chốt cutoff** (xem §4 quyết định 1). Draft:

```
cutoff_date = :owner_approved_cutoff_date   (YYYY-MM-DD, Asia/Ho_Chi_Minh)
```

| Khoảng | Nguồn canonical | Bảng aggregate cũ | Direct Entry |
|---|---|---|---|
| `business_date < cutoff_date` | Aggregate cũ (`daily_recruitment_breakdown`) | dùng để hiển thị + đối chiếu | **không đụng** |
| `business_date = cutoff_date` | cả hai nguồn (transition) | dùng aggregate cũ + đối chiếu 2 phía | dùng Direct Entry |
| `business_date > cutoff_date` | Direct Entry | **không dùng** (loại khỏi result) | dùng để hiển thị |

**Quy tắc "không double-count" tuyệt đối:**

1. Trong mọi filter, nếu `business_date >= cutoff_date` thì **`recruited_count` của `daily_recruitment_breakdown` bị mask về `0`** (xem §3.2 truy vấn). Không trừ, không âm — chỉ loại khỏi sum.
2. Tương tự, nếu `first_work_date < cutoff_date` thì Direct Entry rows có `first_work_date < cutoff_date` **không được tính** vào projection metric. Aggregate cũ giữ vai trò canonical cho khoảng này.
3. Cutoff có thể là inclusive hoặc exclusive ở đầu `cutoff_date`. Draft mặc định: **aggregate cũ inclusive, Direct Entry exclusive** tại `cutoff_date` (giảm nguy cơ đếm trùng ngày boundary). Owner quyết.
4. Không có "transition overlap" trong metric; chỉ có trong audit/reconciliation diff.

### 2.4. Quy tắc "tuyệt đối không double-count"

Áp dụng cùng với §2.3:

- Một `direct_entries` row `SUBMITTED + deleted_at IS NULL` **chỉ** đếm một lần duy nhất trong `recruited_total`, bất kể nó xuất hiện bao nhiêu lần trong `daily_recruitment_breakdown` (do bị import trùng từ Sheets trước đó, hoặc do lỗi keying).
- `sum(recruited_count_new) for first_work_date < cutoff_date = 0` ⇒ không thêm gì vào metric.
- `sum(recruited_count_old) for business_date >= cutoff_date = 0` ⇒ aggregate bị mask, không cộng vào metric.
- Không union hai tập theo `business_date == first_work_date` ở bất kỳ vị trí nào trong pipeline production. Reconciliation report (xem §3) có thể hiển thị overlap để debug, nhưng **không** đi vào dashboard.
- Status `OFF` không trừ khỏi `recruited_total`. Chỉ tách sang metric phụ `off_total` nếu Owner yêu cầu (xem §3.3).

### 2.5. Sửa dữ liệu, version, correction, dữ liệu đến muộn

| Sự kiện | Cách xử lý trong projection | Cách audit/lineage |
|---|---|---|
| Owner/Accounting direct edit trên `direct_entries` (qua W05 privileged edit) | Update row in-place; `version++`; cột đã sửa xuất hiện trong audit row | `direct_entry_audit_events` (foundation) ghi actor, reason, expected_version, version, changed fields |
| Change request (P1.6) được approve | Append `direct_entry_change_request_items` row; apply atomic; `version++` | `change_request_events` lưu decision, reason, reviewer; revision snapshot |
| Status event correction (`OFF` → `ON`, v.v.) | Append event mới với `supersedes_event_id`; `version++` | `direct_entry_employment_status_events` chain; latest event bằng `max(version)` |
| Entry soft delete (`deleted_at IS NOT NULL`) | Loại khỏi projection; `version++` | `direct_entry_audit_events` ghi deletion |
| Submission `SUBMITTED` rồi Owner quyết định import lại từ Sheets | **Không xảy ra** theo contract: Direct Entry **không** rewrite aggregate cũ; aggregate cũ không thêm `recruited_count` sau P1.6. Nếu cần, đi qua change request | n/a |
| Late-arriving entry (`first_work_date` đã qua cutoff khi submit) | Vẫn tính nếu `state = SUBMITTED` tại thời điểm snapshot; nếu `first_work_date < cutoff_date` thì bị mask bởi §2.3 | audit row vẫn ghi; reconciliation chỉ ra diff để Owner đánh giá |
| Backdated correction (sửa `first_work_date` từ `T2` thành `T1 < T2`) | Atomic update; entry re-bucket sang ngày `T1`; `recruited_by_date` cập nhật tương ứng | revision snapshot; audit row ghi trước/sau |

**Nguyên tắc:** Direct Entry dùng **optimistic version + append-only audit** (theo `direct-entry/1.1` §4). Mọi thay đổi canonical đều phải có expected version; stale version = `409` = không thay đổi gì. Reconciliation diff **không** tự sửa; chỉ báo cáo.

### 2.6. Attribution project / recruiter / provider / team

Theo `direct-entry/1.1` §1, attribution của Direct Entry tại `first_work_date`:

- `recruiter_id` trên `direct_entries` là **giá trị đã chọn** tại submit; **không** tự dò ngược qua `app_user_recruiter_links`.
- `team_id` = team membership còn hiệu lực tại `first_work_date`; CHECK constraint ngăn overlap.
- `provider_type` = `hrp`/`vendor`; derive từ membership; payload chỉ cross-check.

Khi so với aggregate cũ:

- Aggregate cũ lưu `recruiter_display` (text đã chuẩn hóa). Để đối chiếu, lấy `recruiter_aliases.reporting_key` tại `first_work_date` (half-open `[valid_from, valid_to)`) → map sang alias key → so với `recruiter_key` trong aggregate. Nếu `recruiter_id` chưa có alias tại `first_work_date`, bucket của entry sẽ nằm riêng trong `__unknown__` (xem `p1-reporting/0.1` §2.3) cho đến khi Owner cập nhật alias.
- `team` không có trong aggregate cũ (chỉ có ở P1.6). Khi chuyển sang projection, team **chỉ xuất hiện nếu Owner yêu cầu mở rộng dimension** (xem §4 quyết định 6).
- `provider_type` mapping: `hrp` → `HRP` (display) / `hrp` (key); `vendor` → `Vendor` / `vendor`. Cùng giá trị với `daily-recruitment-breakdown/0.2` §5.1.
- `project_id` (text) → `project_key` lowercase NFC theo cùng `recruitment_dimension_key()`.
- `labor_type` → `employment_type` mapping: `TEMPORARY` → `thời vụ`; `PERMANENT` → `chính thức`. Cùng key với aggregate cũ.

### 2.7. Lineage, coverage, freshness

| Signal | Aggregate cũ | Direct Entry (DRAFT) |
|---|---|---|
| **Lineage** | `sync_run_id` + `snapshot_at` trên mỗi dòng aggregate; truy từ `sync_runs` | `submission.submitted_at` + `direct_entries.version` + `direct_entry_audit_events`; truy từ submission |
| **Coverage (legacy)** | `sources_expected / sources_succeeded / coverage_ratio` theo §2.4 của `p1-reporting/0.1` | **không còn áp dụng** — Direct Entry không phải source Sheet. Coverage được thay bằng §3.5 dưới |
| **Coverage (new)** | n/a | `entries_submitted / entries_submitted_in_scope` theo §3.5 |
| **Freshness (legacy)** | `last_successful_sync_at` per source | n/a (không có source Sheet nào chạy) |
| **Freshness (new)** | n/a | `max(direct_entry_submissions.submitted_at) WHERE state='SUBMITTED'` cho reporting scope; báo stale nếu > 24h không có submission mới (threshold là quyết định P2-W05, **không** freeze trong contract này) |
| **Status flags** | `data_sources.latest_run_status` ∈ {`running`,`succeeded`,`partial`,`failed`,`no_run`} | `submissions.recent_state` ∈ {`none_in_24h`,`healthy`} (DRAFT, chờ Owner) |

**Lineage trong reconciliation report (DRAFT):** mỗi dòng diff phải có:

- `(business_date_old, business_date_new)` aligned;
- `recruited_count_old`, `recruited_count_new`, `delta`;
- `source_id` (cũ) + `submission_id`/`entry_id` (mới) nếu liên kết được;
- `audit_event_id` nếu có.

### 2.8. Phạm vi CHẮC CHẮN NGOÀI contract này

Các mục sau **không** nằm trong reconciliation contract và bị khóa để tránh mở rộng ngầm:

- Số tài khoản, tên ngân hàng, tên chủ tài khoản (PII tài chính — thuộc PII boundary).
- CCCD/CMND/hộ chiếu plaintext (PII nhân sự).
- Số điện thoại, ngày sinh, địa chỉ, ghi chú (PII nhân sự).
- Employment status sequencing (UNCONFIRMED → ON → OFF) — chỉ xuất hiện như một dòng `status_summary` riêng ở §3.3 nếu Owner yêu cầu.
- Document lineage (CCCD_FRONT, CCCD_BACK, EMPLOYMENT_CONTRACT).
- KPI / target / commission / payroll.
- Role/RBAC (thuộc P3).

Mọi truy vấn reconciliation dưới đây đều **chỉ chọn các cột** sau (theo `p1-reporting/0.1` §1):

```
date_dim, project_key/display, recruiter_key/display,
provider_type_key/display, employment_type_key/display,
recruited_count (cũ) | entry_count (mới), source_id (cũ) | submission_id (mới)
```

Không truy vấn `worker_details.*`, `direct_entry_payments.*`, `direct_entry_document_versions.*` trong reporting/reconciliation context.

---

## 3. Truy vấn reconciliation (chạy SAU khi P1.7 đóng, không chạy trong task này)

> **Cảnh báo:** Các truy vấn dưới đây là **tài liệu**, không chạy trên Production. Khi P1.7 J01 đóng, Owner/N8N sẽ chạy từng cái một trên staging hoặc read-only Production replica (tùy quyết định của T0) theo thứ tự. Mỗi truy vấn có **điều kiện PASS/FAIL rõ ràng**; tổng hợp ở §3.6.

### 3.1. Grain & normalization consistency

```sql
-- 3.1.a: Project key normalization check (Direct Entry side)
--   Mục đích: xác nhận mọi project_id có thể map sang project_key giống aggregate cũ
--   PASS: mọi direct_entries.project_id đều có recruiter_dimension_key(display_name) khớp
--         với daily_recruitment_breakdown.project_key từ các source thuộc scope cũ
--   FAIL: có project mới không khớp (bucket bị tách)

with de_projects as (
  select distinct e.project_id, p.display_name
    from public.direct_entries e
    join public.direct_entry_projects p on p.project_id = e.project_id
   where e.deleted_at is null
     and exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = e.submission_id and s.state = 'SUBMITTED'
     )
),
old_projects as (
  select distinct project_key, project_display
    from public.daily_recruitment_breakdown
)
select dp.project_id, dp.display_name,
       op.project_key is not null as in_old_breakdown,
       case when op.project_key is not null
            then op.project_key = lower(btrim(regexp_replace(normalize(dp.display_name, NFC), '\s+', ' ', 'g')))
            else null end as key_matches_old
  from de_projects dp
  left join old_projects op
    on op.project_key = lower(btrim(regexp_replace(normalize(dp.display_name, NFC), '\s+', ' ', 'g')))
 order by in_old_breakdown asc, dp.project_id;
```

PASS nếu `key_matches_old` không NULL; FAIL nếu có dòng NULL = project mới hoàn toàn (Owner cần chấp nhận "Không xác định" bucket hoặc tạo alias).

```sql
-- 3.1.b: Recruiter alias coverage at first_work_date
--   Mục đích: xác nhận mọi entry có recruiter_aliases.reporting_key tại first_work_date
--   PASS: mọi entry có alias
--   FAIL: thiếu alias -> entry bị nhóm về __unknown__ ở projection

select e.entry_id, e.first_work_date, e.recruiter_id, r.display_name,
       case
         when exists (
           select 1 from public.recruiter_aliases a
            where a.recruiter_id = e.recruiter_id
              and a.valid_from <= e.first_work_date
              and (a.valid_to is null or e.first_work_date < a.valid_to)
         ) then 'OK' else 'MISSING_ALIAS'
       end as alias_status
  from public.direct_entries e
  join public.recruiters r on r.recruiter_id = e.recruiter_id
 where e.deleted_at is null
   and exists (
     select 1 from public.direct_entry_submissions s
      where s.submission_id = e.submission_id and s.state = 'SUBMITTED'
   )
 order by alias_status, e.first_work_date, e.entry_id;
```

PASS nếu `alias_status = 'OK'` cho mọi dòng; FAIL nếu có bất kỳ `MISSING_ALIAS` nào → Owner cần Owner-managed backfill trước cutover (xem §4 quyết định 5).

### 3.2. Cutoff mask + no-double-count sanity

```sql
-- 3.2.a: Aggregate-side mask at cutoff
--   Mục đích: xác nhận công thức mask aggregate khi business_date >= cutoff_date
--   (KHÔNG mutate; chỉ SELECT để kiểm tra sum về 0)
--   PASS: count của masked_rows = count của total rows khi cutoff = 'infinity'
--   FAIL: mask logic đụng lệch khi apply với cutover thật

with params as (
  select date '9999-12-31' as cutoff  -- placeholder; thay bằng cutoff thật
)
select
  sum(case when business_date <  p.cutoff then recruited_count else 0 end) as old_in_range,
  sum(case when business_date >= p.cutoff then recruited_count else 0 end) as old_after_cutoff,
  count(*) filter (where business_date <  p.cutoff) as old_rows_in_range,
  count(*) filter (where business_date >= p.cutoff) as old_rows_after_cutoff
  from public.daily_recruitment_breakdown, params p;
```

PASS: `old_after_cutoff = 0` khi `cutoff = 'infinity'`; FAIL: dương → mask logic sai.

```sql
-- 3.2.b: Direct Entry side: chỉ tính submission SUBMITTED + deleted_at IS NULL
--   Mục đích: xác nhận metric tổng từ Direct Entry

with de_eligible as (
  select e.*
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'SUBMITTED'
     and e.deleted_at is null
)
select count(*) as de_eligible_entries,
       count(distinct first_work_date) as de_distinct_dates,
       min(first_work_date) as de_min_date,
       max(first_work_date) as de_max_date
  from de_eligible;
```

PASS: số đếm khớp với số dòng audit; FAIL: lệch → kiểm tra soft delete / state.

### 3.3. Day-level diff (cùng date range, hai nguồn cộng trừ)

```sql
-- 3.3.a: Day-level diff per dimension (DRAFT, dùng cho reconciliation report — KHÔNG vào dashboard)
--   PASS: với cutoff đã chốt, mọi ngày có |old_in_range - de_in_range| == 0 (chỉ trong khoảng overlap test)
--   FAIL: lệch có ý nghĩa -> backfill / rekey / cutover adjustment cần Owner

with params as (
  select date '2026-09-01' as from_date,
         date '2026-12-31' as to_date,
         date '9999-12-31' as cutoff  -- placeholder
),
old_agg as (
  select business_date,
         project_key, recruiter_key, provider_type_key, employment_type_key,
         sum(recruited_count) as old_count
    from public.daily_recruitment_breakdown, params p
   where business_date between p.from_date and p.to_date
     and business_date <  p.cutoff   -- mask sau cutoff
   group by 1,2,3,4,5
),
de_agg as (
  select e.first_work_date as business_date,
         lower(btrim(regexp_replace(normalize(p.display_name, NFC), '\s+', ' ', 'g'))) as project_key,
         coalesce((
           select a.reporting_key
             from public.recruiter_aliases a
            where a.recruiter_id = e.recruiter_id
              and a.valid_from <= e.first_work_date
              and (a.valid_to is null or e.first_work_date < a.valid_to)
            order by a.valid_from desc limit 1
         ), '__unknown__') as recruiter_key,
         e.provider_type as provider_type_key,
         case e.labor_type when 'TEMPORARY' then 'thời vụ' else 'chính thức' end as employment_type_key,
         count(*) as new_count
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
    join public.direct_entry_projects p on p.project_id = e.project_id, params pa
   where s.state = 'SUBMITTED'
     and e.deleted_at is null
     and e.first_work_date between pa.from_date and pa.to_date
     and e.first_work_date >= pa.cutoff   -- mask trước cutoff
   group by 1,2,3,4,5
),
merged as (
  select coalesce(o.business_date, n.business_date) as business_date,
         coalesce(o.project_key, n.project_key)     as project_key,
         coalesce(o.recruiter_key, n.recruiter_key) as recruiter_key,
         coalesce(o.provider_type_key, n.provider_type_key) as provider_type_key,
         coalesce(o.employment_type_key, n.employment_type_key) as employment_type_key,
         coalesce(o.old_count, 0) as old_count,
         coalesce(n.new_count, 0) as new_count
    from old_agg o
    full outer join de_agg n
      on o.business_date = n.business_date
     and o.project_key = n.project_key
     and o.recruiter_key = n.recruiter_key
     and o.provider_type_key = n.provider_type_key
     and o.employment_type_key = n.employment_type_key
)
select business_date, project_key, recruiter_key, provider_type_key, employment_type_key,
       old_count, new_count,
       (old_count + new_count) as merged_count,
       (old_count - new_count) as delta
  from merged
 order by abs(old_count - new_count) desc, business_date, project_key, recruiter_key
 limit 200;
```

PASS: trong khoảng `from..to` với `from..cutoff-1` chỉ có `old_count > 0`, `new_count = 0`; với `cutoff..to` chỉ có `new_count > 0`, `old_count = 0`. Delta = 0 cho mọi ngày "rỗng" giữa hai khoảng.

FAIL: có ngày mà cả hai cùng > 0 → cutover bị overlap; nếu `delta != 0` trong khoảng exclusive → leak dữ liệu.

### 3.4. Attributed totals per dimension (reconciliation side)

```sql
-- 3.4.a: Tổng theo project_key
--   So sánh: bucket tổng (old) vs bucket tổng (new) sau cutoff
--   PASS: tổng từng bucket khớp tổng từ Direct Entry *trong cùng ngày/chiều*
--   FAIL: bucket bị tách (ví dụ project mới chưa có alias, recruiter alias thiếu)

with params as (
  select date '9999-12-31' as cutoff  -- placeholder
),
old_by_project as (
  select project_key, project_display, sum(recruited_count) as old_total
    from public.daily_recruitment_breakdown, params p
   where business_date < p.cutoff
   group by 1,2
),
new_by_project as (
  select lower(btrim(regexp_replace(normalize(p.display_name, NFC), '\s+', ' ', 'g'))) as project_key,
         p.display_name as project_display,
         count(*) as new_total
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
    join public.direct_entry_projects p on p.project_id = e.project_id, params pa
   where s.state = 'SUBMITTED'
     and e.deleted_at is null
     and e.first_work_date >= pa.cutoff
   group by 1,2
)
select coalesce(o.project_key, n.project_key) as project_key,
       coalesce(o.project_display, n.project_display) as project_display,
       coalesce(o.old_total, 0) as old_total,
       coalesce(n.new_total, 0) as new_total
  from old_by_project o
  full outer join new_by_project n on o.project_key = n.project_key
 order by (coalesce(o.old_total, 0) + coalesce(n.new_total, 0)) desc
 limit 200;
```

PASS nếu với mỗi `project_key` xuất hiện cả hai phía, `old_total` và `new_total` tương ứng đúng tỉ lệ kỳ vọng (Owner cung cấp ratio mục tiêu); FAIL nếu có bucket chỉ thuộc một phía với số lớn (>= 5 entries) → chưa đồng bộ master/alias.

```sql
-- 3.4.b: Recruiter bucket (qua alias)
--   Tương tự 3.4.a nhưng group theo recruiter_key đã resolve từ alias

with params as (
  select date '9999-12-31' as cutoff
),
old_by_recruiter as (
  select recruiter_key, recruiter_display, sum(recruited_count) as old_total
    from public.daily_recruitment_breakdown, params p
   where business_date < p.cutoff
   group by 1,2
),
new_by_recruiter as (
  select coalesce((
           select a.reporting_key
             from public.recruiter_aliases a
            where a.recruiter_id = e.recruiter_id
              and a.valid_from <= e.first_work_date
              and (a.valid_to is null or e.first_work_date < a.valid_to)
            order by a.valid_from desc limit 1
         ), '__unknown__') as recruiter_key,
         case
           when exists (
             select 1 from public.recruiter_aliases a
              where a.recruiter_id = e.recruiter_id
                and a.valid_from <= e.first_work_date
                and (a.valid_to is null or e.first_work_date < a.valid_to)
           ) then (select r.display_name from public.recruiters r where r.recruiter_id = e.recruiter_id)
           else '__unknown__'
         end as recruiter_display,
         count(*) as new_total
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id, params pa
   where s.state = 'SUBMITTED'
     and e.deleted_at is null
     and e.first_work_date >= pa.cutoff
   group by 1,2
)
select coalesce(o.recruiter_key, n.recruiter_key) as recruiter_key,
       coalesce(o.recruiter_display, n.recruiter_display) as recruiter_display,
       coalesce(o.old_total, 0) as old_total,
       coalesce(n.new_total, 0) as new_total
  from old_by_recruiter o
  full outer join new_by_recruiter n on o.recruiter_key = n.recruiter_key
 order by (coalesce(o.old_total, 0) + coalesce(n.new_total, 0)) desc
 limit 200;
```

PASS/FAIL: như 3.4.a.

### 3.5. Lineage, coverage, freshness (Direct Entry)

```sql
-- 3.5.a: Lineage snapshot of all SUBMITTED entries
--   PASS: mọi submission_id có at least 1 entry
--   FAIL: submission rỗng hoặc thiếu entry (lifecycle drift)

select s.submission_id, s.state, s.submitted_at,
       (select count(*) from public.direct_entries e
         where e.submission_id = s.submission_id and e.deleted_at is null) as live_entries,
       (select count(*) from public.direct_entries e
         where e.submission_id = s.submission_id and e.deleted_at is not null) as deleted_entries
  from public.direct_entry_submissions s
 order by s.submitted_at desc nulls last
 limit 100;
```

```sql
-- 3.5.b: Freshness for Direct Entry (DRAFT)
--   PASS: max(submitted_at) trong vòng ngưỡng Owner-duyệt (không freeze trong contract này)
--   FAIL: submitted_at quá cũ HOẶC NULL mà expected to have activity

select max(submitted_at) as last_submitted_at,
       count(*) filter (where submitted_at is not null) as total_submitted,
       count(*) filter (where submitted_at >= now() - interval '7 days') as last_7d
  from public.direct_entry_submissions
 where state = 'SUBMITTED';
```

```sql
-- 3.5.c: Coverage (DRAFT)
--   coverage = (entries_submitted_in_filter_scope) / (entries_eligible_in_filter_scope)
--   trong đó eligible = submission state=SUBMITTED, deleted_at IS NULL
--   PASS: ratio = 1.0 cho filter scope mặc định
--   FAIL: ratio < 1.0 có thể do filter không khớp eligibility (lỗi cấu hình)

select
  (select count(*) from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
    where s.state = 'SUBMITTED' and e.deleted_at is null) as eligible_total,
  (select count(*) from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
    where s.state = 'SUBMITTED' and e.deleted_at is null
      and e.first_work_date between date '1900-01-01' and current_date) as in_default_scope;
-- ratio ở application layer
```

### 3.6. PASS/FAIL tổng hợp (cutover gate)

| # | Check | PASS condition | FAIL → rollback / no cutover |
|---|---|---|---|
| G1 | 3.1.a project key normalization | 100% entries có project_key khớp alias; hoặc tỷ lệ lệch đã được Owner chấp nhận bucket `__unknown__` | Owner cần tạo alias hoặc chấp nhận tách bucket |
| G2 | 3.1.b recruiter alias coverage | 100% entries có alias tại `first_work_date` | Owner cần backfill alias (decision #5) |
| G3 | 3.2.a aggregate mask | `old_after_cutoff = 0` khi apply mask | Lỗi mask logic; KHÔNG cutover |
| G4 | 3.2.b direct entry eligible count | số đếm khớp audit; không có submission rỗng | Kiểm tra soft delete / state; KHÔNG cutover |
| G5 | 3.3 day-level diff | overlap = 0; gap days OK; delta = 0 cho mọi ngày exclusive | Cutover bị overlap hoặc leak; KHÔNG cutover |
| G6 | 3.4 attributed totals | bucket ratio khớp expected ratio Owner-cung cấp; bucket lệch đã được chấp nhận | Rekey / master backfill trước cutover |
| G7 | 3.5 lineage | mọi SUBMITTED submission có ≥ 1 entry (live hoặc deleted) | Lỗi lifecycle; KHÔNG cutover |
| G8 | 3.5 freshness | `last_submitted_at` không quá cũ (theo Owner threshold) | Cutover trên scope stale; chờ Owner confirm |

**Cutover gate:** Tất cả G1–G8 phải PASS. Bất kỳ FAIL nào → KHÔNG cutover. Quay lại §4 để Owner/T0 chốt quyết định còn thiếu.

### 3.7. Rollback / no-cutover (nếu G* FAIL)

- **Giữ nguyên dashboard read model** = `daily_recruitment_breakdown` aggregate. Không xóa RPC `replace_daily_recruitment_breakdown_snapshot_v02`; không tắt source.
- **Direct Entry vẫn hoạt động** như transaction source; chỉ phần projection/reporting mới không cutover.
- **Reporting cutover chưa xảy ra**; dashboard tiếp tục hiển thị aggregate từ Sheets (với `data_sources` snapshot đã publish trước P1.6).
- **Không có migration rollback**; không có R2/env mutation. Contract này không yêu cầu thay đổi gì runtime.
- Khi các quyết định §4 được chốt và G* PASS, mở task mới (P2-C01B hoặc sau) để thực thi cutover.

---

## 4. Quyết định Owner/T0 còn cần

Mọi quyết định dưới đây **chưa được chốt**; contract reconciliation chỉ freeze sau khi Owner/T0 trả lời. Đây là blocker thật, không phải danh sách "nice-to-have".

1. **Ngày cutoff.** Ngày nào (YYYY-MM-DD, Asia/Ho_Chi_Minh) là điểm chuyển canonical từ aggregate cũ sang Direct Entry? Cutoff có thể:
   - là ngày deploy P1.7 J01 (đơn giản, dễ thuyết minh); hoặc
   - là ngày đầu tháng/quý kế tiếp sau J01 (giảm overlap test); hoặc
   - là ngày Owner xác nhận đã có ≥ N Direct Entry submissions thật để so sánh ý nghĩa.
2. **Cách giữ lịch sử trước cutoff.** Aggregate cũ `daily_recruitment_breakdown` được:
   - giữ nguyên và là canonical cho `business_date < cutoff_date`; hoặc
   - snapshot một lần vào bảng archive (kèm lineage `sync_run_id` + `snapshot_at`); hoặc
   - không lưu trữ ngoài R2 (chỉ log khi source retires).
3. **Có hay không retained external source.** Trong 30 source I06 đã quan sát (xem P2-R00 E-03), những source nào:
   - retained (giữ trong reporting scope, tiếp tục aggregate nếu có thay đổi);
   - archived (chỉ đọc, không publish mới);
   - retired (không hiển thị).
4. **Expected totals/coverage tại thời điểm cutover.** Owner cung cấp:
   - tổng `recruited_total` kỳ vọng cho khoảng `cutoff_date - 30 days` đến `cutoff_date` (aggregate cũ);
   - tổng `entries` kỳ vọng cho khoảng `cutoff_date` đến `cutoff_date + 30 days` (Direct Entry mới);
   - coverage ratio kỳ vọng (số source `everSucceeded` / số source trong scope cũ) và (entries_submitted / eligible_total) cho Direct Entry.
5. **Backfill recruiter alias.** Nếu 3.1.b FAIL một phần, Owner có cho phép backfill `recruiter_aliases` từ master data tên hiển thị recruiter (cũ → mới) trước cutover không? Nếu có, ai chịu trách nhiệm ký/audit (Owner-managed hay privileged edit)?
6. **Mở rộng dimension `team`.** Aggregate cũ không có `team_id`. Có thêm `team` vào breakdown dashboard không? Nếu có, cần mapping từ `team_id` → display key (NFC + lowercase) theo cùng `recruitment_dimension_key()`. Quyết định ảnh hưởng UI filter contract.
7. **Status summary metric.** Có hiển thị `status_summary` (UNCONFIRMED / ON / OFF count) trong dashboard report không? Theo `direct-entry/1.1` §5, status event là derived; nó không ảnh hưởng `recruited_total`. Nếu Owner muốn, đó là metric phụ — không thay `recruited_total`.
8. **Stale threshold / channel.** Cho freshness `submitted_at` (§3.5.b), threshold bao lâu và cảnh báo gửi kênh nào? Theo P2-R00 §"Capability decisions" Monitoring → defer; thuộc P2-W05/W06.

---

## 5. Khả năng tương thích & version

- **Không bump version** `p1-reporting/0.1` hay `daily-recruitment-breakdown/0.2`. Draft này là **additive**: tài liệu tham chiếu cho cutover, không thay semantics đang chạy.
- Khi contract này freeze, dự kiến sẽ bump thành `p2-reporting/1.0` (cùng với P2-C01 freeze thật) để giữ lineage.
- Cùng tương thích với `direct-entry/1.1` (P1.6) và `direct-entry/1.2` (P1.7 server-employee-code).

---

## 6. Acceptance của draft này (khi T0 review)

- Source-verify có chính xác không (so với migrations + codegraph)?
- Bốn quyết định §4 (cutoff, retain, expected totals, backfill) đã được T0 ghi nhận để chuyển cho Owner?
- Truy vấn §3 đã đủ để chạy trên staging/read-only Production sau P1.7 J01?
- Có chỗ nào cố ý giả định mà chưa chốt?
- PASS/FAIL gate §3.6 có thừa/miss điều kiện cutover không?

---

## 7. Nguồn đã đọc để soạn contract

| Tài liệu | Mục đích |
|---|---|
| `docs/contracts/p1-reporting-v0.1.md` | grain/metric/coverage/freshness hiện hành; filter contract |
| `docs/contracts/daily-recruitment-breakdown-v0.2.md` | aggregate semantics + RPC + query examples |
| `docs/contracts/p1.6-direct-entry-v1.md` | Direct Entry lifecycle, status, capability |
| `docs/contracts/daily-recruitment-count-v0.1.md` (RETIRED) | Lịch sử, không dùng cho mới |
| `supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql` | Direct Entry schema (submissions, entries, status events, masters) |
| `supabase/migrations/20261001130100_p0_daily_recruitment_breakdown_foundation.sql` | aggregate schema |
| `supabase/migrations/20261001150100_p1_reporting_latest_sync_runs_view.sql` | reporting view latest run |
| `supabase/migrations/20261001150200_p1_reporting_sources_with_facts_view.sql` | reporting view presence |
| `supabase/migrations/20261005020000_p1_6_w04_s04c_submission_reads.sql` | submission read projection pattern (tham chiếu) |
| `supabase/migrations/20261006010000_p1_7_w03a_draft_projection.sql` | draft projection pattern + redaction semantics |
| `src/lib/reporting/p1-reporting.ts` + `p1-reporting-server.ts` (qua codegraph) | reporting types + read path |
| `docs/handoffs/p2-r00-readiness-audit.md` | P2 readiness audit |
| `docs/roadmaps/p2-post-direct-entry-rebaseline.md` | P2 rebaseline + capability decisions |
| `docs/handoffs/p1.7-h05-direct-entry-production-ui-fixes.md` | P1.7 state baseline |
| `docs/P2.md` | P2 task definitions (C01 / W04) |
