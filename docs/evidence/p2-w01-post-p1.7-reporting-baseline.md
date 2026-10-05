# P2-W01 — Post-P1.7 Reporting Baseline Evidence

| Property | Value |
|---|---|
| Evidence version | W01-R1-2026-10-05 |
| Base when measured | `ff3cae507ea2ffe988206ccc10145f8142b94ccc` (W01 commit) — extends `45c99b984be8fd81d0fb1308ec9deda94bbf901e` (post H08-R1) |
| Companion contract | `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` (DRAFT, at `e6f1e9f`) |
| Companion rebaseline | `docs/handoffs/p2-r00-readiness-audit.md`, `docs/roadmaps/p2-post-direct-entry-rebaseline.md` |
| Companion P1 reporting | `p1-reporting/0.1`, `daily-recruitment-breakdown/0.2` |
| Companion P1.6/P1.7 lifecycle | `direct-entry/1.1` + P1.7 H01–H08 series |
| Method | **W01-R1: Live read-only Production baseline.** SELECT-only trong transaction `READ ONLY` với `SET LOCAL statement_timeout='15s'`, ROLLBACK. Helper: `scripts/lib/load-supabase-config.mjs` + `scripts/lib/supabase-tls.mjs` + `pg.Client` (đã có sẵn trong repo, không viết DB client mới). |
| Read-only enforcement | Mọi query đều có `/* READ-ONLY */` semantics; transaction mở `READ ONLY` + `statement_timeout` + `ROLLBACK`; helper DB đã pin TLS root CA. Không in PII, tên NLĐ, CCCD, payment, document, connection string, secret token. Chỉ xuất aggregate counts, date ranges, fingerprint. |
| Production evidence file | `docs/evidence/p2-w01-r1-baseline.json` (output of `scripts/p2-w01-r1-baseline.mjs`; atomic rename từ `.tmp`) |
| Production fingerprint | `aggregate_fingerprint_sha256` = `7abfbdab53b0f1b01bd119a02b5ebe5417f3a369d7a9ccdba26e425b2106b1bd` (deterministic per `(source_id, business_date, sum(recruited_count), grain_rows)`) |

> **Tuyên bố trung thực (W01-R1):** Tài liệu này ghi nhận **bằng chứng Production thật** thu được qua read-only transaction tại thời điểm `2026-10-05 (Asia/Ho_Chi_Minh)`. Mọi số liệu ở §B, §C, §F-15 đều từ query thật. Tài liệu này **vẫn** không tuyên bố cutover thật / P2 PASS / Production ready — cutover thật vẫn chờ P1.7 J01 + 4 quyết định Owner.

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

## B. Đo baseline (W01-R1: live Production read-only)

> Tất cả số liệu trong §B này là **Production evidence thật** thu được tại `2026-10-05` qua `scripts/p2-w01-r1-baseline.mjs` chạy với `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='15s'; …; ROLLBACK;`. File gốc: `docs/evidence/p2-w01-r1-baseline.json`. Helper: `scripts/lib/load-supabase-config.mjs` + `scripts/lib/supabase-tls.mjs` + `pg.Client` (đã có sẵn trong repo, không viết DB client mới).

### B.1. Legacy aggregate — Production evidence

| Metric | Value tại baseline | Source |
|---|---|---|
| `agg_rows` | **34** | `select count(*)::bigint from public.daily_recruitment_breakdown` |
| `recruited_total` aggregate | **44** | `coalesce(sum(recruited_count),0)::bigint` |
| `min_business_date` | **2026-10-01** | `to_char(min(business_date), 'YYYY-MM-DD')` |
| `max_business_date` | **2026-10-16** | `to_char(max(business_date), 'YYYY-MM-DD')` |
| `distinct_sources` | **6** | `count(distinct source_id)::bigint` |
| `by_source_date_count` | **19** | `group by source_id, business_date` distinct (source, date) pairs |
| `aggregate_fingerprint_sha256` | `7abfbdab53b0f1b01bd119a02b5ebe5417f3a369d7a9ccdba26e425b2106b1bd` | sha256 của `sid\|YYYY-MM-DD\|sum_count\|grain_rows` theo `(source_id, business_date)` |

