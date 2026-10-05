# P3-W06A — Capability-aware navigation + AI deferred + Direct Entry text cell fix

**Status:** `P3-W06A_CAPABILITY_NAV_TEXT_EDITOR_LOCAL_PASS_FAST_TRACK`
**Branch:** `feature/p3-w06a-capability-nav-text-editor`
**Base:** `origin/main @ f9cb5b67362a9ea16ad709bd037c8d7ba2b67a2c`
**Worktree:** `C:\CodeApp\BI-p3-w06a-capability-nav-text-editor`

## Tổng quan

Bundle 3 scope của P3-W06A theo R00 reuse survey + P3-C01 R2 policy matrix:

- **Scope A — Capability-aware navigation**: Lọc `NAV_ENTRIES` cùng registry cho
  desktop + mobile dựa trên capability projection từ session thật. Tái sử dụng
  `actorProjection` của `auth-session-core.ts`; không tạo role engine mới.
- **Scope B — AI deferred to P3.1**: Ẩn hoàn toàn `Tạo báo cáo AI` và
  `Cấu hình AI` trong dashboard header. Implementation + API không đổi;
  PILOT_ACTOR_REF + rate limiter vẫn thuộc P3.1.
- **Scope C — Text cell single-character fix**: tách logic thành pure helper
  (`text-cell-state.ts`), dùng `useRef` + `useEffect` (empty deps) để focus +
  select chỉ 1 lần, xử lý Vietnamese IME composition đúng cách.

## Files thay đổi

### Mới (4 files)

| Path | Mô tả |
|---|---|
| `src/lib/navigation/registry-capability.ts` | Predicate table: `directEntryNavPredicate`, `adminAuthorityNavPredicate`, `NAV_CAPABILITY_PREDICATES`, `decideNavEntryVisibility`. Tái sử dụng `CAPABILITIES` từ `direct-entry-v2.ts`. |
| `src/lib/navigation/registry-capability.test.mjs` | 14 tests cho capability projection + filter. |
| `src/lib/navigation/resolve-nav-actor.ts` | Server-only helper: `resolveNavActorForAppShell()` → `NavActorProjection` (chỉ `app_user_id` + `capabilities` + `scopes.kind`). |
| `src/components/direct-entry/text-cell-state.ts` | Pure state-transition: `applyTextCellKeystroke`, `applyTextCellCompositionEnd`, `simulateAsciiKeystrokes`, `simulateVietnameseIme`. |
| `src/components/direct-entry/direct-entry-text-cell-regression.test.mjs` | 13 tests: 7 hành vi state transition + 6 structural invariant (useRef + useEffect empty deps, onCompositionStart/End, memo, không regress paste/dropdown/date/selection). |

### Sửa (10 files)

| Path | Scope | Thay đổi |
|---|---|---|
| `src/lib/navigation/registry.ts` | A | Thêm `filterEntriesForActor()` — giữ `entriesForViewport` cũ cho test cũ xanh. |
| `src/components/app-shell/app-shell.tsx` | A | Nhận `actor: NavActorProjection \| null` prop; filter qua `decideNavEntryVisibility`. Comment giải thích không rò `auth_subject`/email. |
| `src/components/app-shell/app-shell.test.mjs` | A | Thêm test cho `actor` prop + capability filter + AI hidden. |
| `src/app/dashboard/layout.tsx` | A+B | Bỏ import + render `AiReportPanel` / `AiSettingsPanel`. Gọi `resolveNavActorForAppShell()` 1 lần, truyền `actor` vào AppShell. |
| `src/app/dashboard/layout.test.mjs` | A+B | Update assertions cho Scope B (no AI import) + Scope A (actor prop). |
| `src/app/direct-entry/layout.tsx` | A | Gọi `resolveNavActorForAppShell()` 1 lần, truyền `actor` vào AppShell. |
| `src/app/direct-entry/layout.test.mjs` | A | Update assertion cho `export default async function` + actor prop. |
| `src/components/direct-entry/direct-entry-spreadsheet-grid.tsx` | C | Refactor `cellsTextEditor`: wrapper + `CellsTextEditorComponent` dùng `useState` + `useRef` + `useEffect` (empty deps); `memo()` cho stable identity; `onCompositionStart/End` cho Vietnamese IME; `isComposingRef` để tránh patch 5 lần cho 1 composition. |
| `src/components/direct-entry/direct-entry-h08-r1-defaults-text-regression.test.mjs` | C | Update `cellsTextEditor` regex match (giờ là wrapper uy quyen `<CellsTextEditor/>`). |
| `src/lib/ai-config/w04a-panel-api.test.mjs` | B | Update W04A-P9: KHÔNG render AI panels trong P3 release (Scope B). |

