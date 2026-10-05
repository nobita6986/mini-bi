# P2-C01A — Direct Entry → Reporting Reconciliation Contract DRAFT

| Attribute | Value |
|---|---|
| Status | `P2-C01A_REPORTING_CONTRACT_DRAFT_READY_FOR_POST_P1_7_BASELINE` |
| Base | `origin/main @ 27309ba295696b40ad97117e136d621a08265a29` |
| Worktree | `C:\CodeApp\BI-p2-c01a-reporting-contract` (branch `audit/p2-c01a-reporting-contract-draft`) |
| Primary worktree `C:\CodeApp\BI` | Không chạm (đang dirty, Owner chưa commit) |
| Scope | Docs-only + read-only verification |
| T0/T2 dependency | P1.7 J01 Owner Production acceptance vẫn là gate trước khi chạy truy vấn reconciliation |
| Companion | `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` |
| Companion rebaseline | `docs/handoffs/p2-r00-readiness-audit.md`, `docs/roadmaps/p2-post-direct-entry-rebaseline.md` |
| Runtime impact | Không. Không sửa source, migration, RPC, view, package, env, deployment, Production data. |
| Pending status list (không thay) | Pending list — không thay. Tài liệu này **chỉ** draft contract; không tuyên bố P2 PASS / cutover ready / Production ready. |

---

## Outcome

Contract draft soạn xong, sẵn sàng cho T0 review sau khi P1.7 J01 đóng. Nó khoá:
- source-verify: reporting hiện đọc từ `public.daily_recruitment_breakdown` (aggregate) + `data_sources` + `sync_runs` + 3 view service-role-only (`reporting_latest_sync_runs_v01`, `reporting_sources_with_current_facts_v01`, `reporting_dimension_options_view`); Direct Entry canonical = `direct_entry_submissions` (state `SUBMITTED`), `direct_entries`, `direct_entry_employment_status_events`, `recruiters`, `recruiter_aliases`, `recruiter_provider_memberships`, `recruiter_team_memberships`, `teams`, `direct_entry_projects`.
- grain, metric, ngày ghi nhận, attribution rules, lineage/coverage/freshness DRAFT.
- cutoff rule + "không double-count" tuyệt đối (mask aggregate sau cutoff, mask Direct Entry trước cutoff).
- 8 truy vấn reconciliation (DRAFT, không chạy trong task này) + PASS/FAIL cutover gate (G1–G8) + rollback/no-cutover plan.
- 8 quyết định Owner/T0 còn cần trước khi freeze (cutoff date, retain history, retained external sources, expected totals/coverage, recruiter alias backfill, team dimension, status summary metric, stale threshold/channel).

Contract này **không**:
- Bump version của `p1-reporting/0.1` hay `daily-recruitment-breakdown/0.2` (additive draft).
- Sửa source/runtime/migration/API/package/lockfile/env/workflow.
- Mutate Production DB hay deployment.
- Chạy truy vấn reconciliation (đó là work sau P1.7 J01).
- Tuyên bố P2 PASS, cutover ready, hay Production ready.

---

## Evidence and finding register

