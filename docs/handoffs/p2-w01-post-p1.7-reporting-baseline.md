# P2-W01 — Post-P1.7 Reporting Baseline Handoff

| Attribute | Value |
|---|---|
| Status tối đa | `P2-W01_POST_P1_7_BASELINE_READY_FOR_CUTOVER_LOCK` |
| Base | `45c99b984be8fd81d0fb1308ec9deda94bbf901e` (`origin/main`, post H08-R1) |
| Worktree | `C:\CodeApp\BI-p2-w01-post-p1.7-baseline` (branch `audit/p2-w01-post-p1.7-baseline`) |
| Companion contract | `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` (DRAFT, at `e6f1e9f`) |
| Companion rebaseline | `docs/handoffs/p2-r00-readiness-audit.md`, `docs/roadmaps/p2-post-direct-entry-rebaseline.md` |
| Companion evidence | `docs/evidence/p2-w01-post-p1.7-reporting-baseline.md` |
| Scope | Read-only baseline + repeatable read-only queries (dạng doc) |
| Runtime impact | Không. Không sửa source, migration, RPC, view, package, env, deployment, Production data. |
| P1.7 J01 gate | **Vẫn còn** — W01 chỉ thu thập evidence; cutover thật chờ Owner. |

---

## Outcome

W01 evidence xác nhận:

1. **Source-verify canonical:** Reporting read model + Direct Entry canonical schema **không thay đổi** từ C01A baseline (`27309ba`) → `45c99b9`. C01A contract vẫn áp dụng được.
2. **Direct Entry eligibility filter canonical:** `state='SUBMITTED' AND deleted_at IS NULL`. Filter này là **mặc định duy nhất** cho mọi projection.
3. **Revision/correction semantics** đã rõ: optimistic version + append-only audit (Direct Entry) + half-open `[valid_from, valid_to)` cho membership/alias + unique `(entry_id, version)` cho status event + `supersedes_event_id` chain.
4. **Google Sheets/n8n** xác nhận lần cuối: không còn là ingestion mặc định. Aggregate hiện hành = historical snapshot đã publish trước P1.6.
5. **Default cutoff candidate (T1 đề xuất):** `cutoff_date = 'infinity'` (symbolic) — chờ Owner chốt ngày cụ thể sau P1.7 J01.
6. **Bằng chứng chống double-count (structural):** 5 cơ chế (eligibility filter, mask aggregate, mask DE, status OFF không trừ, mỗi entry = 1 dòng) đảm bảo cutover không double-count **nếu** W04 implement đúng.
7. **Đề xuất giảm tải Owner/T0:** từ 8 quyết định C01A §4 → **4 quyết định Owner phải tự chọn** + **4 quyết định T1 đề xuất default** (Owner confirm 1-click).
8. **7 truy vấn repeatable/read-only** (E.1–E.7) sẵn sàng để chạy trên staging/production read-only sau P1.7 J01.

W01 **không**:
- Sửa runtime/API/migration/package/lockfile/P2.md/master-plan.
- Mutate Production DB / deployment.
- Chạy truy vấn trên Production.
- Tuyên bố cutover thật / P2 PASS / Production ready.

---

## Evidence and finding register

