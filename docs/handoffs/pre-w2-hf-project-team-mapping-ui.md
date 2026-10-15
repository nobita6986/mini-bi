# PRE-W2-HF Project↔Team batch mapping — UI handoff

- **Status:** `PRE_W2_HF_PROJECT_TEAM_MAPPING_UI_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `feature/pre-w2-hf-project-team-mapping-backend@6222488f23a6ef865b0b5a57c1bc3912568f9ad3`
- **Final UI implementation SHA:** `85f12b8c0dbad539c59a2ed9070f2a2f9e804e35` (`feat(pre-w2-hf): add batch mapping admin UI`; subsequent branch commits are handoff documentation only)
- **Branch:** `feature/pre-w2-hf-project-team-mapping-ui`
- **Worktree:** `C:\CodeApp\BI-pre-w2-hf-project-team-mapping-ui`
- **Scope:** Admin UI/model/tests and handoff only. No backend, API, schema, migration, dependency, deployment, database apply, Production query, or UAT changes.

## Implementation

The existing Mapping Dự án ↔ Nhóm page remains the only screen. Grant now loads projects from `/api/direct-entry/projects?include_inactive=true`, filters to active projects, and provides local name/ID search and 25-item paging. Project checkbox selection is held independently of the search and page, is not pre-populated, and cannot exceed 100 projects. Existing project/team ID filters for the mapping table remain unchanged.

Team choices come from `/api/admin/catalog/teams` using the existing strict team list projector, server-side search and paging, and `include_inactive=false`. The form selects one team; that choice remains selected when the user changes the search or page. Inactive or reserved teams are not offered.

The grant body is exactly `{ team_id, project_ids, reason, idempotency_key }`. The UI does not send project IDs as a singular field, pair versions, effective dates, or client authority. It strictly projects `{ ok: true, batch }`, checks that the created/skipped project IDs partition the submitted selection, and reports counts and project display names separately for created and already-effective mappings. The server-returned `effective_from` is included in the result message.

Revoke remains in the existing confirmation dialog and sends the versionless body `{ mapping_id, effective_to, reason, idempotency_key }`. Both operations retain required reason, loading/disabled behavior, sanitized errors, and idempotency key reuse for an exact retry. A `200` is not shown as success unless its response projection is valid.

The page, navigation entry, list API, and mutation APIs retain their existing Full Admin gates. Project/team data only supplies selectable labels and IDs; permission decisions remain server-owned.

No staging audit results, project/team pairs, or default selections are embedded in the UI. An Admin can select the same project in separate operations for different teams, subject to the backend's checks.

## Changed files

- `src/components/admin/project-team-scope-manager.tsx` — project/team selectors, loading/denied/error/retry states, request wiring and strict result handling.
- `src/components/admin/project-team-scope-manager.test.mjs` — API reuse, selector, batch/revoke wiring, and Full Admin/navigation regressions.
- `src/lib/admin/project-team-scope-ui-model.ts` — versionless request builders, project selection/filter/page helpers, and strict mutation outcome projection.
- `src/lib/admin/project-team-scope-ui-model.test.mjs` — 1–100 bounds, retained selection, exact bodies, created/skipped results, revoke projection, and sanitized error tests.
- `scripts/pre-w2-hf-project-team-mapping-ui-mutation.mjs` — focused mutation probes with byte-identical restoration checks.
- `docs/handoffs/pre-w2-hf-project-team-mapping-ui.md` — this handoff.

No `package.json` or lockfile change was needed; the existing `test:pre-w2-hf-project-team-authority-ui` lane already includes the updated tests.

## Verification

| Check | Result |
| --- | --- |
| `pnpm test:pre-w2-hf-project-team-authority-ui` | Pass |
| `pnpm test:pre-w2-hf-project-team-batch` | Pass, including API/contract/repository and batch concurrency/database tests |
| `node scripts/pre-w2-hf-project-team-mapping-ui-mutation.mjs` | 4/4 probes made the focused lane fail; modified sources restored byte-for-byte |
| `pnpm exec next typegen` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass, 0 errors and 14 existing warnings |
| `pnpm build` | Pass |
| `pnpm docs:check` | Pass (6/6 examples) |
| `pnpm secrets:check` | Pass |
| `git diff --check` | Pass |
| Full `pnpm test` | Not run; focused UI and batch-contract lanes were run instead |
| Browser/UAT, deployment, database apply, Production query | Not run |

## Owner UAT checklist

1. As Full Admin, open the existing Mapping page. Confirm a non-Full-Admin cannot read or mutate mappings through the server routes.
2. Open **Cấp mapping**. Search projects by name and ID, select projects across pages and search terms, and verify the count/names retain all selections.
3. Verify inactive projects and inactive/reserved teams are not offered; select exactly one active team.
4. Submit with a required reason. Confirm the result separately names/counts created and already-effective projects and reports the server-provided effective date. Confirm no success is shown for an invalid/error response.
5. In a separate operation, use a previously selected project with another team; confirm there is no staging-specific preselection or special case.
6. Revoke an eligible mapping with a reason and optional effective-to date; confirm the UI sends no version field and the history remains visible.

## Remaining risk

The existing project list API returns the catalog in one response, so project search and 25-item paging are client-side. If the catalog grows enough to make that response expensive, server-side project search/pagination would require a separate API contract change; none was made here.