| ID | Evidence | Finding |
|---|---|---|
| E-01 | P2-R00 handoff (`p2-r00-readiness-audit.md`) đã đối chiếu P1 reporting read model là aggregate và Direct Entry là canonical transaction. | F-01: Source-verify có thể kế thừa trực tiếp; không phải re-investigate. |
| E-02 | P2 rebaseline (`p2-post-direct-entry-rebaseline.md`) §"Capability decisions" quyết: Reconciliation KEEP, External Ingestion DEFER; "không build dispatcher Sheet định kỳ". | F-02: Truy vấn reconciliation draft **chỉ** so sánh aggregate hiện hành vs Direct Entry, không bao gồm ingestion mới. |
| E-03 | Migration `20261002170000_p1_6_direct_entry_foundation.sql` định nghĩa canonical schema với CHECK trên `provider_type`, `labor_type`, `submission.state = 'SUBMITTED' ⇔ submitted_at IS NOT NULL`, unique `(employee_code)`, half-open `[valid_from, valid_to)` cho membership/alias. | F-03: Eligibility của Direct Entry = `state='SUBMITTED' AND deleted_at IS NULL`. Attestation `recruiter_id` qua `recruiter_aliases.reporting_key` tại `first_work_date`. |
| E-04 | P1.7 bổ sung `direct_entry_list_own_drafts` (`20261006010000`) chỉ cho UI lifecycle; server-employee-code (`20261007010000`) ảnh hưởng `direct_entries.employee_code`. | F-04: `employee_code` chỉ server ghi; UI chỉ hiển thị. Reconciliation **không** truy cột này. |
| E-05 | Migration `20261001130100_p0_daily_recruitment_breakdown_foundation.sql` định grain `(source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key) = recruited_count`; `recruitment_dimension_key()` chuẩn hóa NFC → trim → gộp ws → lowercase. | F-05: Cùng `recruitment_dimension_key()` được dùng để map project/recruiter/employment khi Direct Entry join vào. |
| E-06 | Migration `20261001150100/...150200/...150300` định 3 view service-role-only cho reporting (`reporting_latest_sync_runs_v01`, `reporting_sources_with_current_facts_v01`, `reporting_dimension_options_view`). | F-06: Coverage/freshness signal của aggregate đến biết khi `data_sources.latest_run_status`; Direct Entry không có `data_sources` tương đương. F-06 cần coverage/freshness thay thế (xem §3.5). |
| E-07 | `docs/contracts/p1-reporting-v0.1.md` đã khoá filter contract (date range inclusive theo Asia/Ho_Chi_Minh, dimension filters AND, URL dùng normalized key, source UUID). | F-07: Truy vấn reconciliation draft không filter thêm (chỉ so full extent), để tránh ảnh hưởng dashboard. |
| E-08 | `docs/contracts/daily-recruitment-breakdown-v0.2.md` §5.1 đã khoá display canonical HRP/Vendor và Thời vụ/Chính thức. | F-08: Direct Entry `provider_type` ∈ {`hrp`,`vendor`} và `labor_type` → `employment_type` mapping dùng cùng key với aggregate, nên join chính xác không cần alias. |
| E-09 | `docs/contracts/p1.6-direct-entry-v1.md` §1: `recruiter_id` chỉ match actor qua `app_user_recruiter_links` (verified effective); không match qua name/email/phone. Status initial event = `UNCONFIRMED` (§5). | F-09: Reporting projection dùng `recruiter_id` trên entry (giá trị đã chọn tại submit); chỉ resolve alias để hiển thị theo bucket hiện hành. Status `UNCONFIRMED` được tính vào `recruited_total` vì entry đã SUBMITTED (xem §1.3 contract). |
| E-10 | Codegraph `src/lib/reporting/p1-reporting.ts` định `ReportingData`, `ReportingFact`, `ReportingBucket`, `ProjectProviderMix`; server đọc `daily_recruitment_breakdown` + views. | F-10: Reporting read path xác nhận contract hiện hành; projection DRAFT không đụng types hiện tại (chỉ là tài liệu tham chiếu). |
| E-11 | `docs/handoffs/p1.7-h05-direct-entry-production-ui-fixes.md` (R1 commit `27309ba`) đã close source-level UI gaps; `employee_code` chỉ server cấp; không có migration mới. | F-11: Source-verify an toàn tại `27309ba`; P1.7 J01 vẫn là gate thật (Owner Production UAT chưa chạy trong worktree này). |
| E-12 | `docs/P2.md` §P2-C01 định nghĩa dependency `W01/N01` + quyết định mục 3. | F-12: Draft này chưa freeze; tuân thủ P2-C01 acceptance (decisions PO chưa chốt được ghi blocker). |

---

## Scope and checks