**Quan sát:** `aggregate rows > 0` và `recruited_total > 0`. Do đó cutover "all-DE" (mask aggregate hoàn toàn) sẽ cho `recruited_total = 0`, gây drop-out visible cho BoD. Cần cutoff cụ thể để giữ lại một phần aggregate đã có.

### B.2. Direct Entry canonical — Production evidence

| Metric | Value tại baseline | Source |
|---|---|---|
| `direct_entries.total` | **0** | `select count(*) from public.direct_entries` |
| `direct_entry_submissions.total` | **0** | `select count(*) from public.direct_entry_submissions` |
| `direct_entry_submissions_by_state` | `[]` (empty) | `group by state` |
| `direct_entry_candidates.total` | **0** | `select count(*) from public.direct_entry_candidates` |
| `de_eligible_entries` | **0** | `state='SUBMITTED' AND deleted_at IS NULL` |
| `de_min_first_work_date` | **null** | (no rows) |
| `de_max_first_work_date` | **null** | (no rows) |

**Quan sát:** Direct Entry hiện **chưa có submission nào** (kể cả DRAFT/REVIEW) tại thời điểm baseline. Mọi eligibility count = 0 vì `direct_entries` rỗng. Khi có DE thật từ UI, `state='SUBMITTED' AND deleted_at IS NULL` sẽ là filter canonical duy nhất.

**F-15 (mới, W01-R1):** Tại baseline Production `2026-10-05`, Direct Entry canonical rỗng trên cả 3 mức (entries / submissions / candidates). Chưa có dữ liệu Direct Entry thật để chạy gate G5/G6 (C01A §3.3 / §3.5) — gate đó sẽ được chạy ở P2-W04 sau khi UI được UAT bởi Owner.

### B.3. Source registry — Production evidence

| Metric | Value tại baseline | Source |
|---|---|---|
| `data_sources.total` | **28** | `select count(*) from public.data_sources` |
| `data_sources.active=true` | **28** | `count(*) filter (where active = true)` |
| `data_sources.active=false` | **0** | `count(*) filter (where active = false)` |
| `data_sources.is_test=true` | **2** | `count(*) filter (where coalesce(is_test,false) = true)` |
| `data_sources.is_test=false` | **26** | `count(*) filter (where coalesce(is_test,false) = false)` |
| `last_successful_sync_at IS NOT NULL` (`ever_succeeded`) | **6** | `count(*) where last_successful_sync_at is not null` |
| `last_successful_sync_at IS NULL` (`never_succeeded`) | **22** | (derived: total 28 − ever_succeeded 6) |
| Source with latest run status `succeeded` | **4** | `reporting_latest_sync_runs_v01 group by status` |
| Source with latest run status `failed` | **24** | (cùng query) |
| External authority column (`external_authority` / `is_external` / `is_authority`) | **không tồn tại trong schema** | `information_schema.columns` lookup |
| Source nào được giữ làm external authority? | **0** (cột không tồn tại ⇒ không có source nào được pin làm authority) | n/a |

**Quan sát:** Source registry thật tại `2026-10-05` Production:
- Có **28 sources** (24 production, 2 test, 28 active) — thấp hơn P2-R00 expectation "30 active non-test" một chút (số P2-R00 là observation cũ, hiện đã giảm 4 source non-test). Có thể do retire ở P1.6/P1.7.
- 22/28 source **chưa từng chạy sync thành công** (`last_successful_sync_at IS NULL`). Trong đó 24 có latest run = `failed`. Chỉ 4 source có latest run `succeeded`.
- **Không có cột external authority** trong schema. Không có source nào được pin làm authority. ⇒ T0 decision "external retained sources = NONE" được xác nhận bởi schema (không phải chỉ vì không có nguồn ngoài, mà vì schema cũng không có khái niệm này).

**F-16 (mới, W01-R1):** Source registry thật = 28 sources, trong đó 22 chưa bao giờ sync thành công. P2-R00 E-03 dự đoán 30 active non-test — observation cũ không còn chính xác (giảm 4 source). T1 đã cập nhật W01 với số Production thật.

### B.4. Coverage / freshness — Production evidence