## Reuse matrix

| Nhu cầu | Reuse |
|---|---|
| Capability source of truth | `CAPABILITIES` (21 token) trong `src/lib/auth/direct-entry-v2.ts:10-30` |
| Direct Entry predicate | Theo P3-C01 §2.2 matrix: `entry_own \| entry_team \| entry_admin` |
| Admin authority rule | Theo P3-C01 §2.1a: AND của `entry_admin ∧ recruiter_master_manage ∧ team_master_manage` + scope `all` |
| Actor projection sanitize | `actorProjection()` trong `src/lib/auth/auth-session-core.ts` (chỉ `app_user_id`, `capabilities`, `scopes`, `self_recruiter_suggestion`) — `resolve-nav-actor.ts` chỉ lấy 3 field đầu cho nav |
| Session bootstrap | `getDirectEntryActor()` trong `src/lib/auth/direct-entry-session.ts` (qua `resolveDirectEntrySession` + `resolveActor`) |
| Actor repository | `createDirectEntryActorRepository()` từ `src/lib/direct-entry/actor-context-repository.ts` |
| Direct Entry UI flag | `isDirectEntryUiEnabled()` từ `src/lib/direct-entry/ui-model.ts` (giữ nguyên từ P1.7) |
| AI feature flag | KHÔNG dùng (P3-W06A Scope B: ẩn hoàn toàn, không phụ thuộc env) |
| react-data-grid | `7.0.0-beta.61` (giữ nguyên) — fix ở renderEditCell wrapper, không fork library |

## Quality gates (đã chạy)

| Gate | Kết quả |
|---|---|
| Targeted navigation desktop/mobile tests | PASS — 53/53 (`test:app-nav-02a`) |
| Allowed/denied capability tests theo policy R2 | PASS — 14/14 (`registry-capability.test.mjs`) |
| AI action hidden tests | PASS — 3 tests mới trong `app-shell.test.mjs` + `dashboard/layout.test.mjs` + `w04a-panel-api.test.mjs` |
| Behavioral text-cell tests | PASS — 13/13 (`direct-entry-text-cell-regression.test.mjs`) |
| Existing Direct Entry grid/paste/dropdown/date/selection regressions | PASS — 26/26 (`direct-entry-h08-r1-defaults-text-regression.test.mjs`) |
| Existing Direct Entry UI tests (excel-paste, change-request, cccd, …) | PASS — 8/8 (`direct-entry-excel-paste.test.mjs`) + các test khác |
| Full `pnpm test` | PASS — toàn bộ ~900 tests trong `test`, `test:main`, `test:server`, `test:export` |
| `npx next typegen` | PASS — route types generated |
| `pnpm typecheck` | PASS — `tsc --noEmit` không lỗi |
| `pnpm lint` | PASS — 0 errors, 6 pre-existing warnings (không liên quan tới task này) |
| `pnpm build` | PASS — compiled successfully, 5 routes generated |
| `pnpm docs:check` | PASS — 6/6 doc examples |
| `pnpm secrets:check` | PASS — 1173 files scanned, 0 secrets |
| `pnpm db:migrate --status` | PASS — 39 áp dụng / 0 mới / 0 mismatch |
| `git diff --check` | PASS — không có trailing whitespace |

## Test chi tiết (test:server + test:main output)

```
test:main: 447 tests / 447 pass / 0 fail
test:server: 102 tests / 102 pass / 0 fail (auth-session-core, AI-related guard, P3-W02E)
test:export: 4 tests / 4 pass
registry-capability: 14/14
text-cell-regression: 13/13
h08-r1-defaults-text-regression: 26/26
app-nav-02a (registry + app-shell + layout x 2): 53/53
```

