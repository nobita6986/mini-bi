# P2-W01 — Post-P1.7 Reporting Baseline Evidence

| Property | Value |
|---|---|
| Evidence version | W01-2026-10-05 |
| Base when measured | `45c99b984be8fd81d0fb1308ec9deda94bbf901e` (post H08-R1) |
| Companion contract | `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` (DRAFT, at `e6f1e9f`) |
| Companion rebaseline | `docs/handoffs/p2-r00-readiness-audit.md`, `docs/roadmaps/p2-post-direct-entry-rebaseline.md` |
| Companion P1 reporting | `p1-reporting/0.1`, `daily-recruitment-breakdown/0.2` |
| Companion P1.6/P1.7 lifecycle | `direct-entry/1.1` + P1.7 H01–H08 series |
| Method | Read-only — code + migrations + contracts (no DB query execution on Production) |
| Read-only enforcement | Tất cả "đo đếm" dưới đây là derived từ schema/code/contract; không có query nào thực sự chạy trên Production DB. Truy vấn "repeatable" chỉ ở dạng doc-only sẵn sàng cho staging. |

> **Tuyên bố trung thực:** Tài liệu này ghi nhận **bằng chứng code-level** cho rằng hệ thống hiện tại có khả năng cutover. Nó **không** tự chạy query trên Production và **không** tuyên bố cutover thật. Mọi số liệu "expected at cutover" là mặc định kỹ thuật do T1 đề xuất — Owner/T0 phải xác nhận.

---

## A. Source-verify tại 45c99b9

Mục đích: xác nhận canonical schema và reporting read path **vẫn đúng** sau khi P1.7 H06/H07/H08 thêm UI scaffolding (không thay schema DB).

### A.1. Reporting read model (không thay đổi từ 27309ba)

| Bảng / View | Schema migration | Vai trò | Trạng thái tại 45c99b9 |
|---|---|---|---|
| `public.daily_recruitment_breakdown` | `20261001130100` | Bảng fact dashboard; grain = `(source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key) = recruited_count` | unchanged |
| `public.data_sources` | P0 | Mỗi source = 1 Google Sheet | unchanged |
| `public.sync_runs` | P0 | Lịch sử run | unchanged |
| `public.reporting_latest_sync_runs_v01` | `20261001150100` | Latest run per source | unchanged |
| `public.reporting_sources_with_current_facts_v01` | `20261001150200` | DISTINCT source_id có fact | unchanged |
| `public.reporting_dimension_options_view` | `20261001150300` | Dropdown options | unchanged |
| `public.recruitment_dimension_key()` | `20261001130100` | NFC + trim + ws + lowercase | unchanged |

Server side: `src/lib/reporting/p1-reporting-server.ts` đọc các bảng/view trên. Codegraph confirm blast radius của `ReportingData`/`ReportingFact`/`ReportingSource` là từ `p1-reporting.ts`, `p1-reporting-server.ts`, `p1-chart-data.ts` — không có read path mới nào được thêm trong P1.7.

**F-01:** Reporting read model ổn định; cutover chỉ cần dùng cùng tên bảng/view này trong projection mới.

### A.2. Direct Entry canonical (P1.6 schema, không thay đổi từ 27309ba)

