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

---

# R1 — Review gaps closure

**Trạng thái R1:** `P3-W06A-R1_CAPABILITY_NAV_TEXT_EDITOR_REVIEW_GAPS_CLOSED_LOCAL_PASS_FAST_TRACK`
**Base R1:** `e4ae7991a836876354fb08bc074dc1436648420c` (giữ nguyên, không
amend/rebase).
**Worktree:** `C:\CodeApp\BI-p3-w06a-capability-nav-text-editor`
**Branch:** `feature/p3-w06a-capability-nav-text-editor`

## Bối cảnh

R00 review nêu 3 gap trong implementation `e4ae799`:

1. **Gap 1 — Actor resolve 2 lần/request.** `dashboard/layout.tsx`,
   `dashboard/page.tsx`, `direct-entry/layout.tsx`, `direct-entry/page.tsx`
   đều tự gọi `getDirectEntryActor`/`resolveSessionWithBoundedRetry`. AppShell
   đôi khi gọi thêm qua layout; page gọi lại qua route guard → 2 lần
   Supabase `getUser` + 2 lần actor repository resolution cho cùng 1 request.
2. **Gap 2 — Mobile dùng nhầm desktop viewport.** AppShell xây 1 closure
   `decide` hardcode `viewport: "desktop"` rồi dùng lại cho cả desktopItems
   và mobileItems. Mobile bị filter theo `entry.visibility.desktop` thay vì
   `entry.visibility.mobile`.
3. **Gap 3 — Behavioral text-cell test tách rời component.** Helper trong
   `text-cell-state.ts` (`applyTextCellKeystroke`, `simulateAsciiKeystrokes`,
   …) là mô phỏng, KHÔNG được `CellsTextEditorComponent` import/gọi. Test
   xanh không chứng minh production đi theo transition tương ứng.

## Cách đóng từng gap

### Gap 1 — Request-scoped actor resolution (React `cache()`)

- `src/lib/navigation/resolve-nav-actor.ts`:
  - Import `cache` từ `react` (RSC request-scoped memo, theo
    `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`).
  - `resolveActorForRequest = cache(async () => …)` — trả về
    `ActorResolution` đầy đủ cho route access.
  - `resolveNavActorForAppShell = cache(async (input: { directEntryEnabled }) => …)` —
    trả về `NavActorProjection` (chỉ `capabilities` + `scopes.kind`).
  - Bỏ `app_user_id` khỏi `NavActorProjection` vì predicate trong
    `registry-capability.ts` không dùng nó.
  - Khi `directEntryEnabled === false`, `resolveNavActorForAppShell` return
    `null` luôn (không query) — AppShell vẫn render Dashboard vì capability
    `any` pass với `actor === null`.
  - Bounded retry H07 (`resolveSessionWithBoundedRetry`) vẫn nằm trong
    `resolveActorForRequest`; chỉ chạy 1 lần nhờ cache.
- `src/app/dashboard/layout.tsx` & `src/app/direct-entry/layout.tsx`:
  - Truyền `directEntryEnabled` cho `resolveNavActorForAppShell` để tránh
    query thừa khi UI flag off.
- `src/app/dashboard/page.tsx` & `src/app/direct-entry/page.tsx`:
  - Gọi `resolveActorForRequest()` (cùng module, cùng cache) thay vì
    gọi trực tiếp `getDirectEntryActor` / `resolveSessionWithBoundedRetry`.
  - Dùng `.catch(() => null)` (Promise chain) thay vì try/catch vì resolver
    đã được wrap bởi React `cache()` trong RSC.
  - direct-entry page chỉ resolve khi `uiEnabled === true` (fail-closed:
    `actor = null` → `decideDirectEntryPageAccess` trả `NOT_FOUND`).
- Tổng quan request lifecycle: 1 request → 1 lần Supabase `getUser` + 1 lần
  actor repository resolution. Layout + page share cache. AppShell nhận
  `actor` projection; route access ở page dùng `ActorResolution` đầy đủ.

### Gap 2 — Asymmetric desktop/mobile viewport

- `src/components/app-shell/app-shell.tsx`:
  - Tách 2 lần gọi `filterEntriesForActor` cho desktop và mobile, mỗi lần
    truyền `viewport` RIÊNG và `entryVisibleInViewport` tương ứng:
    ```ts
    const desktopItems = filterEntriesForActor({
      viewport: "desktop",
      directEntryEnabled,
      actor,
      decide: (entry) => decideNavEntryVisibility({
        capabilityKey: entry.capability, actor, viewport: "desktop",
        entryVisibleInViewport: entry.visibility.desktop,
      }),
    });
    const mobileItems = filterEntriesForActor({ /* ... viewport: "mobile" ... */ });
    ```
  - Phân lớp trách nhiệm rõ: `filterEntriesForActor` filter theo viewport
    (visibility), `decideNavEntryVisibility` chỉ xét capability + actor.