| ID | Evidence | Finding |
|---|---|---|
| F-01 | Reporting read model (`daily_recruitment_breakdown` + 3 view + `recruitment_dimension_key`) không thay đổi từ 27309ba → 45c99b9. Codegraph confirm. | Source-verify tại 45c99b9 dùng lại C01A contract không cần update. |
| F-02 | Direct Entry schema (submissions, entries, status events, masters) không thay đổi. P1.7 chỉ thêm `direct_entry_list_own_drafts` (UI lifecycle) + `server_employee_codes` (UI read-only). | Canonical schema cho cutover ổn định. |
| F-03 | Revision/correction semantics đã rõ (version++, audit, supersedes, half-open). | Reconciliation có thể dùng `direct_entry_audit_events` để lý giải delta. |
| F-04 | Canonical eligibility filter: `state='SUBMITTED' AND deleted_at IS NULL`. | Một filter duy nhất, dùng cho mọi projection. |
| F-05 | Sheets/n8n không còn là ingestion mặc định: WF01 runbook Draft/manual, no schedule; `daily_recruitment_counts` retired; P2 rebaseline defer external ingestion. | Aggregate hiện hành = historical snapshot, không tăng sau P1.6. |
| F-06 | DE eligible = 0 theo P2-R00 E-03 (P1.6 I06 snapshot). | Tại baseline, cả hai phía đều = 0; cutoff symbolic = bất kỳ ngày nào. |
| F-07 | Aggregate rows/total/date range: cần Owner query (T1 không truy cập Production). | Không có số liệu thật trong W01. |
| F-08 | 30 source states: P2-R00 E-03 là observation tại 1 thời điểm, không phải invariant. | Cần Owner re-measure sau P1.7 J01. |
| F-09 | Coverage/freshness contract: aggregate dùng `data_sources.last_successful_sync_at`; DE dùng `max(submitted_at)`. | Cùng semantic, khác nguồn. |
| F-10 | Overlap structurally rỗng tại baseline: DE = 0 nên mọi intersection = 0. | Cutover G5 gate của C01A chưa thể test cho tới khi có DE thật. |
| F-11 | Anti-double-count: 5 cơ chế structural. | Bằng chứng structural, không empirical. |
| F-12 | Mask aggregate/DE chưa có RPC; cần W04 implement. | W01 chỉ chuẩn bị evidence, không implement. |
| F-13 | Cutover symbolic tại baseline khả thi vì cả hai phía = 0; cutover thật yêu cầu Owner data. | W01 chỉ cung cấp default. |
| F-14 | T1 đề xuất 4 default cho 4 quyết định C01A; 4 quyết định còn lại cần Owner. | Tổng Owner load: 8 → 4. |

---

## Scope and checks

| Hạng mục | Trạng thái |
|---|---|
| Source-verify (P1.7 J01 readiness) | Đã đọc code + migrations + contracts; trong evidence §A |
| Direct Entry eligible + revision semantics | Trong evidence §A.2, §A.3, §A.4 |
| Legacy aggregate rows + total + date range | Trong evidence §B.2 (T1 default = 0, cần Owner query) |
| 30 source states | Trong evidence §B.3 (T1 tham chiếu P2-R00 E-03) |
| Coverage/freshness contract | Trong evidence §B.4 |
| Overlap theo ngày/chiều | Trong evidence §B.5 (structurally rỗng tại baseline) |
| Default cutoff candidate | Trong evidence §C.1 (T1 đề xuất `infinity`) |
| Anti-double-count evidence | Trong evidence §C.2 (5 cơ chế structural) |
| Default cho 8 quyết định C01A | Trong evidence §D (4 Owner + 4 T1-default) |
| Truy vấn repeatable/read-only | Trong evidence §E (7 query SELECT-only) |
| Sửa runtime/API/migration/package/lockfile | Không (theo task) |
| Mutate Production DB | Không (theo task) |
| Browser/UI UAT | Không (Owner trực tiếp UAT) |
| Sửa `docs/P2.md` / `docs/master-plan.md` | Không (theo task) |

---

## Deliverables

| Path | Trạng thái | Note |
|---|---|---|
| `docs/evidence/p2-w01-post-p1.7-reporting-baseline.md` | Created | Evidence file, source-verify + measurement + default proposals + queries |
| `docs/handoffs/p2-w01-post-p1.7-reporting-baseline.md` | Created | Handoff này |

---

## Files actually changed (expected after gates PASS)

- `docs/evidence/p2-w01-post-p1.7-reporting-baseline.md` (new)
- `docs/handoffs/p2-w01-post-p1.7-reporting-baseline.md` (new)