| Bảng | Migration | Cột canonical | Trạng thái tại 45c99b9 |
|---|---|---|---|
| `public.direct_entry_submissions` | `20261002170000` | `submission_id`, `created_by_user_id`, `state` (`DRAFT`/`REVIEW`/`SUBMITTED`), `version`, `created_at`, `updated_at`, `submitted_at`; CHECK `(state='SUBMITTED') = (submitted_at IS NOT NULL)` | unchanged |
| `public.direct_entries` | `20261002170000` | `entry_id`, `submission_id`, `candidate_id`, `created_by_user_id`, `project_id`, `first_work_date`, `employee_code`, `worker_details` (jsonb), `recruiter_id`, `team_id`, `provider_type`, `labor_type`, `version`, `created_at`, `updated_at`, `deleted_at` | unchanged |
| `public.direct_entry_employment_status_events` | `20261002170000` | `event_id`, `entry_id`, `status` (`UNCONFIRMED`/`ON`/`OFF`), `effective_date`, `leave_date`, `leave_reason_text`, `version`, `actor_user_id`, `reason_id`, `supersedes_event_id`, `applied_at` | unchanged |
| `public.recruiters` | `20261002170000` | `recruiter_id`, `display_name`, `active`, `version` | unchanged |
| `public.recruiter_aliases` | `20261002170000` | `recruiter_id`, `reporting_key`, `valid_from`, `valid_to`; half-open `[valid_from, valid_to)` | unchanged |
| `public.recruiter_provider_memberships` | `20261002170000` | `recruiter_id`, `provider_type`, `valid_from`, `valid_to` | unchanged |
| `public.recruiter_team_memberships` | `20261002170000` | `recruiter_id`, `team_id`, `valid_from`, `valid_to` | unchanged |
| `public.teams` | `20261002170000` | `team_id`, `code`, `display_name`, `active`, `version` | unchanged |
| `public.direct_entry_projects` | `20261002170000` | `project_id` (text PK), `display_name`, `active`, `version` | unchanged |
| `public.direct_entry_payments` | `20261002170000` | `entry_id` (PK), `state`, `account_number`, `bank_id`, `account_holder_name`, `version` | unchanged; ngoài reporting scope |

P1.7 bổ sung:

| Migration | Mục đích | Ảnh hưởng reporting |
|---|---|---|
| `20261006010000_p1_7_w03a_draft_projection.sql` | `direct_entry_list_own_drafts(uuid, uuid)` cho UI; chỉ list **DRAFT** | **Không** — chỉ DRAFT, reporting chỉ SUBMITTED |
| `20261007010000_p1_7_h03_server_employee_codes.sql` | Server-cấp `employee_code` (UI read-only) | **Không** — `employee_code` không nằm trong reporting projection (xem C01A §2.8) |

P1.7 H06/H07/H08 (H08 = `45c99b9`): chỉ UI scaffolding, không thêm migration/table.

**F-02:** Canonical schema Direct Entry không thay đổi từ C01A baseline `27309ba`. C01A contract vẫn áp dụng được.

### A.3. Revision/correction semantics

| Kênh | Cách xử lý | Reference |
|---|---|---|
| Owner/Accounting direct edit trên `direct_entries` | Update in-place; `version++`; audit row ghi actor, reason, expected_version, changed fields | `direct-entry/1.1` §4 + `direct_entry_audit_events` (foundation) |
| Change request approve (qua `direct_entry_change_request_*`) | Append `change_request_items`; apply atomic; `version++`; revision snapshot; reviewer decision | `direct_entry/1.1` §4 + migration `20261005030000` (change_policy_closure) |
| Status event correction | Append event mới với `supersedes_event_id`; chỉ sửa latest event | `direct-entry/1.1` §5 + CHECK unique `(entry_id, version)` |
| Soft delete | `deleted_at IS NOT NULL`; loại khỏi projection; `version++` | `direct_entries.deleted_at` (foundation) |
| Backdated correction (`first_work_date` đổi) | Atomic; re-bucket sang ngày mới; revision snapshot; audit before/after | Foundation + `direct-entry/1.1` §4 |

**F-03:** Mọi thay đổi canonical có `version` increment + audit/revision row. Reconciliation có thể truy `direct_entry_audit_events` để lý giải delta; nếu 1 ngày có audit chain dài → expected total có thể cộng dồn entry_id, không phải `recruited_count` (entry vẫn là 1 người, chỉ di chuyển ngày).

### A.4. Eligibility filter canonical (áp dụng cho mọi projection)

```sql
-- Canonical eligibility từ C01A §1.3:
where exists (
  select 1 from public.direct_entry_submissions s
   where s.submission_id = e.submission_id
     and s.state = 'SUBMITTED'
)
  and e.deleted_at is null
```

**F-04:** Mọi số liệu dưới đây dùng filter này làm mặc định. Không cần thêm điều kiện.

### A.5. Google Sheets / n8n (xác nhận lần cuối)

- `replace_daily_recruitment_breakdown_snapshot_v02` (RPC) — API vẫn tồn tại, không retire. Nhưng không có nguồn publish mới sau P1.6 vì:
  - WF01 runbook (`automation/n8n/docs/p0-t2-wf01-runbook.md`) mô tả **Draft/manual, no schedule, DEV-only service role**.
  - `daily_recruitment_counts` (v01) đã retire (`20261001130000`).
  - P2 rebaseline (Capability decisions) quyết "External Ingestion **DEFER**" — không build dispatcher Sheet định kỳ.