## Phạm vi A — Capability-aware navigation

### Page boundary (page/layout) — actor resolver

`resolve-nav-actor.ts`:

```ts
export async function resolveNavActorForAppShell(): Promise<NavActorProjection | null> {
  const result = await getDirectEntryActor(createDirectEntryActorRepository());
  if (!result.actor.ok) return null;
  return {
    app_user_id: result.actor.actor.app_user_id,
    capabilities: result.actor.actor.capabilities,
    scopes: result.actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
  };
}
```

- Tái sử dụng `getDirectEntryActor` đã có (`src/lib/auth/direct-entry-session.ts`).
- Projection chỉ chứa `app_user_id`, `capabilities`, `scopes.kind` — KHÔNG có
  `auth_subject`, email, recruiter_suggestion hay PII khác.
- `actor === null` khi session resolve fail → AppShell chỉ render Dashboard.

### Predicate bảng

`registry-capability.ts`:

- `directEntryNavPredicate`: actor có `entry_own | entry_team | entry_admin`.
- `adminAuthorityNavPredicate`: AND của 3 capability + scope `all`.
- `NAV_CAPABILITY_PREDICATES`: map từ `entry.capability` metadata → predicate.
- `decideNavEntryVisibility({ capabilityKey, actor, viewport, entryVisibleInViewport })`:
  thuần, fail-closed (actor null → chỉ `any` còn hiện).

### Registry filter

`registry.ts`:

- `filterEntriesForActor({ viewport, directEntryEnabled, actor, decide })`:
  lọc `CURRENT_NAV_ENTRIES` qua predicate. KHÔNG tạo registry thứ hai.
- `entriesForViewport` cũ giữ nguyên → test cũ vẫn xanh.

### AppShell

`app-shell.tsx`:

- Nhận `actor: NavActorProjection | null` prop.
- Filter desktop + mobile qua cùng `filterEntriesForActor`.
- Active path / a11y (`aria-current`, `aria-label`) giữ nguyên.
- `headerActions` vẫn optional; dashboard mới không truyền (đã ẩn AI).

### Page layouts

- `src/app/dashboard/layout.tsx`: gọi `resolveNavActorForAppShell()`, truyền vào AppShell.
- `src/app/direct-entry/layout.tsx`: tương tự.

## Phạm vi B — AI Deferred to P3.1

- `src/app/dashboard/layout.tsx` KHÔNG import / render `AiReportPanel`, `AiSettingsPanel`.
- KHÔNG truyền `headerActions` (AppShell chỉ render khi page truyền).
- Implementation (`ai-report-panel.tsx`, `ai-settings-panel.tsx`) giữ nguyên source
  — không xoá, không đụng API internals, không đụng env, không đụng rate limiter.
- `isAiSettingsEnabled` / `isAiReportsEnabled` KHÔNG được gọi trong layout nữa
  (fail-closed ngay tại boundary, không phụ thuộc env).

Regression tests:
- `app-shell.test.mjs`: assert KHÔNG có `'Tạo báo cáo AI'`, `'Cấu hình AI'`,
  `AiReportPanel`, `AiSettingsPanel`, `isAiSettingsEnabled`, `isAiReportsEnabled`
  trong `app-shell.tsx`.
- `dashboard/layout.test.mjs`: assert KHÔNG import AI panels, KHÔNG `headerActions`.
- `w04a-panel-api.test.mjs::W04A-P9`: assert KHÔNG render AI panels trong P3 release.

## Phạm vi C — Text cell fix

### Root cause

`cellsTextEditor` cũ:

```tsx
<input
  ref={(node) => { if (node) { node.focus(); node.select(); } }}
  value={value}
  onChange={(event) => onRowChange({ ...row, cells: { ...row.cells, [column.key]: event.target.value } })}
  onBlur={() => onClose(true, false)}
/>
```

`ref={(node) => ...}` với arrow function inline tạo callback mới mỗi render.
Mỗi keystroke:
1. `onChange` → `onRowChange` → parent state update.
2. React re-render `cellsTextEditor`.
3. React unmount callback ref cũ + remount callback ref mới.
4. Callback mới gọi `node.select()` → highlight toàn bộ text.
5. Keystroke tiếp theo thay thế toàn bộ.

