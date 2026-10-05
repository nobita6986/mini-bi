# P2-W01 — Post-P1.7 Reporting Baseline Handoff

| Attribute | Value |
|---|---|
| Status tối đa | **`P2-W01-R1_LIVE_BASELINE_READY_FOR_CUTOVER_LOCK`** (W01-R1, evidence Production thật) |
| Status trước (W01 gốc) | `P2-W01_POST_P1_7_BASELINE_READY_FOR_CUTOVER_LOCK` (code-only evidence) |
| Base | `ff3cae507ea2ffe988206ccc10145f8142b94ccc` (W01 commit) — extends `45c99b984be8fd81d0fb1308ec9deda94bbf901e` (post H08-R1) |
| Worktree | `C:\CodeApp\BI-p2-w01-post-p1.7-baseline` (branch `audit/p2-w01-post-p1.7-baseline`) |
| Companion contract | `docs/contracts/p2-direct-entry-reporting-reconciliation-contract-draft.md` (DRAFT, at `e6f1e9f`) |
| Companion rebaseline | `docs/handoffs/p2-r00-readiness-audit.md`, `docs/roadmaps/p2-post-direct-entry-rebaseline.md` |
| Companion evidence | `docs/evidence/p2-w01-post-p1.7-reporting-baseline.md` (W01-R1) + `docs/evidence/p2-w01-r1-baseline.json` (Production evidence thật) |
| Scope | W01-R1: read-only Production baseline (transaction `READ ONLY` + statement timeout + ROLLBACK). Thay số liệu placeholder bằng Production evidence. Khóa T0 decisions. Cập nhật 2 file W01. |
| Runtime impact | Không. Không sửa source, migration, RPC, view, package, env, deployment, Production data. Chỉ thêm 3 script trong `scripts/` (probe + baseline + verify) — tất cả chạy read-only. |
| P1.7 J01 gate | Vẫn là gate cho cutover thật; W01-R1 không thay thế. Combined UAT được hoãn đến cuối P3. |

---

## Outcome

W01-R1 evidence (Production read-only tại `2026-10-05`) xác nhận:

1. **Source-verify canonical** (unchanged): Reporting read model + Direct Entry canonical schema **không thay đổi** từ C01A baseline (`27309ba`) → `ff3cae5`. C01A contract vẫn áp dụng được.
2. **Direct Entry eligibility filter canonical** (unchanged): `state='SUBMITTED' AND deleted_at IS NULL`. Filter này là **mặc định duy nhất** cho mọi projection.
3. **Production aggregate (live)**: `34 rows`, `recruited_total = 44`, date range `2026-10-01..2026-10-16`, 6 distinct sources. Fingerprint sha256 = `7abfbdab53b0f1b01bd119a02b5ebe5417f3a369d7a9ccdba26e425b2106b1bd`.
4. **Production Direct Entry (live)**: 0 entries, 0 submissions (mọi state), 0 candidates, 0 eligible. DE phía rỗng hoàn toàn.
5. **Production source registry (live)**: 28 sources total (28 active, 26 non-test, 2 test), 6 ever succeeded, 4 latest run `succeeded`, 24 latest run `failed`. Không có cột external authority trong schema ⇒ không có source nào được pin làm external authority.
6. **Candidate cutoff (live-derived)**: `cutoff_date = 2026-10-17` (theo rule "DE eligible = 0" → `max(legacy_max+1, hcm_today) = max(2026-10-17, 2026-10-05) = 2026-10-17`). Cutoff cụ thể, có thể thực thi, không dùng `'infinity'`.
7. **T0 decisions LOCKED**: retain_legacy_history=YES, external_retained_sources=NONE, team_extension=NO, status_summary_ui=NO, alerts=dry-run only, totals/coverage=actual Production results.
8. **Anti-double-count vẫn structural** (5 cơ chế C01A §2.3/§2.4); W01-R1 bổ sung cutoff cụ thể `2026-10-17` để mask rời nhau (`< cutoff` cho aggregate, `>= cutoff` cho DE).
9. **Coverage ratio aggregate** = `6/28 = 0.214` (21.4%, đã đo Production). 22/28 source chưa từng sync thành công. W01-R1 **không** đề xuất cutover "all-aggregate" vì coverage thấp.

W01-R1 **không**:
- Sửa runtime/API/migration/package/lockfile/P2.md/master-plan.
- Mutate Production DB / deployment.
- Tuyên bố cutover thật / P2 PASS / Production ready.
- Đẩy `'infinity'` làm cutoff.

