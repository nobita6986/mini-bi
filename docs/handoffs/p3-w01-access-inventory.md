# P3-W01-S02-R1 — Access Inventory Consistency Fix

**Branch:** `feature/p3-w01-access-inventory`
**Base:** `d1f15b0` (S02 on top of `origin/main @ 45ca016`)
**Author:** T1C (Library & Access Auditor) — read-only.
**Tier:** FT0 docs-only — chỉ sửa inventory/handoff, không runtime / schema / migration / deploy.

---

## Scope (this R1 consistency fix)

Builds on S02 (`docs/security/p3-access-surfaces.md @ d1f15b0`). Những chỗ sai / lệch / stale đã được sửa để inventory phản ánh đúng trạng thái hiện tại trên cả bốn ref:

| Ref | SHA | Vai trò trong R1 |
|---|---|---|
| `origin/main` | `45ca016` | runtime hiện tại (unchanged) |
| `origin/feature/p1.6-integration` | `27c6845` | W01–W03 contracts + W03 DB foundation applied on DEV + I02 + **W04-S01** (pin React 19 grid + smoke compile + typeahead; **DB / auth boundary unchanged**) |
| `origin/feature/p1.5-g5-dev01` | `287514f` | **G5-DEV01** apply review/history migration + DEV acceptance (14/14); **chưa provider-live / production enabled** |
| `origin/feature/app-nav-01a` | `7bd2ba8` | navigation registry (unchanged) |

### 1. Chuẩn hóa summary P1.6

Mọi câu tóm tắt P1.6 nay đọc đúng:
- **26 tables** = **25 foundation / core tables** (`v_table` array trong `20261002170000_p1_6_direct_entry_foundation.sql`) **+ 1 supporting idempotency table** (`direct_entry_rpc_idempotency`).
- **1 security-invoker view** (`direct_entry_current_documents`).
- **17 application RPCs** (`SECURITY DEFINER`, EXECUTE-only to `service_role`).
- **Applied + accepted trên DEV** (95-check G3 manifest). **Chưa PROD.**

### 2. Loại bỏ stale wording

| Stale | Replaced by |
|---|---|
| "Migrate P1.6 chưa apply" | "Migrate P1.6 đã apply DEV; W04-S01 chỉ thêm smoke compile grid + typeahead" |
| "Route/UI side unstarted" (chung cho mọi W04+) | "W04-S01 đã hoàn tất dependency + smoke (compile grid + typeahead). Production page / API / persistence vẫn pending. W04-S02 = fixture UI route. W04-S03 = nối server / RPC." |
| "Tất cả P1.6 DB: T1A" | "Tất cả P1.6: T1B" |
| (implied) "P3 = T2 (this task)" | "P3 = T1C (this task)" |
| "26 P1.6 sources / 25 tables + 1 view + 17 RPC" (mâu thuẫn ngầm) | đã chuẩn hóa về "26 tables" (25 + 1 idempotency) — section §3.5.1 đổi tên thành "foundation / core tables" để không lẫn với supporting table |

### 3. Owner map

| Phase | Owner (R1) | Source ref |
|---|---|---|
| P0/P1 (foundation + reporting) | T1B | unchanged |
| P1.5 (AI gateway) | T1A | unchanged; bổ sung G5-DEV01 evidence |
| P1.6 (direct entry) | **T1B** | §11.4 pending rows + §7 owner note + Appendix B |
| P3 (RBAC) / inventory / audit | **T1C** (this task) | header + Appendix B |
| Ops (n8n) | T1B (T2 in earlier docs) | Appendix B |

> **Lưu ý.** Phase-owner assignments chỉ mang tính traceability, không phải authority decision. P3 G1 có thể revise.

### 4. P1.6 evidence ref nâng cấp

- `origin/feature/p1.6-integration @ 27c6845` (delta sau 51511dd = W04-S01 chỉ smoke UI/typeahead/dependency; không migration mới; DB / auth boundary unchanged).
- W04-S01 cụ thể:
  - `package.json` + `pnpm-lock.yaml` — pin React 19 grid (`react-data-grid@7.0.0-beta.61`).
  - `src/components/direct-entry/grid-smoke.tsx` (32 dòng) — compile smoke.
  - `src/lib/direct-entry/typeahead.ts` (39 dòng) + `src/components/direct-entry/typeahead-picker-smoke.tsx` (109 dòng) + `src/lib/direct-entry/typeahead.test.mjs` (45 dòng) — focused stable-ID typeahead.
  - `docs/handoffs/p1.6-w04-s01.md` (93 dòng) — native picker decision for S02.
  - **Không có `src/app/api/direct-entry/*` route; không có production page; không có migration.**