### Fix

`direct-entry-spreadsheet-grid.tsx`:

- `CellsTextEditorComponent` (mới) dùng:
  - `useRef<HTMLInputElement>` cho DOM node.
  - `useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [])`
    — chỉ chạy 1 lần khi mount (deps rỗng). Re-render KHÔNG re-select.
  - `useState` cho local controlled value (sync với `row.cells` qua effect
    thứ 2, tránh sync khi đang composing).
  - `onCompositionStart` set `isComposingRef.current = true` (không commit
    composing char).
  - `onCompositionEnd` set `isComposingRef.current = false` + commit final
    value 1 lần.
- `memo(CellsTextEditorComponent)` — giữ identity ổn định khi row/column/onRowChange/onClose
  tham chiếu thay đổi, tránh remount DOM node.
- `cellsTextEditor` (wrapper) uy quyen qua `<CellsTextEditor/>` — giữ contract
  cũ với `react-data-grid` (vẫn match `renderEditCell: cellsTextEditor`).

### Pure helper (test thuần)

`text-cell-state.ts`:

- `applyTextCellKeystroke`: chèn key tại selection (thay thế selection range).
- `applyTextCellCompositionEnd`: committed value rỗng → giữ current; khác
  rỗng → replace.
- `simulateAsciiKeystrokes`: append n key liên tiếp, đảm bảo không có patch rỗng.
- `simulateVietnameseIme`: pre-edit fragments + final committed value.

### Regression tests

`direct-entry-text-cell-regression.test.mjs`:

- R1-S1 → R1-S7: pure state transition.
- R2-S1: KHÔNG còn `ref={...}` callback inline gọi `node.select()`.
- R2-S2: dùng `useRef` + `useEffect([])` cho focus/select 1 lần.
- R2-S3: có `onCompositionStart/End` + `isComposingRef`.
- R2-S4: `memo(CellsTextEditorComponent)`.
- R2-S5: SelectCellEditor / DateCellEditor / Excel paste KHÔNG regress.
- R2-S6: `onBlur` vẫn commit (`onClose(true, false)`).

## Bó ownership tuân thủ

Được sửa:
- Navigation registry/predicates (`registry.ts`, `registry-capability.ts` mới).
- AppShell, DesktopNav, MobileNav (giữ nguyên contract).
- Page-to-AppShell actor projection (`resolve-nav-actor.ts` mới).
- Dashboard header action rendering (bỏ AI panels).
- Direct Entry spreadsheet grid/editor (`direct-entry-spreadsheet-grid.tsx`).

Không được sửa:
- migration/DB/RPC.
- reporting/cutover.
- auth login/logout/session internals (chỉ tái sử dụng API có sẵn).
- AI API internals.
- package/lockfile (giữ nguyên).
- env/workflow/deployment.
- primary checkout (`C:\CodeApp\BI`).

## Giới hạn

- P3 release hiện tại: AI panels ẩn hoàn toàn. Khi P3.1 re-enable, chỉ cần
  cập nhật `src/app/dashboard/layout.tsx` để đọc lại cờ + capability + truyền
  `headerActions` — KHÔNG đụng AppShell.
- `resolveNavActorForAppShell` gọi `getDirectEntryActor` mỗi lần page render.
  Cache có thể là tương lai (React `cache()` của Next 16) nhưng chưa tối ưu
  trong task này — request mỗi nav resolution là 1 RPC roundtrip, đã có sẵn
  trong `resolveDirectEntrySession` (1 getUser + 1 RPC).
- DOM test runner (jsdom/happy-dom) chưa có sẵn; fix đã tách logic state
  transition ra pure helper để `node:test` cover hành vi + structural assertion
  cover React/IME/DOM contract.

## Local SHA

- Worktree HEAD: `feature/p3-w06a-capability-nav-text-editor` (sẽ commit + push
  sau khi review cuối).

## Trạng thái

**`P3-W06A_CAPABILITY_NAV_TEXT_EDITOR_LOCAL_PASS_FAST_TRACK`** — chưa push,
chưa deploy, chưa Production UAT. Tất cả quality gates đã pass locally trong
worktree `C:\CodeApp\BI-p3-w06a-capability-nav-text-editor`.