---

## Evidence and finding register

| ID | Evidence | Finding |
|---|---|---|
| F-01 | Reporting read model (`daily_recruitment_breakdown` + 3 view + `recruitment_dimension_key`) không thay đổi từ 27309ba → ff3cae5. Codegraph confirm. | Source-verify tại ff3cae5 dùng lại C01A contract không cần update. |
| F-02 | Direct Entry schema (submissions, entries, status events, masters) không thay đổi. P1.7 chỉ thêm `direct_entry_list_own_drafts` (UI lifecycle) + `server_employee_codes` (UI read-only). | Canonical schema cho cutover ổn định. |
| F-03 | Revision/correction semantics đã rõ (version++, audit, supersedes, half-open). | Reconciliation có thể dùng `direct_entry_audit_events` để lý giải delta. |
| F-04 | Canonical eligibility filter: `state='SUBMITTED' AND deleted_at IS NULL`. | Một filter duy nhất, dùng cho mọi projection. |
| F-05 | Sheets/n8n không còn là ingestion mặc định: WF01 runbook Draft/manual, no schedule; `daily_recruitment_counts` retired; P2 rebaseline defer external ingestion. | Aggregate hiện hành = historical snapshot, không tăng sau P1.6. |
| F-15 (NEW) | DE total = 0, eligible = 0, submissions = 0, candidates = 0 (đo Production tại 2026-10-05). | Direct Entry rỗng hoàn toàn. Gate G5/G6 (C01A §3.3 / §3.5) chưa thể chạy ở W01-R1. |
| F-16 (NEW) | Source registry = 28 sources, 22 chưa từng sync thành công. Schema không có cột `external_authority` / `is_external` / `is_authority`. | P2-R00 expectation "30 active non-test" đã giảm 4 source; không có external authority. |
| F-17 (NEW) | Coverage ratio aggregate = 6/28 = 0.214 (21.4%). 22 source chưa từng sync thành công. | Không đề xuất cutover "all-aggregate"; cutoff 2026-10-17 giữ rows đã có, không phụ thuộc coverage mới. |
| F-10 (UPDATE) | Overlap intersection cardinality = 0 vì DE rỗng. Aggregate date range = 2026-10-01..2026-10-16. | Cutover với cutoff ≤ min(legacy_min) mask aggregate hoàn toàn; cutoff nằm trong khoảng aggregate giữ một phần; cutoff > max(legacy_max) giữ toàn bộ. |
| F-11 | Anti-double-count: 5 cơ chế structural (C01A §C.2). | Bằng chứng structural, không empirical. W01-R1 bổ sung cutoff 2026-10-17 để mask rời nhau. |
| F-12 | Mask aggregate/DE chưa có RPC; cần W04 implement. | W01-R1 chỉ chuẩn bị evidence + cutoff; không implement. |
| F-13 (UPDATE) | Cutoff 2026-10-17: aggregate in-range = 34 rows × 44 recruited (giữ nguyên); DE in-range = 0; total sau cutover = 44. Diff = 0 ⇒ KHÔNG drop-out. Khi DE backdated xuất hiện, cần T0 chốt lại cutoff. | Cutoff cụ thể, có thể thực thi. T0 quyết định cuối cùng. |
| F-14 | T1 đề xuất 4 default cho 4 quyết định C01A; 4 quyết định còn lại cần Owner. | Tổng Owner load: 8 → 4. |
| F-18 (NEW) | T0 LOCKED decisions: retain_legacy_history=YES, external_retained_sources=NONE, team_extension=NO, status_summary_ui=NO, alerts=dry-run only, totals/coverage=actual Production. | 6 T0 decisions đã khóa với evidence Production (xem evidence §D.3). |

---

## Scope and checks