### 5. P1.5-G5 DEV evidence (NEW trong R1)

- `feature/p1.5-g5-dev01 @ 287514f`:
  - Apply `supabase/migrations/20261001180000_p1_5_ai_report_review_history.sql` lên Supabase DEV (1 áp dụng mới).
  - Post-apply dry-run: **22 applied, 0 pending, 0 checksum mismatch**.
  - DEV acceptance harness `scripts/g5-dev01-acceptance.mjs`: **14/14 pass**.
  - Cleanup namespace `g5dev01-*`: 0 leftover, append-only trigger phục hồi, reporting baseline không đổi, không đụng W03 direct-entry.
  - Handoff `docs/handoffs/p1.5-g5-dev01.md` (50 dòng).
- **4 service-role-only RPC mới** (`20261001180000_p1_5_ai_report_review_history.sql`):
  - `db:f:p1.5-G5:001` `ai_report_review_capability()` — R, returns capability required to approve/reject a draft revision.
  - `db:f:p1.5-G5:002` `ai_report_approve_revision(uuid, integer, text)` — W, capability check + OCC on `(job_id, expected_revision_number)` + actor/cursor isolation + idempotent.
  - `db:f:p1.5-G5:003` `ai_report_reject_revision(uuid, integer, text, text)` — W, capability check + OCC + reject reason (non-empty) + audit rollback on conflict.
  - `db:f:p1.5-G5:004` `ai_report_history(text, text, integer)` — R, keyset pagination (`actor_ref` cursor + `before` timestamp) + sanitized history projection.
- **`ai_report_revisions` append-only fix** (db:t:007 — was `RW`, now `R (insert only via RPC)`):
  - Trước G5-DEV01: grant `select, insert, update` to `service_role`.
  - Sau G5-DEV01: grant `select, insert` to `service_role`; **`revoke update on table public.ai_report_revisions from service_role`**.
  - Mọi UPDATE phải đi qua `ai_report_approve_revision` / `ai_report_reject_revision` (OCC + actor/cursor isolation + idempotent).
  - Đây là **append-only trigger phục hồi**, không phải provider-live / production enabled change.
- **`PILOT_ACTOR_REF` vẫn chưa được thay bằng actor_ref từ session.** G5-DEV01 chỉ apply migration đã có từ trước.

### 6. Capability split (giữ nguyên, không tự quyết AI self-approval)

| Capability | Còn / mở / đóng |
|---|---|
| `change_review` (db:f:p1.6:013/014) | closed by W03 — proposer ≠ reviewer enforced. **Không thay đổi trong R1.** |
| `entry_privileged_edit` (db:f:p1.6:015) | DB side COVERED_DEV_FAST_TRACK. Route /admin/privileged-edit (p1.6:015) vẫn PENDING_P1.6. **Không thay đổi trong R1.** |
| `ai.report.review` (api:006) | `decision:ai-self-approval` **vẫn `PENDING_DECISION`**. G5-DEV01 cung cấp OCC + actor/cursor isolation nhưng route `api:006` chưa enforce proposer ≠ reviewer. P3 / T0 phải quyết ở G1. |

> **R1 không tự quyết.** Tất cả 3 capability giữ semantic riêng; không collapse. `decision:ai-self-approval` vẫn pending.

### 7. Contradictions đã loại bỏ