- Codegraph không tìm thấy client code gọi `replace_daily_recruitment_breakdown_snapshot_v02` ở runtime mới (chỉ migration + fixture runner `pnpm fixtures:check`).

**F-05:** Sheets/n8n không còn là ingestion mặc định. Aggregate hiện hành là **historical snapshot** đã publish trước P1.6, không tăng sau P1.6.

---

## B. Đo baseline (read-only, derived từ code + migration)

> Tất cả số liệu dưới đây là **default kỹ thuật** mà T1 đề xuất. Không có số liệu thực tế nào được chạy trên Production. Owner phải xác nhận bằng evidence độc lập sau P1.7 J01.

### B.1. Direct Entry eligible count (default metric)

| Metric | Definition | Default đề xuất | Cách đo (read-only) |
|---|---|---|---|
| DE eligible entries | `count(*)` của `direct_entries` thỏa §A.4 | **0** tại baseline `45c99b9` (theo P2-R00 E-03) | `select count(*) from direct_entries e where exists (...) and e.deleted_at is null` (query doc, không chạy Production) |
| DE date range | `min/max(first_work_date)` | **null** (no entries) | `select min(first_work_date), max(first_work_date) ...` |
| DE submissions (mọi state) | `count(*)` của `direct_entry_submissions` | **0** theo P2-R00 E-03 | n/a |
| DE candidates | `count(*)` của `direct_entry_candidates` | **0** theo P2-R00 E-03 | n/a |

**Default cutoff candidate (T1 đề xuất):** `cutoff_date = 'YYYY-MM-DD'` mà tại đó:
- `daily_recruitment_breakdown` sau `cutoff_date` = 0 dòng (mask → 0 ngay, không có dữ liệu mới từ Sheets nên `recruited_count` = 0 về mặt kỹ thuật).
- `direct_entries` trước `cutoff_date` = 0 dòng (mask → 0 vì chưa có Direct Entry thật tại baseline).

→ **Với baseline `45c99b9` (0 Direct Entry), cutoff kỹ thuật có thể là `BẤT KỲ NGÀY NÀO` mà Owner chọn** vì cả hai phía đều cho kết quả empty. Điều này **không** có nghĩa cutover đã sẵn sàng; nghĩa là chỉ cần chốt ngày symbolic.

**F-06:** Trong trạng thái hiện tại, dashboard có thể chuyển sang "Direct Entry only" từ bất kỳ ngày nào và sẽ hiển thị 0 (vì chưa có data). Đây là baseline measurement, không phải production behavior.

### B.2. Legacy aggregate rows, recruited total, date range

| Metric | Definition | Default đề xuất | Cách đo (read-only) |
|---|---|---|---|
| Aggregate rows | `count(*)` của `daily_recruitment_breakdown` | **0** theo P2-R00 E-03 (chỉ có source fixture từ P0; tất cả source thật có thể đã bị ngưng publish) | `select count(*), sum(recruited_count), min(business_date), max(business_date), count(distinct source_id) from daily_recruitment_breakdown` |
| `recruited_total` aggregate | `sum(recruited_count)` | **0** | (cùng query) |
| Aggregate date range | `min/max(business_date)` | **null** (nếu 0 rows) | (cùng query) |
| Distinct source_id | `count(distinct source_id)` | **0..30** tuỳ trạng thái Source (xem B.3) | (cùng query) |

**F-07:** Cần Owner confirm lại số liệu aggregate bằng cách chạy trên Production/staging read-only sau J01. T1 không có quyền truy cập.

### B.3. 30 reporting source states (default expectation)

Theo P2-R00 E-03: "30 active non-test reporting sources, 8 project keys, 10 recruiter keys, 0 direct entries/submissions/candidates". Đây là snapshot **tại P1.6 J01**, không phải tại `45c99b9`.