| Signal | Aggregate (cũ) | Direct Entry (mới) | Production value |
|---|---|---|---|
| Coverage ratio | `sources_ever_succeeded / sources_expected` = `6/28` ≈ **0.214** | `entries_submitted_in_scope / eligible_total` = `0/0` = **undefined** (cả 2 = 0) | ratios ghi nhận trong evidence file |
| Freshness | `max(last_successful_sync_at)` từ `data_sources` | `max(submitted_at) WHERE state='SUBMITTED'` = **null** | ghi nhận trong evidence file |

**F-17 (mới, W01-R1):** Coverage ratio aggregate = `6/28 = 0.214` (21.4%). 22 source chưa từng chạy được. Nguyên nhân cần Owner/T0 điều tra riêng (P2-N01 source retirement). **W01 không** đề xuất cutover "all-aggregate" vì coverage thấp.

### B.5. Overlap theo ngày / project / recruiter / provider / team — Production evidence

**Aggregate dimension counts** (từ `daily_recruitment_breakdown`):

| Dimension | Distinct count | Source |
|---|---|---|
| `business_date` | **16** | `count(distinct business_date)` |
| `project_key` | **10** | `count(distinct project_key)` |
| `recruiter_key` | **13** | `count(distinct recruiter_key)` |
| `provider_type_key` | **3** | `count(distinct provider_type_key)` |
| `employment_type_key` | **3** | `count(distinct employment_type_key)` |

**Direct Entry dimension counts** (từ `direct_entries` join `direct_entry_submissions`):

| Dimension | Distinct count | Source |
|---|---|---|
| `first_work_date` | **0** | (no rows) |
| `project_id` | **0** | (no rows) |
| `recruiter_id` | **0** | (no rows) |
| `team_id` | **0** | (no rows) |
| `provider_type` | **0** | (no rows) |
| `labor_type` | **0** | (no rows) |

**Aggregate date fingerprint** (hash của `min|max(distinct_sources)`):

`aggregate_date_fingerprint_sha256 = 9f77b41a3ffd2a99e7b6131fcd16b9143bb81b68c1d35c4157cd360bc86628b7`

**Overlap phân tích:**

- `agg_min_date = 2026-10-01`, `agg_max_date = 2026-10-16`. Khoảng **16 ngày** aggregate đã publish.
- DE phía rỗng ⇒ `first_work_date ∩ business_date = ∅` (intersection cardinality = 0).
- Project/recruiter/provider/employment: cả hai phía không thể map trực tiếp vì DE rỗng. Khi có DE thật, cần `recruiter_aliases` để map `recruiter_key` ↔ `recruiter_id` (xem §A.2).
- Team: aggregate không có `team_id`; DE có `team_id`. Khi có DE, có thể đếm `team` ở phía DE nhưng không thể phía aggregate.

**F-10 (cập nhật, W01-R1):** Tại Production `2026-10-05`, overlap intersection cardinality = 0 (DE rỗng) ⇒ cutover với **bất kỳ cutoff ≤ min(legacy_min)** sẽ mask aggregate hoàn toàn, kết quả = 0; cutoff **nằm trong khoảng aggregate** sẽ giữ lại một phần; cutoff **> max(legacy_max)** sẽ giữ lại toàn bộ.

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

### C.1. Candidate cutoff (W01-R1: Production evidence-based)

**Candidate cutoff (T1 đề xuất dựa trên evidence Production tại `2026-10-05`):**

```
cutoff_date = 2026-10-17
```

**Lý do:**

- `agg_min_date = 2026-10-01`, `agg_max_date = 2026-10-16`. Khoảng aggregate đã publish = 16 ngày.
- `de_eligible_entries = 0`. Direct Entry phía rỗng ⇒ `first_work_date >= cutoff` sẽ luôn là 0 dòng (mask DE không lấy gì).
- `hcm_today = 2026-10-05` (theo `(now() at time zone 'Asia/Ho_Chi_Minh')::date`).
- Rule "DE eligible = 0" áp dụng (vì `de_eligible_entries == 0`):
  ```
  after_legacy = agg_max_date + 1 day = 2026-10-17
  candidate    = max(after_legacy, hcm_today) = max(2026-10-17, 2026-10-05) = 2026-10-17
  ```