- `src/lib/navigation/registry.ts`:
  - Bỏ `app_user_id` khỏi `actor` type trong `filterEntriesForActor` (PII).
  - `decide` vẫn nhận `NavEntry` đầy đủ (entry-level metadata) — caller chịu
    trách nhiệm truyền viewport/entryVisibleInViewport đúng.
- Test bổ sung: `registry-capability.test.mjs` có 4 test Gap 2 (xem phần
  "Test evidence").

### Gap 3 — Wire production component vào helper

- `src/components/direct-entry/text-cell-state.ts`:
  - Helper duy nhất production dùng: `commitTextCellValue({ row, value, columnKey })`
    → `{ value, nextRow, patch }`. Test gọi cùng helper này.
  - `commitTextCellCompositionEnd({ row, committedValue, columnKey })` cho
    IME composition end (cancel = `committedValue === ""`).
  - Bỏ `applyTextCellKeystroke`, `applyTextCellCompositionEnd` (cũ),
    `simulateAsciiKeystrokes`, `simulateVietnameseIme` (helper mô phỏng bị
    tách rời trước đây).
- `src/components/direct-entry/direct-entry-spreadsheet-grid.tsx`:
  - `CellsTextEditorComponent` import helper:
    ```ts
    import { commitTextCellValue, commitTextCellCompositionEnd }
      from "@/components/direct-entry/text-cell-state";
    ```
  - `commit(nextValue)` gọi `commitTextCellValue({ row, value, nextValue, columnKey: column.key })`.
  - `commitComposition(finalValue)` gọi `commitTextCellCompositionEnd(…)`.
  - `onChange` (keystroke ASCII) → `commit(next)`; `onCompositionEnd` →
    `commitComposition(finalValue)`. `onBlur` vẫn `onClose(true, false)`.
  - Giữ nguyên: stable DOM (`memo(CellsTextEditorComponent)`), `useRef` +
    `useEffect([])` focus/select 1 lần, không debounce, blur/Enter/Tab commit,
    paste/dropdown/date/selection không regress.
- `src/components/direct-entry/direct-entry-text-cell-regression.test.mjs`:
  - Test production thực sự: gọi `commitTextCellValue`/`commitTextCellCompositionEnd`
    với row accumulated qua từng lần (giống `onRowChange` → re-render).
  - Chuỗi `"" → "N" → "Ng" → "Ngu" → "Nguyễn"` verify `row.cells` giữ
    full value.
  - Composition end với `committedValue = "tiếng"` verify ghi vào
    `row.cells.display_name` (gồm ký tự có dấu `ế`).
  - Composition cancel (`committedValue = ""`) giữ nguyên current.
  - Bổ sung `R2-S7` đảm bảo `CellsTextEditorComponent` thực sự import
    helper (regex check import + call site).

## Files thay đổi trong R1

### Sửa (8 files)

| Path | Gap | Thay đổi |
|---|---|---|
| `src/lib/navigation/resolve-nav-actor.ts` | 1 | Wrap cả `resolveActorForRequest` và `resolveNavActorForAppShell` bằng React `cache()`. Bỏ `app_user_id` khỏi projection. `resolveNavActorForAppShell` nhận `directEntryEnabled` để skip query khi UI off. |
| `src/lib/navigation/registry-capability.ts` | 1 | Bỏ `app_user_id` khỏi `NavActorProjection`. |
| `src/lib/navigation/registry.ts` | 1+2 | Bỏ `app_user_id` khỏi `filterEntriesForActor.actor` type; `decide` giữ nhận `NavEntry` đầy đủ. |
| `src/components/app-shell/app-shell.tsx` | 2 | Tách 2 lần gọi `filterEntriesForActor` với `viewport` RIÊNG; truyền `entry.visibility.desktop`/`mobile` đúng cho từng nhánh. |
| `src/app/dashboard/layout.tsx` | 1 | Truyền `directEntryEnabled` cho resolver; dùng `resolveNavActorForAppShell({ directEntryEnabled })`. |
| `src/app/direct-entry/layout.tsx` | 1 | Tương tự dashboard. |
| `src/app/dashboard/page.tsx` | 1 | Dùng `resolveActorForRequest()` (share cache) thay vì gọi trực tiếp `getDirectEntryActor`. Dùng `.catch(() => null)`. |
| `src/app/direct-entry/page.tsx` | 1 | Tương tự. Skip resolve khi `uiEnabled === false`. |
| `src/components/direct-entry/direct-entry-spreadsheet-grid.tsx` | 3 | `CellsTextEditorComponent` import & gọi `commitTextCellValue` / `commitTextCellCompositionEnd`. |
| `src/components/direct-entry/text-cell-state.ts` | 3 | Bỏ helper mô phỏng (`applyTextCellKeystroke`, …). Thêm `commitTextCellValue` / `commitTextCellCompositionEnd` — pure transition thực sự mà production dùng. |

### Sửa test (5 files)