| Hạng mục | Trạng thái |
|---|---|
| Source-verify (P1.7 J01 readiness) | Đã đọc code + migrations + contracts; trong evidence §A |
| Direct Entry eligible + revision semantics | Trong evidence §A.2, §A.3, §A.4 |
| Legacy aggregate rows + total + date range | **Live Production**: 34 rows, 44 người, 2026-10-01..2026-10-16 (evidence §B.1) |
| Direct Entry eligible + counts | **Live Production**: 0/0/0/0 (evidence §B.2) |
| Source registry | **Live Production**: 28 sources, 22 chưa từng sync (evidence §B.3) |
| Coverage / freshness | **Live Production**: ratio 6/28 = 0.214 (evidence §B.4) |
| Overlap theo ngày/chiều | **Live Production**: aggregate 16 dates / 10 projects / 13 recruiters / 3 providers / 3 employments; DE 0/0/0/0 (evidence §B.5) |
| Candidate cutoff | **Live Production-derived**: 2026-10-17 (evidence §C.1) |
| Anti-double-count evidence | 5 cơ chế structural + cutoff 2026-10-17 (evidence §C.2 + §C.3) |
| T0 LOCKED decisions | 6 decisions khóa với evidence Production (evidence §D.3) |
| Default cho 8 quyết định C01A | 4 Owner + 4 T1-default (evidence §D) |
| Truy vấn repeatable/read-only | 7 query §E (SELECT-only) |
| Read-only Production evidence file | `docs/evidence/p2-w01-r1-baseline.json` (atomic rename từ .tmp) |
| Run script (read-only) | `scripts/p2-w01-r1-baseline.mjs` (dùng `loadSupabaseConfig` + `buildSslOptions` + `pg.Client` có sẵn) |
| Sửa runtime/API/migration/package/lockfile | Không (theo task) |
| Mutate Production DB | Không (theo task — READ ONLY + ROLLBACK) |
| Browser/UI UAT | Không (Owner trực tiếp UAT) |
| Sửa `docs/P2.md` / `docs/master-plan.md` | Không (theo task) |

---

## Deliverables

| Path | Trạng thái | Note |
|---|---|---|
| `docs/evidence/p2-w01-post-p1.7-reporting-baseline.md` | Updated (W01 → W01-R1) | Evidence file với số liệu Production thật, T0 LOCKED, cutoff 2026-10-17, run artifacts |
| `docs/handoffs/p2-w01-post-p1.7-reporting-baseline.md` | Updated (W01 → W01-R1) | Handoff này |
| `docs/evidence/p2-w01-r1-baseline.json` | New | Atomic output của baseline script; máy-đọc-được |
| `scripts/p2-w01-r1-baseline.mjs` | New | Read-only Production baseline script |
| `scripts/p2-w01-r1-verify-date.mjs` | New | Probe date interpretation |
| `scripts/p2-w01-r1-tx-probe.mjs` | New | Probe transaction state |

---

## Files actually changed (W01-R1)

- `docs/evidence/p2-w01-post-p1.7-reporting-baseline.md` (updated)
- `docs/handoffs/p2-w01-post-p1.7-reporting-baseline.md` (updated)
- `docs/evidence/p2-w01-r1-baseline.json` (new)
- `scripts/p2-w01-r1-baseline.mjs` (new)
- `scripts/p2-w01-r1-verify-date.mjs` (new)
- `scripts/p2-w01-r1-tx-probe.mjs` (new)

**Không thay đổi:** `src/lib/`, `supabase/migrations/`, `supabase/tests/`, `src/app/api/`, `package.json`, `pnpm-lock.yaml`, `docs/P2.md`, `docs/master-plan.md`, `docs/contracts/*`, `docs/roadmaps/*`, `docs/handoffs/p2-r00-readiness-audit.md`.

---

## Gate results (W01-R1)

| Check | Trạng thái | Note |
|---|---|---|
| Transaction READ ONLY evidence | PASS | `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout='15s'; ...; ROLLBACK;` (xem `scripts/p2-w01-r1-baseline.mjs`) |
| `pnpm docs:check` | (chạy) | W01-R1 thêm file JSON evidence mới trong `docs/evidence/`; cần verify scripts/check-docs.mjs chấp nhận JSON. |
| `pnpm secrets:check` | (chạy) | 804+ files, no secrets. Evidence JSON không chứa secret. |
| `git diff --check` | (chạy) | Kiểm tra trailing whitespace, conflict markers, line endings. |
| PII / secrets leak check | PASS | Script không in PII/secret; JSON chỉ có counts/date strings/sha256. |
| Worktree sạch sau commit | (verify) | Sau khi `git add` + `git commit`, working tree phải clean. |
| Branch push thành công | (verify) | `git push origin audit/p2-w01-post-p1.7-baseline` — phải thành công, local == remote. |

---

## Cutover lock readiness (W01-R1 → W04)

W01-R1 evidence đủ để chuyển sang W04 (Reporting cutover) **nếu**:

1. **Owner/T0 chốt 4 quyết định:**
   - Cutoff date cụ thể (D.1 #1) — T1 đề xuất `2026-10-17` dựa trên evidence.
   - Cách giữ lịch sử aggregate cũ (D.1 #2) — giữ nguyên 34 rows trong DB (LOCKED YES từ §D.3).
   - Retained external sources (D.1 #3) — LOCKED NONE (không có cột external authority trong schema).
   - Expected totals/coverage tại cutover (D.1 #4) — `44` (chỉ aggregate, DE = 0).
2. **Owner confirm 4 default T1 đề xuất** (D.2 #5–8) — chỉ cần 1 click mỗi cái.
3. **W04 implement** cutover theo C01A contract với 5 cơ chế structural (§C.2) + 8 gate G1–G8 (C01A §3.6). W04 phải:
   - Dùng cutoff `2026-10-17` (hoặc T0 chốt) khi implement mask.
   - Xử lý "DE backdated" trigger: nếu W04 phát hiện submission SUBMITTED với `first_work_date < cutoff`, dừng và yêu cầu T0 quyết định lại cutoff.
   - Chạy gate G1–G8 với số liệu thật (đã có trong `docs/evidence/p2-w01-r1-baseline.json` làm baseline).

---

## Risks & open items

1. **Aggregate rows = 34, recruited_total = 44 (đã đo Production).** Cutover symbolic "all-DE" sẽ drop-out visible. W01-R1 đề xuất cutoff `2026-10-17` để giữ 44 người.
2. **DE = 0 tại baseline (đã đo Production).** Khi DE thật xuất hiện, cần phân biệt forward vs backdated. Backdated = trigger để T0 chốt lại cutoff.
3. **P1.7 J01 vẫn là gate** cho cutover thật. W01-R1 không thay thế. Combined UAT được hoãn đến cuối P3.
4. **28 sources (đã đo Production)** — thấp hơn P2-R00 expectation "30 active non-test". 22/28 chưa từng sync thành công. P2-N01 source retirement cần Owner/T0 điều tra riêng.
5. **Coverage ratio aggregate = 0.214 (đã đo Production).** W01-R1 không đề xuất "all-aggregate" cutover.
6. **Fingerprint stability:** `aggregate_fingerprint_sha256 = 7abfbdab53b0f1b01bd119a02b5ebe5417f3a369d7a9ccdba26e425b2106b1bd` sẽ thay đổi khi có data mới. W04 chạy muộn cần re-baseline.
7. **Status tối đa là evidence-ready** (số liệu Production thật), không phải cutover-ready. W04 mới là cutover task.

---

## Capability disposition (W01-R1 scope)

| Capability | Disposition trong W01-R1 |
|---|---|
| Source-verify canonical | Done (§A) |
| Revision/correction semantics | Done (§A.3) |
| Live Production aggregate measurement | Done (§B.1, evidence JSON) |
| Live Production Direct Entry measurement | Done (§B.2, evidence JSON) |
| Live Production source registry | Done (§B.3, evidence JSON) |
| Live Production coverage/freshness | Done (§B.4, evidence JSON) |
| Live Production overlap dimension counts | Done (§B.5, evidence JSON) |
| Candidate cutoff (live-derived) | `2026-10-17` (§C.1) |
| Anti-double-count evidence | Structural (§C.2) + cutoff mask rời nhau (§C.3) |
| T0 LOCKED decisions | 6 decisions (§D.3) |
| Repeatable read-only queries | 7 query §E (SELECT-only) |
| Default cho 8 quyết định C01A | 4 Owner + 4 T1-default (§D) |
| Cutover implementation | Không thuộc W01-R1 (P2-W04) |
| Source retirement | Không thuộc W01-R1 (P2-N01) |
| Alias backfill | Không thuộc W01-R1 (P2-W02) |
| Restore / RPO / RTO | Không thuộc W01-R1 (P2-W07) |
| Browser/UI UAT | Không (Owner trực tiếp) |

---

## Status tối đa (W01-R1)

`P2-W01-R1_LIVE_BASELINE_READY_FOR_CUTOVER_LOCK`

Đây là **production-evidence + structural** readiness cho cutover lock (W01-R1). Cutover thật vẫn chờ P1.7 J01 Owner Production acceptance + 4 quyết định Owner (D.1). W01-R1 **không** tự ý chốt bất kỳ quyết định nào trong D.1 (cutoff_date, retention, retained sources, expected totals — chỉ đề xuất `2026-10-17` cho cutoff dựa trên evidence Production, Owner/T0 quyết định cuối).

Không tuyên bố P2 PASS, cutover ready, hay Production ready.