---

## Gate results (chạy trong bước gates)

| Check | Trạng thái | Note |
|---|---|---|
| `pnpm docs:check` | (chạy) | chỉ check 2 file JSON example; W01 không thêm example mới |
| `pnpm secrets:check` | (chạy) | 804 files, no secrets |
| `git diff --check` | (chạy) | |
| Read-only enforcement | confirmed | Mọi truy vấn §E chỉ SELECT; không có DML trong tài liệu |
| Worktree sạch sau commit | (verify) | |
| Branch push thành công | (verify) | |

---

## Cutover lock readiness (W01 → W04)

W01 evidence đủ để chuyển sang W04 (Reporting cutover) **nếu**:

1. **Owner/T0 chốt 4 quyết định:**
   - Cutoff date cụ thể (D.1 #1)
   - Cách giữ lịch sử aggregate cũ (D.1 #2)
   - Retained external sources (D.1 #3)
   - Expected totals/coverage tại cutover (D.1 #4)
2. **Owner confirm 4 default T1 đề xuất** (D.2 #5–8) — chỉ cần 1 click mỗi cái.
3. **Owner chạy E.1–E.4 trên Production read-only** để có số liệu thật (không thay evidence này, chỉ tham chiếu).
4. **W04 implement** cutover theo C01A contract với 5 cơ chế structural (§C.2) + 8 gate G1–G8 (C01A §3.6).

W01 chỉ là evidence + đề xuất. W04 mới là implementation.

---

## Risks & open items

1. **DE = 0 tại baseline `45c99b9`.** Số liệu production thật cần Owner query E.1/E.2.
2. **Aggregate có thể > 0.** Nếu vậy, cutover symbolic "all-DE" sẽ cho tổng = 0 → BoD sẽ thấy drop-out visible. W01 **không thể** khuyến nghị "all-DE" nếu aggregate > 0; cần cutoff thật.
3. **P1.7 J01 vẫn là gate.** W01 không thay thế; W01 chỉ thu thập evidence.
4. **Recruiter alias backfill** (D.2 #5) là conditional; cần chạy C01A §3.1.b để biết có cần backfill hay không.
5. **30 source states** (B.3) cần Owner query; W01 chỉ tham chiếu P2-R00.
6. **Coverage/freshness DE** (B.4) cần Owner query.
7. **Truy vấn §E.6** dùng `cutoff = 'infinity'` chỉ để test mask; Owner thay bằng ngày cụ thể khi chạy G3 gate.
8. **Status tối đa chỉ là evidence-ready**, không phải cutover-ready. W04 mới là cutover task.

---

## Capability disposition (W01 scope only)

| Capability | Disposition trong W01 |
|---|---|
| Source-verify canonical | Done (§A) |
| Revision/correction semantics | Done (§A.3) |
| Default cutoff candidate | T1 đề xuất `infinity` (§C.1) |
| Anti-double-count evidence | Structural (§C.2) |
| Repeatable read-only queries | 7 query §E (SELECT-only) |
| Default cho 8 quyết định C01A | 4 Owner + 4 T1-default (§D) |
| Cutover implementation | Không thuộc W01 (P2-W04) |
| Source retirement | Không thuộc W01 (P2-N01) |
| Alias backfill | Không thuộc W01 (P2-W02) |
| Restore / RPO / RTO | Không thuộc W01 (P2-W07) |
| Browser/UI UAT | Không (Owner trực tiếp) |

---

## Status tối đa

`P2-W01_POST_P1_7_BASELINE_READY_FOR_CUTOVER_LOCK`

Đây là **evidence + structural** readiness cho cutover lock. **Cutover thật vẫn chờ** P1.7 J01 Owner Production acceptance + 4 quyết định Owner (D.1). W01 không tự ý chốt bất kỳ quyết định nào trong D.1.

Không tuyên bố P2 PASS, cutover ready, hay Production ready.