| # | Contradiction (S02) | Fix (R1) |
|---|---|---|
| 1 | "P1.6 migration chưa apply" (trong §3.5 trailing note) | "P1.6 đã apply DEV; W04-S01 chỉ smoke" |
| 2 | "Route/UI side unstarted" (bao gồm smoke work) | "W04-S01 đã hoàn tất dependency + smoke; production page/API/persistence vẫn pending; W04-S02/S03 phase tiếp" |
| 3 | "Tất cả P1.6 DB: T1A" | "Tất cả P1.6: T1B" |
| 4 | "P3 inventory = T2" | "P3 inventory = T1C" |
| 5 | "26 tables = 25 + 1" (gây hiểu nhầm "25 là tất cả") | Section đổi tên "P1.6 W03 foundation / core tables (25)" + supporting table tách rõ ở §3.5.2 |
| 6 | `ai_report_revisions` được grant UPDATE (S02) | R1 sửa thành "R (insert only via RPC) — append-only since G5-DEV01", + 4 RPC mới, + `decision:ai-self-approval` cross-ref |
| 7 | Refs thiếu W04-S01 + G5-DEV01 evidence | Header + Appendix A + §11.7 đã thêm 27c6845, 287514f, scripts/g5-dev01-acceptance.mjs, docs/handoffs/p1.5-g5-dev01.md, docs/handoffs/p1.6-w04-s01.md |

## Quality gates run (FT0 docs-only)

| Check | Result |
|---|---|
| `pnpm docs:check` | pass — 0 JSON examples in inventory; intentional (no source code in this commit). |
| `pnpm secrets:check` | pass — scanned 366 files; no secret found. |
| `git diff --check` | clean (CRLF default on Windows; LF→CRLF warning only, no whitespace error). |
| `pnpm tsc --noEmit` | not run (no source change). |
| `pnpm test` | not run (no source change). |
| `pnpm build` | not run (no source change). |
| `pnpm lint` | not run (no source change). |

## ID inventory after R1 (additions vs S02)

| Namespace | New IDs in R1 | Notes |
|---|---|---|
| `db:f:p1.5-G5:NNN` | 4 | review_capability + approve_revision + reject_revision + history. |
| `db:t:007` (revision) | n/a — already existed; **grants updated** in §3.4. |
| `db:f:p1.5-G5:*` cross-ref | referenced in §11.7 | AI self-approval note now ties to OCC + actor/cursor isolation. |
| §11.4 owners | T1A → **T1B** | route/UI/worker/cutover. |
| §7 owner note | T1A → **T1B** | "Tất cả P1.6". |
| Appendix B P3 row | T2 → **T1C** | "this task". |
| Header "Auditor" | T2-A → **T1C** | Library & Access Auditor. |
| Header "this task" | T2 → **T1C** | task này. |

Total inventory rows: ~124 (vs ~120 in S02, ~80 in S01).

## Checkpoint (what's left for P3 G1)

Không thay đổi so với S02, ngoại trừ các cross-ref mới:

1. **T0 decisions** (§11.5) — vẫn cần:
   - `decision:001` — pilot Basic Auth vs cookie session cutover.
   - `decision:002` — cookie provider (auth contract W02 locks `@supabase/ssr`).
   - `decision:003` — n8n system identity trong capability matrix.
   - **`decision:ai-self-approval`** — R1 vẫn `PENDING_DECISION`. G5-DEV01 cung cấp OCC + actor/cursor isolation ở tầng DB; route `api:006` chưa enforce proposer ≠ reviewer. P3 / T0 quyết ở G1.
   - `decision:005` — audit retention window.
   - `decision:006` — middleware vs RPC enforcement.
2. **T1B inputs** (§11.4) — vẫn `PENDING_P1.6`:
   - W04-S02 — fixture UI route.
   - W04-S03 — server / RPC nối tiếp.
   - Document uploader worker (`direct_entry_append_document_event`).
   - Cookie session per W02 cutover.
3. **P3 implementation** (gap:001–007) — unchanged.

## Git state

- Branch: `feature/p3-w01-access-inventory` (tracking `origin/main`).
- Local total: 3 commits ahead of `origin/main` (S01 + S02 + S02-R1).
- No merge to main. No deploy. No runtime / schema / migration change.

## Status

**READY_FOR_T0_LIBRARY_AND_ACCESS_BASELINE** — inventory đã nhất quán:
- P1.6 summary chuẩn (26 + 1 + 17, DEV only).
- W04-S01 = smoke; production page/API/persistence pending W04-S02/S03.
- P1.5 = T1A, P1.6 = T1B, P3 = T1C.
- G5-DEV01 evidence: 4 RPC mới + `ai_report_revisions` append-only + 14/14 acceptance.
- Capability split: `change_review` ≠ `entry_privileged_edit` ≠ `ai.report.review`; AI self-approval vẫn `PENDING_DECISION`.
- Không runtime / schema / migration / deploy.