- Vì `2026-10-17 > hcm_today = 2026-10-05`, candidate cutoff là **12 ngày trong tương lai** so với ngày baseline. Điều này an toàn: mask aggregate `< 2026-10-17` giữ lại toàn bộ 34 dòng aggregate đã publish (44 người); mask DE `>= 2026-10-17` không lấy gì (DE rỗng).
- **Tuyệt đối không dùng `'infinity'`.** Cutoff `2026-10-17` cụ thể, có thể thực thi, có thể rollback bằng cách dời ngày.

**Hiệu lực của cutoff `2026-10-17` tại baseline:**

| Mask | Filter | Rows | Recruited total |
|---|---|---|---|
| Aggregate (in-range) | `business_date < '2026-10-17'` | 34 (toàn bộ) | 44 |
| Aggregate (after cutoff) | `business_date >= '2026-10-17'` | 0 | 0 |
| DE (in-range, eligible) | `first_work_date < '2026-10-17' AND state='SUBMITTED' AND deleted_at IS NULL` | 0 | 0 |
| DE (after cutoff, eligible) | `first_work_date >= '2026-10-17' AND state='SUBMITTED' AND deleted_at IS NULL` | 0 | 0 |
| **Total visible sau cutover (với cutoff `2026-10-17`)** | aggregate in-range + DE after-cutoff | 34 | 44 |

→ Với cutoff `2026-10-17`, dashboard giữ nguyên 44 người (toàn bộ aggregate) trong khi chờ DE thật. Khi Owner/UI tạo submission SUBMITTED đầu tiên với `first_work_date >= 2026-10-17`, nó sẽ xuất hiện ở nhóm "DE" mà không overlap (vì aggregate phía trước cutoff, DE phía sau cutoff, mask rời nhau).

**Kịch bản khi DE thật xuất hiện (T0/Owner kế hoạch):**

- Nếu DE thật đầu tiên có `first_work_date < 2026-10-17` (backdated — sửa lại first_work_date của NLĐ đã onboard từ trước cutoff): cần **chốt lại cutoff_date** về ngày trước `min(first_work_date)` của DE backdated. Đây là lý do vì sao T0 nên chốt cutoff SAU khi có DE thật đầu tiên, không phải trước.
- Nếu DE thật đầu tiên có `first_work_date >= 2026-10-17` (forward): cutoff giữ nguyên, không cần điều chỉnh.

**So sánh với P2-R00 expectation:**

- P2-R00 E-03 nói "30 active non-test reporting sources, 0 direct entries/submissions/candidates". W01-R1 confirm DE = 0, nhưng source non-test = **26** (giảm 4 so với P2-R00). Có thể do retire ở P1.6/P1.7.

### C.2. Bằng chứng chống double-count (cấu trúc)

| Cơ chế | Mã nguồn | Trạng thái |
|---|---|---|
| Eligibility filter unique | C01A §A.4 | canonical, áp dụng 1 lần duy nhất |
| Mask aggregate `business_date >= cutoff` | C01A §2.3 + §3.2.a | chưa có RPC; cần implement khi W04 cutover |
| Mask DE `first_work_date < cutoff` | C01A §2.3 | chưa có RPC; cần implement khi W04 cutover |
| Status `OFF` không trừ | C01A §2.2 | semantic khoá, không cần code |
| Mỗi entry = 1 dòng projection | C01A §2.1 grain_new | structural |

**F-12:** Chống double-count được đảm bảo structural bởi 5 cơ chế trên. Cả 5 cơ chế **chưa được implement** thành RPC/report; đó là phần việc của P2-W04.

### C.3. Tại sao cutoff `2026-10-17` an toàn tại baseline

- Tại `ff3cae5` (W01 commit, extends `45c99b9`):
  - Aggregate rows: **34** (đã đo bằng query thật).
  - Aggregate recruited_total: **44**.
  - DE rows: **0** (đã đo bằng query thật).
- Với cutoff `2026-10-17`:
  - Aggregate in-range: 34 rows × 44 recruited (giữ nguyên).
  - DE in-range: 0 (mask `first_work_date < 2026-10-17` lấy 0 vì DE rỗng).
  - DE after-cutoff: 0 (chưa có DE).
  - Total sau cutover = 44, **bằng aggregate hiện tại**. → Diff = 0. → **KHÔNG drop-out** cho BoD.
