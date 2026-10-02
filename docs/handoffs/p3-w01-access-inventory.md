# P3-W01-S02 — Inventory Delta Refresh after P1.6 G3/I02

**Branch:** `feature/p3-w01-access-inventory`
**Base:** `origin/main @ 45ca016` + delta from `origin/feature/p1.6-integration @ 51511dd`
**Author:** T2-A (Access Surface) — read-only.
**Tier:** FT0 — read-only delta refresh; no runtime / schema / RPC / migration edits.

---

## Scope (this delta refresh, S02)

Builds on S01 (`docs/security/p3-access-surfaces.md @ 7782e54`):

1. **§3.5 P1.6 DB boundary** — replaced 9 "planned migration/table/RPC" rows with the 25 + 1 + 17 actually-deployed artifacts from `p1.6-integration @ 51511dd`:
   - 25 tables in the W03 `v_table` array (force RLS + revoke all 4 roles).
   - 1 supporting table (`direct_entry_rpc_idempotency`) + 1 view (`direct_entry_current_documents`).
   - 17 `SECURITY DEFINER` application RPCs granted EXECUTE to `service_role`.
   - Status: `COVERED_DEV_FAST_TRACK` (DEV only; not PROD).
2. **§7 capability semantics** — split three capabilities that S01 was conflating:
   - `change_review` — direct-entry change request; **proposer ≠ reviewer** enforced by `direct_entry_approve_change_request` / `direct_entry_reject_change_request`.
   - `entry_privileged_edit` — direct single-step edit by admin / kế toán; **no second party** but reason + expected version + revision + audit mandatory.
   - `ai.report.review` — AI report approval; **its own capability**, not mapped to `change_review` and not auto-denied by direct-entry's self-approval rule.
3. **§11 GAP / PENDING refresh** — closed the S01 items that W03 closed; split the remaining `PENDING_P1.6` into §11.3 (closed by W03) and §11.4 (route/UI/worker/cutover — still open). Added §11.5 with a separate `decision:ai-self-approval` and §11.6 with backlog reconciliation (26 sources, 2 fixtures, recruited total 30).
4. **No source, no schema, no migration, no RPC, no API route, no proxy change.**

## Out of scope (explicit, unchanged from S01)

- No G1 PASS declaration.
- No decision on role / history / audit policy (those need T0 input per §11.5).
- No merge of `feature/app-nav-01a` or `feature/p1.6-integration` (separate worktree).
- No DB apply / deploy.
- No full test / build run.
- No full policy matrix in this task — the brief explicitly defers it.

## Deferred tests (FT0 boundary, run later)

| # | Deferred | When |
|---|---|---|
| 1 | Cross-reference test linking every API route in `src/app/api/**` to an inventory ID. | G2. |
| 2 | Migration drift test against `supabase/migrations/*.sql` (now 22 files after W03 + forward correction). | G2. |
| 3 | API↔capability matrix test — assert each `api:NNN` and `p1.6:NNN` has a row in §11. | G2. |
| 4 | Auto-check that DB-side `COVERED_DEV_FAST_TRACK` does not silently mask the route-side `PENDING_P1.6` status (a script that pairs each `db:f:p1.6:NNN` with its expected `p1.6:NNN`). | G2. |
| 5 | Browser / mobile matrix on any new UI. | n/a — no UI added. |
| 6 | W03 DEV 95-check acceptance re-run. | Reuse `bbfdea9` evidence; do not repeat. |
| 7 | Aggregate `pnpm test` (including P1.5 main/server). | Run at next integration checkpoint / J01. |

## Quality gates run (FT0)