| Trạng thái | Default expectation | Cách đo (read-only, doc only) |
|---|---|---|
| `sources_expected` (active=true, is_test=false) | 30 (nếu chưa retire) | `select count(*) from data_sources where active = true and is_test = false` |
| `sources_ever_succeeded` (last_successful_sync_at IS NOT NULL) | cần đo lại | (cùng query + filter) |
| `sources_failed_latest` | cần đo lại | join `reporting_latest_sync_runs_v01` |
| `sources_never_succeeded` | cần đo lại | `where last_successful_sync_at IS NULL` |
| Project keys (distinct) | ≤ 8 (P2-R00 snapshot) | `select count(distinct project_key) from daily_recruitment_breakdown` |
| Recruiter keys (distinct) | ≤ 10 (P2-R00 snapshot) | `select count(distinct recruiter_key) from daily_recruitment_breakdown` |

**F-08:** Bằng chứng về 30 source là từ P2-R00 E-03 — observation tại một thời điểm, không phải invariant. W01 **không thể** xác nhận số liệu này từ code-only evidence; cần Owner query.

### B.4. Coverage / freshness

| Signal | Aggregate (cũ) | Direct Entry (mới) |
|---|---|---|
| Coverage ratio | `sources_ever_succeeded / sources_expected` | `entries_submitted_in_scope / eligible_total` (C01A §3.5.c) |
| Freshness | `max(last_successful_sync_at)` | `max(direct_entry_submissions.submitted_at) WHERE state='SUBMITTED'` |

**F-09:** Cả hai metric đều cần query Production để có số thật. W01 chỉ xác nhận contract/semantics.

### B.5. Overlap theo ngày / project / recruiter / provider / team

Với `DE eligible = 0` tại baseline:
- Overlap theo `first_work_date` ∩ `business_date` = 0 dòng (DE phía rỗng).
- Overlap theo project_key = 0 (chưa thể map vì DE = 0).
- Overlap theo recruiter_key = 0.
- Overlap theo provider_type_key = 0.
- Overlap theo employment_type_key = 0.
- Team: aggregate cũ không có `team`; DE có `team_id` — không có khả năng overlap.

**F-10:** Tại baseline `45c99b9`, overlap là structurally rỗng vì DE = 0. Cutover **không thể** PASS gate G5 (3.3) của C01A cho đến khi có Direct Entry thật.

### B.6. Bằng chứng chống double-count (kỹ thuật)

Theo C01A §2.3, §2.4:

1. **Mask aggregate sau cutoff:** `recruited_count` của `daily_recruitment_breakdown` với `business_date >= cutoff` được mask = 0. Vì aggregate đã không tăng từ P1.6 (F-05), mọi row hiện hữu (nếu có) sẽ có `business_date < any cutoff` (Owner chọn). → Mask kỹ thuật là no-op ở baseline.
2. **Mask DE trước cutoff:** `first_work_date < cutoff` không tính vào projection metric. Vì DE = 0, mask là no-op.
3. **State eligibility:** chỉ `state='SUBMITTED' AND deleted_at IS NULL` mới là canonical fact. DRAFT/REVIEW không bao giờ là fact.
4. **Status `OFF`:** không trừ `recruited_total`; chỉ tách metric phụ nếu Owner yêu cầu.
5. **Mỗi entry = 1 người:** `count(*)` trên eligible rows = số người, không phải `sum(recruited_count)`.

**F-11:** Cấu trúc code-level đảm bảo cutover không thể double-count nếu:
- Cả hai phía dùng eligibility filter (§A.4) + mask (§2.3 C01A).
- Mỗi entry = 1 dòng projection ở grain `(first_work_date, project_id, recruiter_id, team_id, provider_type, labor_type)` với `recruited_count = 1`.

Bằng chứng này là **structural**, không phải empirical. Để empirical PASS, cần production data (xem §E).

---

## C. Candidate cutoff và bằng chứng chống double-count

### C.1. Default cutoff candidate (T1 đề xuất)

**Đề xuất:** `cutoff_date = 'infinity'` (không giới hạn, tức là DE dùng cho mọi ngày; aggregate bị mask hoàn toàn khi `business_date >= 'infinity'` ⇒ tức là mask cả bảng). Đây là **default kỹ thuật**, không phải ngày cụ thể.