| Hạng mục | Trạng thái |
|---|---|
| Source-verify (dashboard, Direct Entry canonical, definitions) | Đã đọc qua codegraph + migrations + contracts; trong contract §1 |
| Soạn contract draft (grain, metric, cutoff, no-double-count, version/correction, lineage/coverage/freshness) | Trong contract §2 |
| Truy vấn reconciliation dạng tài liệu (không chạy) | Trong contract §3; G1–G8 cutover gate; §3.7 rollback/no-cutover |
| Quyết định Owner/T0 còn cần | Trong contract §4 (8 quyết định) |
| Sửa `docs/P2.md` / `docs/P3.md` / `docs/master-plan.md` | Không sửa (theo task) |
| Sửa source/runtime/API/migration/package/lockfile/env/workflow | Không sửa (theo task) |
| Mutate Production DB / deployment | Không (theo task) |
| Browser/UI UAT | Không (Owner trực tiếp UAT — theo task) |

---

## Deliverables

| Path | Trạng thái | SHA |
|---|---|---|
| `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` | Created (DRAFT) | (commit sẽ có ở bước cuối) |
| `docs/handoffs/p2-c01a-reporting-contract-draft.md` | Created (handoff này) | (commit sẽ có ở bước cuối) |

---

## Files actually changed (expected after gates PASS)

- `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` (new)
- `docs/handoffs/p2-c01a-reporting-contract-draft.md` (new)

---

## Gate results (expected when this handoff ships)

| Check | Result | Note |
|---|---|---|
| `pnpm docs:check` | (chạy trong bước gates) | |
| `pnpm secrets:check` | (chạy trong bước gates) | |
| `git diff --check` | (chạy trong bước gates) | |
| Worktree sạch sau commit | (verify) | |
| Branch push thành công | (verify) | |

---

## Risks & open items

1. **Cutoff date chưa chốt.** §4 quyết định 1 phải có trước khi chạy 3.3 / 3.4 / 3.6. Nếu cutoff thay đổi sau P1.7 J01, các truy vấn cần chạy lại.
2. **Alias coverage chưa đoàn.** §3.1.b là gate G2; nếu FAIL, Owner cần backfill `recruiter_aliases` (quyết định 5) trước cutover. Hiện không có metric baseline cho "coverage alias tại first_work_date"; cần 1 lệnh đếm riêng trước P1.7 J01.
3. **Team dimension chưa chốt.** Aggregate cũ không có `team`; nếu Owner muốn thêm, contract cần bump version và migration helper key (chưa thuộc draft này).
4. **Status summary metric chưa chốt.** `direct-entry/1.1` §5 cho phép, nhưng draft giữ ngoài `recruited_total` để tránh tác động dashboard. Quyết định 7.
5. **Stale threshold.** Threshold freshness `submitted_at` thuộc P2-W05/W06; draft ghi "theo Owner threshold" nhưng không freeze.
6. **No P2-C01 implementation.** Task này là P2-C01A (draft). P2-C01B/C (freeze, bump, execute cutover) là task tương lai — không nằm trong phạm vi.

---

## Gate and immediate next steps (for Owners)

1. T0 review draft contract sau P1.7 J01 đóng.
2. Owner trả lời 8 quyết định §4.
3. N8N review khi `gt`-style reconciliation cadence được chốt (P2-N03 theo `docs/P2.md`).
4. Sau khi freeze, có thể bump thành `p2-reporting/1.0` và mở task P2-C01B/C cho cutover thật.

---

## Capability disposition (reconciliation scope only)

| Capability | Disposition trong draft này |
|---|---|
| So sánh aggregate vs Direct Entry | DRAFT (§3.3) |
| Mask aggregate / mask Direct Entry tại cutoff | DRAFT (§3.2) |
| Coverage (Direct Entry) | DRAFT (§3.5.c) — thay thế `coverage_ratio` của `p1-reporting/0.1` |
| Freshness (Direct Entry) | DRAFT (§3.5.b) — thay thế `last_successful_sync_at` |
| Rekey / alias backfill | Không thuộc task này (P2-W02 theo rebaseline) |
| Cutover thật | Không thuộc task này |
| Source retirement | Không thuộc task này (P2-W04 theo rebaseline) |
| Restore / RPO / RTO | Không thuộc task này (P2-W07 theo rebaseline) |

---

## Status tối đa

`P2-C01A_REPORTING_CONTRACT_DRAFT_READY_FOR_POST_P1_7_BASELINE`

Không tuyên bố P2 PASS, cutover ready, hay Production ready.