| Check | Result |
|---|---|
| `pnpm docs:check` (script:check-doc-examples) | pass — 0 JSON examples in inventory; intentional (no source code in this commit). |
| `pnpm secrets:check` | pass — scanned 366 files (1 new file vs S01's 365); no secret found. |
| `git diff --check` | clean (CRLF default on Windows; LF→CRLF warning, no whitespace error). |
| `pnpm tsc --noEmit` | not run (no source change). |
| `pnpm test` | not run (no source change). |
| `pnpm build` | not run (no source change). |
| `pnpm lint` | not run (no source change). |
| W03 G3 95-check | not re-run (recorded at checkpoint `bbfdea9`; FT0 brief allows reuse). |
| I02 FT1 gates | not re-run (recorded in `docs/handoffs/p1.6-i02.md`; FT0 brief allows reuse). |

## ID inventory after S02 (additions vs S01)

| Namespace | New IDs in S02 | Notes |
|---|---|---|
| `db:t:p1.6:NNN` | 26 | 25 W03 tables + 1 idempotency table. |
| `db:v:p1.6:NNN` | 1 | `direct_entry_current_documents`. |
| `db:f:p1.6:NNN` | 17 | 17 application RPCs. |
| `p1.6:NNN` | +1 (now 15) | Added p1.6:015 = `POST /admin/privileged-edit` (entry_privileged_edit, single-step, no second party). |
| `pending:p1.6:*` | split into 11.3 (closed) + 11.4 (still open: route/UI/worker/cutover) | The original 3 pending items are now classified. |
| `decision:NNN` | decision:ai-self-approval (new) + decision:004 closed by W03 | — |

Total: ~120 IDs across 12 namespaces (vs ~80 in S01). The growth is the P1.6 DB-side detail from W03.

## Capability semantics — three-way split (P1.6 W03 + AI)

| Capability | Surface | Self-review required? | Reason / version / audit? | Status |
|---|---|---|---|---|
| `change_review` | `direct_entry_approve_change_request` (db:f:p1.6:013), `direct_entry_reject_change_request` (db:f:p1.6:014) | **YES — proposer ≠ reviewer** | YES (reason, expected request+item versions, request/entry revisions, audit) | COVERED_DEV_FAST_TRACK (DB) |
| `entry_privileged_edit` | `direct_entry_privileged_edit` (db:f:p1.6:015), and SUBMITTED branch of `direct_entry_update_payment` and `direct_entry_create_document_metadata` | **NO second party** | YES (reason, expected version, revision, audit) | COVERED_DEV_FAST_TRACK (DB) |
| `ai.report.review` | `POST /api/ai/reports/[jobId]/review` (api:006) | **DECISION SEPARATE** — `decision:ai-self-approval` | YES (existing CSRF + sanitize) | GAP — single `PILOT_ACTOR_REF`; route layer needs capability check |

> **Do not conflate.** `change_review` ≠ `entry_privileged_edit` ≠ `ai.report.review`. P3 must keep all three in the capability matrix and not collapse them.

## Backlog reconciliation (from §11.6)

| Metric | Pre-test | Post-cleanup | Implication |
|---|---|---|---|
| `data_sources` count | 26 | 26 | 2 fixture + 24 real; P2-W01 phải phân loại active/inactive/legacy. |
| `recruited_total` | 30 | 30 | Khớp `daily_recruitment_breakdown`; fixture excluded. |
| W03 user/entry count | 0 | 0 | W03 fixture namespace dùng synthetic IDs. |
| 95-check G3 status | — | all pass | `cleanupVerified=true`, `baselineUnchanged=true`. |

**P2-W01 ownership:** classify 26 data sources. **P3 ownership:** do not regress `recruited_total` while the capability layer goes in.

## Checkpoint (what's left for P3 G1)

1. **T0 decisions** for §11.5 (PENDING_DECISION):
   - `decision:001` — pilot Basic Auth vs cookie session cutover.
   - `decision:002` — cookie provider (auth contract W02 locks `@supabase/ssr`).
   - `decision:003` — n8n system identity in capability matrix.
   - `decision:ai-self-approval` — **new**: AI report self-approval; route-layer enforcement if forbidden (do not reuse `change_review`).
   - `decision:005` — audit retention window.
   - `decision:006` — middleware vs RPC enforcement.
2. **T1A inputs** for §11.4 (still-P1.6 route/UI/worker/cutover):
   - `pending:p1.6:route:001` — first direct-entry API routes.
   - `pending:p1.6:ui:001` — direct-entry UI.
   - `pending:p1.6:worker:001` — document uploader worker.
   - `pending:p1.6:cutover:001` — cookie session per W02.
3. **P3 implementation** (next P3 W01 tasks):
   - Centralize `PILOT_ACTOR_REF` → real `actor_ref` (gap:001).
   - Per-source filter on `/pipeline-check` (gap:002).
   - Per-row scope on AI report APIs (gap:003).
   - AI review capability + actor ≠ proposer (gap:004 + `decision:ai-self-approval`).
   - Read-only role replacement of service-role for page reads (gap:006).
   - App Nav capability filter (gap:007).
4. **P2-W01** classify 26 data sources (no P3 ownership, but cited in §11.6).

## Git state

- Branch: `feature/p3-w01-access-inventory` (tracking `origin/main`).
- One additional commit on top of S01 (`7782e54`). Local total: 2 commits ahead of `origin/main`.
- No merge to main. No deploy.

## Status

**IMPLEMENTED_FAST_TRACK** — delta refresh reflects P1.6 G3/I02 correctly:
- DB side: 25 tables + 1 view + 17 RPC → `COVERED_DEV_FAST_TRACK`.
- Route/UI/worker/cutover: still `PENDING_P1.6` (W04+).
- Capability split: `change_review` ≠ `entry_privileged_edit` ≠ `ai.report.review`.
- AI self-approval: separate `decision:ai-self-approval`, **not** inferred from direct-entry rule.
- Backlog reconciliation: 26 sources, 2 fixtures, recruited total 30 → P2-W01 owns the classification.

No G1 PASS; no policy matrix; no auth implementation. P3 G1 still needs T0 decisions in §11.5.