- Khi có DE thật (forward), mask `first_work_date >= 2026-10-17` sẽ nhặt từng entry mới. Mỗi entry = 1 người (grain `(first_work_date, project_id, recruiter_id, team_id, provider_type, labor_type)`, `recruited_count = 1`).
- Khi có DE thật (backdated về trước `2026-10-17`): **cần Owner chốt lại cutoff** về ngày trước `min(first_work_date)` của DE backdated. Đây là trigger event cho P2-W04: khi W04 phát hiện DE có first_work_date < cutoff hiện tại, nó phải dừng và yêu cầu T0 quyết định lại.

**F-13 (cập nhật, W01-R1):** W01-R1 cung cấp **production evidence thật** cho cutoff `2026-10-17`. Cutover thật yêu cầu Owner/T0:
- (a) confirm aggregate `34 rows / 44 recruited` còn đúng (W01-R1 đã xác nhận);
- (b) confirm expected total sau cutover = **44** (chỉ aggregate) → sau khi DE thật xuất hiện sẽ tăng dần;
- (c) chốt cutoff_date cụ thể (W01-R1 đề xuất `2026-10-17`, có thể điều chỉnh);
- (d) chạy gates G1–G8 của C01A §3.6 (W04 sẽ chạy).

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

### D.3. T0 LOCKED decisions (W01-R1, theo task)

> W01-R1 được lệnh khóa các quyết định T0 bên dưới. Mỗi quyết định ghi rõ **trạng thái** (LOCKED YES/NO/none/dry-run), **lý do evidence** từ Production, và **nguồn**.

| T0 decision | LOCKED value | Evidence từ Production | Nguồn / hằng số |
|---|---|---|---|
| `retain_legacy_history` | **LOCKED YES** | `aggregate rows=34, recruited_total=44, date range 2026-10-01..2026-10-16` đã được publish. Retain toàn bộ 34 rows trong `daily_recruitment_breakdown` (mask `< cutoff_date`). | T0 decision (task W01-R1) |
| `external_retained_sources` | **LOCKED NONE** | `information_schema.columns` lookup: schema `public.data_sources` **không có cột** `external_authority` / `is_external` / `is_authority`. Không có source nào được pin làm external authority trong DB. | T0 decision + evidence schema |
| `team_extension` | **LOCKED NO** | Aggregate cũ không có `team_id` (`daily_recruitment_breakdown` grain không chứa team). Mở rộng team dimension ở cutover đợt này sẽ đổi grain hiện hành. | T0 decision (task W01-R1) |
| `status_summary_ui` | **LOCKED NO** | Status `UNCONFIRMED`/`ON`/`OFF` đã canonical trong `direct_entry_employment_status_events` nhưng metric phụ (status summary) chưa implement ở reporting layer. Defer đến P2-W04. | T0 decision (task W01-R1) |
| `alerts` | **LOCKED dry-run only** | Freshness `submitted_at` > 24h = stale (C01A §3.5.d contract). Cutover đợt này chỉ log + dashboard banner; KHÔNG gửi cảnh báo. Threshold/stale là P2-W05/W06. | T0 decision (task W01-R1) |
| `totals/coverage source` | **LOCKED actual Production results** | Số liệu §B (aggregate=34/44, DE=0/0, sources=28/6 ever_succeeded) là từ query thật tại `2026-10-05`, ghi trong `docs/evidence/p2-w01-r1-baseline.json`. KHÔNG dùng default hay derived. | T0 decision (task W01-R1) |

**F-18 (mới, W01-R1):** 6 T0 decisions đã được khóa với evidence Production. Evidence JSON đính kèm (`docs/evidence/p2-w01-r1-baseline.json`) là nguồn số liệu thật, có fingerprint sha256 để reproduce. Status chỉ claim được khi evidence file tồn tại, số liệu khớp với tài liệu, và gates `pnpm docs:check` + `pnpm secrets:check` + `git diff --check` PASS.

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

## F. Risks & open items (W01-R1)