**Lý do:**
- Tại baseline `45c99b9`, aggregate cũ đã không tăng (F-05); DE = 0 (F-06).
- Cutover "all-aggregate" hoặc "all-DE" đều cho kết quả 0 hiện tại → không có ngày thật nào để test.
- Owner/T0 sẽ chốt ngày cụ thể sau P1.7 J01 + khi có DE thật.

**Kỳ vọng thực tế (sau P1.7 J01 + Owner data):**
- Cutoff nên là **ngày Owner chọn** ∈ {P1.7 J01+1 ngày, ngày đầu tháng/quý kế tiếp, ngày có ≥ N DE submissions thật}.
- Mặc định kỹ thuật: aggregate inclusive `< cutoff`, DE exclusive `< cutoff` (C01A §2.3 quyết định 1, mặc định an toàn).

### C.2. Bằng chứng chống double-count (cấu trúc)

| Cơ chế | Mã nguồn | Trạng thái |
|---|---|---|
| Eligibility filter unique | C01A §A.4 | canonical, áp dụng 1 lần duy nhất |
| Mask aggregate `business_date >= cutoff` | C01A §2.3 + §3.2.a | chưa có RPC; cần implement khi W04 cutover |
| Mask DE `first_work_date < cutoff` | C01A §2.3 | chưa có RPC; cần implement khi W04 cutover |
| Status `OFF` không trừ | C01A §2.2 | semantic khoá, không cần code |
| Mỗi entry = 1 dòng projection | C01A §2.1 grain_new | structural |

**F-12:** Chống double-count được đảm bảo structural bởi 5 cơ chế trên. Cả 5 cơ chế **chưa được implement** thành RPC/report; đó là phần việc của P2-W04.

### C.3. Tại sao cutover có thể chốt cutoff symbol tại baseline

- Tại `45c99b9`:
  - Aggregate rows: có thể = 0 (cần Owner query).
  - DE rows: 0 (theo P2-R00 E-03).
- Nếu aggregate = 0: cutover "all-DE" cho ra tổng = 0; cutover "all-aggregate" cũng tổng = 0. Diff = 0.
- Nếu aggregate > 0: cutover với cutoff bất kỳ trước `min(business_date)` sẽ mask aggregate hoàn toàn, chỉ giữ DE (= 0) → tổng = 0. Diff ≠ 0 ⇒ **PHẢI có Owner confirm** expected total trước khi cutover thật.

**F-13:** W01 chỉ cung cấp structural evidence. Cutover thật yêu cầu Owner/T0:
- (a) confirm aggregate cũ đang có bao nhiêu (chạy query B.2);
- (b) confirm expected total sau cutover;
- (c) chốt cutoff date cụ thể;
- (d) chạy gates G1–G8 của C01A §3.6.

---

## D. Đề xuất mặc định cho 8 quyết định C01A

> Mục đích: giảm tải quyết định cho Owner/T0. T1 chỉ giữ lại **các quyết định mà Owner thật sự phải chọn** (nghĩa là không có default an toàn rõ ràng). Các quyết định có default kỹ thuật rõ ràng → T1 đề xuất → Owner confirm (1 click), không phải tự suy nghĩ.

### D.1. Quyết định T1 giữ (cần Owner)

| # | Quyết định | Tại sao cần Owner |
|---|---|---|
| 1 | Cutoff date cụ thể | Phụ thuộc nghiệp vụ: ngày deploy J01, ngày đầu tháng/quý, hay ngày có ≥ N DE submissions thật. T1 không đủ thông tin. |
| 2 | Cách giữ lịch sử aggregate cũ trước cutoff | Tùy retention policy: giữ nguyên, snapshot archive, hoặc chỉ log. Thuộc P2-W04/W07. |
| 3 | Retained external sources (30 source I06) | Nghiệp vụ: source nào retained / archived / retired. Thuộc P2-N01. |
| 4 | Expected totals/coverage tại cutover | T1 không có số liệu Production. Owner cung cấp ratio kỳ vọng để chạy G6 gate. |

### D.2. Quyết định T1 đề xuất default (Owner confirm 1-click)