| Path | Gap | Thay đổi |
|---|---|---|
| `src/lib/navigation/registry-capability.test.mjs` | 1+2 | Bỏ `app_user_id` khỏi `makeActor`; thêm 4 test Gap 2 (asymmetric viewport). |
| `src/lib/navigation/resolve-nav-actor.test.mjs` | 1 | Mới: 12 test source-string cho React `cache()` wrap, NavActorProjection shape, layout/page share cache, page skip khi UI off. |
| `src/components/app-shell/app-shell.test.mjs` | 2 | Update regex `filterEntriesForActor` (mở rộng body vì có `directEntryEnabled`); vẫn verify 2 lần gọi với `viewport: "desktop"` / `"mobile"` RIÊNG. |
| `src/components/direct-entry/direct-entry-text-cell-regression.test.mjs` | 3 | Viết lại: test gọi đúng `commitTextCellValue` / `commitTextCellCompositionEnd` (helper production thực sự). Chuỗi `"" → "N" → "Ng" → "Ngu" → "Nguyễn"`. Composition `"tiếng"`. Cancel. Thêm `R2-S7` regex kiểm tra component import helper. |
| `src/components/direct-entry/direct-entry-h08-r1-defaults-text-regression.test.mjs` | 3 | Update regex match `cellsTextEditor` (thêm `rowIdx` forward, mở rộng `CellsTextEditorComponent` body length vì thêm `commitComposition`). |
| `src/components/direct-entry/direct-entry-h07-session-grid-ux.test.mjs` | 1 | Update test A2: page dùng `resolveActorForRequest().catch(() => null)` (Promise chain) thay vì `try/catch`. |
| `src/app/dashboard/layout.test.mjs` | 1 | Update assertion: `resolveNavActorForAppShell({ directEntryEnabled })`. |
| `src/app/direct-entry/layout.test.mjs` | 1 | Tương tự. |

## Test evidence

Toàn bộ targeted tests (chạy từ worktree `C:\CodeApp\BI-p3-w06a-capability-nav-text-editor`):

| Suite | Số test | Pass |
|---|---:|---:|
| `registry-capability.test.mjs` (incl. 4 Gap 2) | 18 | 18 |
| `resolve-nav-actor.test.mjs` (mới) | 12 | 12 |
| `app-shell.test.mjs` (Gap 2 regex) | 21 | 21 |
| `direct-entry-text-cell-regression.test.mjs` (helper production) | 13 | 13 |
| `direct-entry-h08-r1-defaults-text-regression.test.mjs` (regex mở rộng) | 25+ | tất cả |
| `direct-entry-h07-session-grid-ux.test.mjs` (Promise catch) | A1-A3 + 30+ | tất cả |
| `registry.test.mjs` + 3 layout tests (`test:app-nav-02a`) | 53 | 53 |
| `direct-entry-text-cell-regression` + `direct-entry-excel-paste` + `direct-entry-h08-r1-defaults-text-regression` + `direct-entry-h07-session-grid-ux` + `direct-entry-live-spreadsheet` + `direct-entry-cccd-manager` | 94 | 94 |
| `pnpm test:main` | 447 | 447 |
| `pnpm test:server` | 102 | 102 |
| `pnpm test:export` | 4 | 4 |
| `pnpm test` (toàn bộ) | nhiều trăm | 0 fail |

Quality gates:

- `next typegen`: ✓ Types generated successfully
- `pnpm typecheck`: ✓ 0 errors
- `pnpm lint`: ✓ 0 errors (6 pre-existing warnings, không phải R1)
- `pnpm build`: ✓ Static + Dynamic routes OK
- `pnpm docs:check`: ✓ 6/6 examples pass
- `pnpm secrets:check`: ✓ ĐẠT — không tìm thấy secret
- `pnpm db:migrate --status`: ✓ 39 applied, 0 pending (39/0/0)
- `git diff --check`: ✓ no whitespace errors

## Ranh giới

Không sửa:

- `src/lib/auth/direct-entry-session.ts` (Supabase + `resolveDirectEntrySession`).
- `src/lib/auth/direct-entry-session-retry.ts` (H07 bounded retry).
- `src/lib/direct-entry/actor-context-repository.ts` (Supabase RPC).
- Migration/DB/RPC/reporting/AI API internals/package/lockfile/env/workflow/main/deployment/primary checkout.
- Bất kỳ chỗ nào ngoài 13 file nêu trên (trừ doc).

## Local SHA

- R1 base (giữ nguyên): `e4ae7991a836876354fb08bc074dc1436648420c`
- R1 commit (sẽ commit + push trên `feature/p3-w06a-capability-nav-text-editor`).

## Trạng thái

**`P3-W06A-R1_CAPABILITY_NAV_TEXT_EDITOR_REVIEW_GAPS_CLOSED_LOCAL_PASS_FAST_TRACK`** — local pass, chưa push, chưa deploy, chưa UI UAT.