1. **Aggregate rows = 34, recruited_total = 44, date range 2026-10-01..2026-10-16 (đã đo Production).** Cutover symbolic "all-DE" sẽ tạo tổng = 0, drop-out visible. W01-R1 đề xuất cutoff `2026-10-17` để giữ nguyên 44 người.
2. **DE = 0 tại baseline (đã đo Production).** Khi có DE thật (forward, `first_work_date >= 2026-10-17`): mask nhặt, không cần điều chỉnh cutoff. Khi có DE backdated (`first_work_date < 2026-10-17`): **cần T0 chốt lại cutoff** về ngày trước `min(first_work_date)` của DE backdated. Đây là trigger event cho P2-W04.
3. **P1.7 J01 vẫn là gate.** W01-R1 không thay đổi; W01-R1 chỉ thu thập evidence.
4. **Recruiter alias backfill** (§D.2 #5) là default conditional; cần chạy 3.1.b để biết có cần hay không.
5. **28 source states (đã đo Production)** — thấp hơn P2-R00 expectation "30 active non-test" một chút. 22/28 chưa từng sync thành công. Cần Owner/T0 điều tra riêng (P2-N01 source retirement).
6. **Coverage ratio aggregate = 6/28 = 0.214 (21.4%, đã đo Production).** W01 không đề xuất cutover "all-aggregate" vì coverage thấp. Cutoff `2026-10-17` vẫn giữ 34 rows × 44 recruited (là rows đã có, không phụ thuộc coverage mới).
7. **Fingerprint stability:** `aggregate_fingerprint_sha256 = 7abfbdab53b0f1b01bd119a02b5ebe5417f3a369d7a9ccdba26e425b2106b1bd` sẽ thay đổi khi có dữ liệu aggregate mới. Nếu W04 chạy muộn hơn W01-R1 nhiều ngày, cần re-baseline lại fingerprint.
8. **Backdated DE chưa được test.** Cutoff `2026-10-17` chỉ safe cho forward DE. Test case "DE backdated" sẽ là W04 acceptance test.
9. **Truy vấn E.6** dùng `cutoff = date '9999-12-31'` chỉ để test mask; Owner/W04 phải thay bằng `'2026-10-17'` khi chạy G3 gate.

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

---

## H. Run artifacts (W01-R1)

### H.1. Script chạy read-only

| File | Vai trò |
|---|---|
| `scripts/p2-w01-r1-baseline.mjs` | Mở `pg.Client` qua `loadSupabaseConfig()` + `buildSslOptions()` (helpers có sẵn, không viết DB client mới). Trong 1 transaction: `BEGIN` → `SET TRANSACTION READ ONLY` → `SET LOCAL statement_timeout='15s'` → 19 SELECT queries (aggregate, DE, overlap, source registry, today) → `ROLLBACK` → `client.end()`. Output atomic rename từ `.tmp` → `OUT_PATH`. |
| `scripts/p2-w01-r1-verify-date.mjs` | Probe tay: xác nhận cách Postgres trả `date` qua session UTC (tránh nhầm ±1 ngày). Đã dùng để chọn `to_char(..., 'YYYY-MM-DD')` thay vì cast date object. |
| `scripts/p2-w01-r1-tx-probe.mjs` | Probe transaction state (BEGIN + SET TRANSACTION READ ONLY + SET LOCAL). |
| `scripts/lib/load-supabase-config.mjs` | (repo có sẵn) đọc config ngoài repo. |
| `scripts/lib/supabase-tls.mjs` | (repo có sẵn) pin TLS root CA. |

**Không có file mới nào trong `src/lib/`, `supabase/migrations/`, `supabase/tests/`, `src/app/api/`, `package.json`, `pnpm-lock.yaml`.** Chỉ thêm 3 script trong `scripts/` (probe + baseline + verify).

### H.2. Output JSON evidence

| File | Vai trò |
|---|---|
| `docs/evidence/p2-w01-r1-baseline.json` | Atomic output của `scripts/p2-w01-r1-baseline.mjs` tại `2026-10-05`. Mọi số liệu §B, §C đều xuất phát từ file này. Có fingerprint sha256. |

### H.3. PII / secrets policy

- Script **không** in: `databaseUrl`, `password`, `secretKey`, `publishableKey`, `projectRef` đầy đủ, `supabaseConfigFile` đầy đủ, PII, tên NLĐ, CCCD, payment, document, connection string.
- Chỉ in summary ra `stderr` với aggregate counts/date ranges/fingerprint.
- JSON output: không có PII, chỉ counts + date strings + sha256.
- `p2_w01_r1_baseline.json` KHÔNG chứa field nào từ PII.