| # | Quyết định | Default T1 đề xuất | Lý do |
|---|---|---|---|
| 5 | Recruiter alias backfill | **Conditional**: chỉ backfill nếu 3.1.b FAIL sau J01; dùng master display_name làm alias key | C01A §3.1.b gate G2 đã cover. Backfill chỉ chạy nếu G2 FAIL một phần. |
| 6 | Team dimension trong dashboard | **KHÔNG mở rộng** ở cutover này | Aggregate cũ không có `team`; thêm vào sẽ đổi grain hiện hành. Có thể thêm ở version `p2-reporting/1.1` sau. |
| 7 | Status summary metric | **KHÔNG hiển thị** ở cutover này | Status `UNCONFIRMED`/`ON`/`OFF` đã là canonical; nhưng nếu Owner muốn metric phụ thì không ảnh hưởng `recruited_total`. Defer đến P2-W04. |
| 8 | Stale threshold / channel | **Default 24h, dry-run only** | Freshness `submitted_at` > 24h = stale. Không gửi cảnh báo trong cutover này; chỉ log + dashboard banner. Threshold là P2-W05/W06. |

**F-14:** W01 chỉ giữ 4 quyết định cho Owner (D.1) và đề xuất default cho 4 quyết định còn lại (D.2). Tổng Owner load giảm từ 8 → 4 quyết định.

---

## E. Truy vấn repeatable / read-only (chỉ dạng doc, không chạy Production)

> Các truy vấn dưới đây là tài liệu sẵn sàng để chạy trên staging hoặc read-only Production replica **sau P1.7 J01**. Mỗi truy vấn có `/* READ-ONLY */` marker; **không có INSERT/UPDATE/DELETE** trong tất cả.

### E.1. Direct Entry eligible count + date range (B.1)

```sql
/* READ-ONLY: Direct Entry eligibility + date range at measurement point */
with eligible as (
  select e.*
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'SUBMITTED'
     and e.deleted_at is null
)
select
  (select count(*) from eligible) as de_eligible_entries,
  (select min(first_work_date) from eligible) as de_min_date,
  (select max(first_work_date) from eligible) as de_max_date,
  (select count(distinct submission_id) from eligible) as de_distinct_submissions;
```

### E.2. Legacy aggregate rows + total (B.2)

```sql
/* READ-ONLY: aggregate rows + recruited total + date range + source count */
select
  count(*) as agg_rows,
  sum(recruited_count) as agg_recruited_total,
  min(business_date) as agg_min_date,
  max(business_date) as agg_max_date,
  count(distinct source_id) as agg_distinct_sources
  from public.daily_recruitment_breakdown;
```

### E.3. 30 source states (B.3)

```sql
/* READ-ONLY: 30-source state snapshot at measurement point */
with scope as (
  select * from public.data_sources where active = true and is_test = false
),
latest as (
  select * from public.reporting_latest_sync_runs_v01
)
select
  (select count(*) from scope) as sources_expected,
  (select count(*) from scope where last_successful_sync_at is not null) as sources_ever_succeeded,
  (select count(*) from scope s join latest l on l.source_id = s.id where l.status = 'succeeded') as sources_succeeded_latest,
  (select count(*) from scope s join latest l on l.source_id = s.id where l.status = 'partial')   as sources_partial_latest,
  (select count(*) from scope s join latest l on l.source_id = s.id where l.status = 'failed')    as sources_failed_latest,
  (select count(*) from scope where last_successful_sync_at is null) as sources_never_succeeded;
```

### E.4. Project/recruiter key distinct counts (B.3)

```sql
/* READ-ONLY: distinct project/recruiter key counts (snapshot at P2-R00: 8/10) */
select
  (select count(distinct project_key)        from public.daily_recruitment_breakdown) as distinct_projects,
  (select count(distinct recruiter_key)      from public.daily_recruitment_breakdown) as distinct_recruiters,
  (select count(distinct provider_type_key)  from public.daily_recruitment_breakdown) as distinct_providers,
  (select count(distinct employment_type_key)from public.daily_recruitment_breakdown) as distinct_employments;
```

### E.5. Overlap check (B.5)

