# P3-W01-S01 — Access Surface Inventory Snapshot

**Branch:** `feature/p3-w01-access-inventory`
**Base:** `origin/main @ 45ca016`
**Author:** T2-A (Access Surface) — read-only.
**Tier:** FT0 — read-only inventory, no runtime/schema/RPC edits.

---

## Scope (what this commit does)

1. Inventory `docs/security/p3-access-surfaces.md` (NEW, 278 lines):
   - **§1 Page routes** — 5 pages + 2 layout wrappers (1 page planned for P1.6).
   - **§2 API routes/methods** — 13 endpoints + 1 dead matcher rule.
   - **§3 Tables/views/RPC/grants** — 11 base tables, 3 reporting views, 24 RPC, all deny-by-default + revoke public/anon/authenticated + grant service_role. Plus 9 P1.6 surfaces (pending).
   - **§4 Service-role callers** — 8 server repos + 2 unused public client.
   - **§5 Pilot Basic Auth** — proxy matcher + evaluatePilotAccess + 1 dead rule.
   - **§6 AI reports/settings/worker** — cross-reference §2 + §4 + 5 env flags.
   - **§7 P1.6 direct-entry boundaries** — 14 planned surfaces, capability vocab mapped.
   - **§8 Pipeline-check + ops** — page + 3 env flags + 5 scripts.
   - **§9 n8n system identity** — 4 workflow refs (WF01 only).
   - **§10 App Nav ↔ backend mapping** — 2 current + 1 planned registry entry.
   - **§11 GAP / PENDING_P1.6 / PENDING_DECISION** — actionable list for P3.
2. **No source, no schema, no migration, no RPC, no API route, no proxy change.**

## Out of scope (explicit)

- No G1 PASS declaration.
- No decision on role/history/audit policy (those need T0 input per §11 decision:001–006).
- No merge of `feature/app-nav-01a` or `feature/p1.6-integration` (this is a separate worktree).
- No DB apply / deploy.
- No full test/build run (per task brief).

## Deferred tests (FT0 boundary, run later)

Per task brief, the following are NOT run in this change set:

1. **Cross-reference test** — automated check that every API route in
   `src/app/api/**` appears in §2 with a stable ID. A future PR can
   add `scripts/check-access-inventory.mjs` that walks the file tree
   and asserts coverage. Deferred to G2.
2. **Migration drift test** — verify all tables + grants in §3 actually
   exist in `supabase/migrations/*.sql`. Today the inventory is built
   by hand-reading 20 SQL files. An automated check is G2 work.
3. **API↔capability matrix test** — assert each `api:NNN` has a row
   in §11. Same approach as #1. Deferred.
4. **Browser keyboard / focus acceptance** on any new page — none added
   in this commit.
5. **Mobile matrix** — none added.

## Quality gates run (FT0)

| Check | Result |
|---|---|
| `pnpm docs:check` (script:check-doc-examples) | pass (0 JSON examples in inventory; intentional) |
| `pnpm secrets:check` | pass — scanned 365 files (client bundle + source + docs + scripts), no secret found |
| `git diff --check` | clean (CRLF default on Windows, no whitespace error) |
| `pnpm tsc --noEmit` | not run (no source change) |
| `pnpm test` | not run (no source change) |
| `pnpm build` | not run (no source change) |
| `pnpm lint` | not run (no source change) |

## ID inventory (10 namespaces, ~80 IDs)

- `page:NNN` × 5 + `page:layout:NNN` × 2
- `api:NNN` × 13
- `db:t:NNN` × 11 + `db:v:NNN` × 3 + `db:f:NNN` × 24 + `db:t:P1.6-NNN` × 6 + `db:f:P1.6-NNN` × 3
- `repo:NNN` × 9
- `gate:NNN` × 3
- `env:NNN` × 5
- `p1.6:NNN` × 14
- `op:NNN` × 8
- `n8n:NNN` × 4
- `nav` × 3 (registry rows)

## Checkpoint (what's left for P3 G1)

1. **T0 decisions** for §11 `PENDING_DECISION` items (decision:001–006):
   - Keep pilot Basic Auth in parallel with cookie session, or full cutover?
   - Cookie provider: `@supabase/ssr` (per auth contract) or other?
   - n8n system identity in capability matrix?
   - `change_review` self-approve policy?
   - Audit retention window?
   - Direct-URL enforcement layer (middleware vs RPC)?
2. **T1A inputs** for `PENDING_P1.6` items:
   - 14 P1.6 API routes implementation.
   - 5 P1.6 tables + 3 RPC migration.
   - Restricted reason store for audit envelope.
3. **Implementation** (next P3 W01 tasks):
   - Centralize `PILOT_ACTOR_REF` → real `actor_ref` (gap:001).
   - Per-source filter on `/pipeline-check` (gap:002).
   - Per-row scope on AI report APIs (gap:003, gap:004).
   - Read-only role replacement of service-role for page reads (gap:006).
   - App Nav capability filter (gap:007).

## Git state

- Branch: `feature/p3-w01-access-inventory` (tracking `origin/main`).
- One commit on top of `origin/main` (next push).
- No merge to main. No deploy.

## Status

**IMPLEMENTED_FAST_TRACK** — read-only inventory covers all surfaces
on `origin/main`, cross-referenced with `p1.6-integration` and
`app-nav-01a`. GAP / PENDING_P1.6 / PENDING_DECISION lists ready for
T0 decision input at P3 G1.