```sql
/* READ-ONLY: aggregate vs DE structural overlap pre-candidate-cutoff */
with agg_min as (select min(business_date) as d from public.daily_recruitment_breakdown),
     de_min as (
       select min(first_work_date) as d
         from public.direct_entries e
         join public.direct_entry_submissions s on s.submission_id = e.submission_id
        where s.state = 'SUBMITTED' and e.deleted_at is null
     )
select
  (select d from agg_min) as agg_min_date,
  (select d from de_min)  as de_min_date,
  case
    when (select d from agg_min) is null then 'AGG_EMPTY'
    when (select d from de_min) is null then 'DE_EMPTY'
    else 'BOTH_NONEMPTY'
  end as overlap_state;
```

### E.6. Cutoff + mask sanity (C.2)

```sql
/* READ-ONLY: cutoff mask sanity (no mutation; aggregation only) */
with params as (select date '9999-12-31' as cutoff)
select
  sum(case when business_date <  p.cutoff then recruited_count else 0 end) as agg_in_range,
  sum(case when business_date >= p.cutoff then recruited_count else 0 end) as agg_after_cutoff,
  count(*) filter (where business_date <  p.cutoff) as agg_rows_in_range,
  count(*) filter (where business_date >= p.cutoff) as agg_rows_after_cutoff
  from public.daily_recruitment_breakdown, params p;
```

> Cùng các query §3.3, §3.4, §3.5 trong `p2-direct-entry-reporting-reconciliation-contract-draft.md` (cutover gate G1–G8). Tất cả đều SELECT-only; không có DML.

### E.7. Điều kiện chạy

- READ-ONLY role: `service_role` không cần SELECT grant (đã có), nhưng KHÔNG có UPDATE/DELETE grant ở staging read-only.
- Staging dùng snapshot của Production hoặc replica; không dùng DB thật.
- Mỗi query phải có `LIMIT` (nếu > 10K rows thì dùng `LIMIT 1000` cho diff spot-check).
- Không chạy trong transaction kéo dài; COMMIT ngay vì không có DML.

---

## F. Risks & open items (W01)

1. **DE = 0 tại baseline `45c99b9`.** Mọi số liệu "expected at cutover" chỉ là default. Owner phải xác nhận bằng cách chạy E.1/E.2 trên Production read-only.
2. **Aggregate có thể > 0.** Nếu Owner xác nhận aggregate vẫn còn dòng, cutover symbolic "all-DE" sẽ tạo tổng = 0, dẫn đến drop-out visible cho BoD. W01 không thể khuyến nghị "all-DE" mà không có aggregate expected total.
3. **P1.7 J01 vẫn là gate.** W01 không thay đổi gate này; W01 chỉ thu thập evidence.
4. **Recruiter alias backfill** (§D.2 #5) là default conditional; cần chạy 3.1.b để biết có cần hay không.
5. **30 source states** (B.3) cần Owner query; W01 chỉ tham chiếu P2-R00.
6. **Coverage/freshness DE** (B.4) cần Owner query; W01 chỉ mô tả contract.
7. **Truy vấn reconciliation E.6** dùng `cutoff = 'infinity'` chỉ để test mask; Owner phải thay bằng ngày cụ thể khi chạy G3 gate.

---

## G. Nguồn đã đọc

- `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` (tại `e6f1e9f`, C01A task) — input chính.
- `docs/contracts/p1-reporting-v0.1.md`
- `docs/contracts/daily-recruitment-breakdown-v0.2.md`
- `docs/contracts/p1.6-direct-entry-v1.md`
- `supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql` (canonical schema)
- `supabase/migrations/20261001130100_p0_daily_recruitment_breakdown_foundation.sql` (aggregate)
- `supabase/migrations/20261001150100/...150200/...150300` (reporting views)
- `supabase/migrations/20261006010000_p1_7_w03a_draft_projection.sql` (DRAFT projection)
- `supabase/migrations/20261007010000_p1_7_h03_server_employee_codes.sql` (server employee code)
- `docs/handoffs/p2-r00-readiness-audit.md`, `docs/roadmaps/p2-post-direct-entry-rebaseline.md`
- `docs/handoffs/p1.7-h05-direct-entry-production-ui-fixes.md`, `p1.7-h06-...`, `p1.7-h07-...`, `p1.7-h08-...`
- `src/lib/reporting/p1-reporting.ts` + `p1-reporting-server.ts` (codegraph)
- `src/lib/contracts/direct-entry-v1.ts` (codegraph)
- `src/lib/direct-entry/submission-read-contract.ts` (codegraph)
