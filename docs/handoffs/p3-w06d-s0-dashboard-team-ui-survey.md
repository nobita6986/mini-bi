# P3-W06D-S0 — BoD team-reporting Dashboard UI reuse/readiness survey

## Status

`P3_W06D_S0_R1_DASHBOARD_TEAM_UI_SURVEY_REPAIR_PASS_AWAITING_T0_REVIEW`

## Preflight / base

- Repo: `C:\CodeApp\BI`
- Remote: `origin`
- Survey worktree: `C:\CodeApp\BI-p3-w06d-s0-dashboard-team-ui-survey`
- Branch: `audit/p3-w06d-s0-dashboard-team-ui-survey`
- Existing survey commit: `c8e2834e433fa5cb3118cb613bdf18d0a513c503`; R1 appends exactly one commit on top.
- Current authority main: `origin/main@cd934b3541c4f4e4663f23cc5df174497f96935e`.
- R9 source of truth: `docs/handoffs/p3-w05b-s0-r7-bod-team-reporting-rebaseline.md` at current main.
- Primary checkout: không sửa; R1 preflight trên survey worktree sạch, fetch `origin --prune` đã hoàn tất.
- Migration ledger theo R9: 84 migration; next available #85 chỉ là observation, không reserve slot.

## Survey conclusion

Có thể triển khai UI sau khi T0 chấp nhận R9 và T1B hoàn tất backend/read-model/drill-down contract. UI có thể reuse phần lớn dashboard hiện tại và không cần dependency hoặc chart library mới.

Có ba blocker sequencing bắt buộc:

1. `ReportingData` hiện chưa có `byTeam`; R9 yêu cầu facts/scoped-facts mở rộng từ 15 lên 19 field/key với đúng bốn field `team_id`, `team_code`, `team_display_name`, `team_active`. `team_active` là server-only, không xuất hiện trong client payload hoặc drill-down row.
2. Chưa có `direct_entry_reporting_team_drill_down`, server function hoặc Route Handler `GET /api/reporting/team-drill-down` tại `src/app/api/reporting/team-drill-down/route.ts`; vì vậy chưa thể viết UI drill-down thật mà không tự tạo contract ngoài R9.
3. T1A không được bắt đầu implementation trước khi T0 chấp nhận R9; khi được mở, T1A chỉ tiêu thụ contract T1B, không tự join team/membership, không gọi Admin Catalog và không suy quyền client-side.

Không có blocker reuse UI. T0 đã chấp nhận team-specific horizontal-bar sibling. Chart reuse theme, tooltip và view-model conventions, nhưng `RecruiterBarChart` không phải component generic cho bucket selection: nó có semantics top-N, tick truncation cố định và không có click/keyboard selection. Sibling nhỏ này không generic hóa component recruiter hiện tại.

## 1. Current UI truth

### 1.1 Route, auth and server read

`src/app/dashboard/page.tsx:17-60` là Server Component, `dynamic = "force-dynamic"` tại dòng 12. Page:

- resolve actor bằng `resolveActorForRequest()` trước khi đọc reporting (`page.tsx:28`);
- dùng `decideSessionPageAccess(actor)` cho redirect/unavailable (`page.tsx:30-39`);
- await `searchParams` rồi gọi song song `fetchCutoverReporting(params, actor.actor)` và `fetchCutoverReportingOptions(actor.actor)` (`page.tsx:46-50`);
- truyền `audience={report.ok ? report.audience : null}` xuống `DashboardView` (`page.tsx:54-59`).

Audience không đến từ role/capability client. Đây là DB-authoritative W05A payload. `src/lib/reporting/p3-w05a-audience.ts:51-67` fail-closed khi payload không hợp lệ; projection chỉ giữ `kind` và label, không để UUID/auth subject/PII ra UI.

### 1.2 Audience dispatch

`src/lib/reporting/p3-w06c-audience-view.ts:53-75` hiện có mode:

- `error` nếu read fail hoặc audience null/unknown;
- `all` cho BoD;
- `team` với `ScopedDashboardView`;
- `own` với `ScopedDashboardView`.

`src/components/dashboard/dashboard-view.tsx:62-105` dispatch trực tiếp:

- `mode.kind === "team"` → `TeamDashboardView`;
- `mode.kind === "own"` → `OwnDashboardView`;
- phần còn lại sau hai nhánh là BoD current layout.

`src/components/dashboard/p3-w06c-dashboard-audience.test.mjs:17-67` đã pin audience DB-authoritative, fail-closed và không suy audience từ actor role/scope trong page. `src/lib/reporting/p3-w06c-audience-view.test.mjs:28-49` pin mode error/all/team/own.

### 1.3 Current BoD layout

BoD hiện render trực tiếp trong `DashboardView`:

- hero `BoD · Báo cáo điều hành`, tiêu đề `Tổng quan tuyển dụng`, timestamp và hai KPI tại `dashboard-view.tsx:112-130`;
- filter + empty/no-match handling tại `dashboard-view.tsx:169-196`;
- trend chart và bảng ngày tại `dashboard-view.tsx:198-227`;
- project/provider/project-provider/employment/recruiter breakdown tại `dashboard-view.tsx:229-255`.

R9 khóa Tab 1 phải giữ nguyên layout này. Không chuyển `TeamDashboardView` vào BoD Tab 2 và không thay đổi semantics các card hiện có.

### 1.4 Team and own truth

`src/components/dashboard/team-dashboard-view.tsx:20-25` là UX team riêng: scope banner, member-contribution roster, team KPIs, trend và team-scoped breakdown. Nó dùng props `ReportingData`, `ReportingOptionsResult`, `ScopedDashboardView` (`team-dashboard-view.tsx:28-38`) và không tự fetch.

`src/components/dashboard/own-dashboard-view.tsx:17-21` là UX cá nhân: không roster, không company ranking, không recruiter filter. `own-dashboard-view.tsx:24-34` nhận cùng kiểu props và `own-dashboard-view.tsx:64-71` dùng `showRecruiter` từ view projection.

Acceptance bắt buộc giữ nguyên:

- `team` đi thẳng vào `TeamDashboardView`;
- `own` đi thẳng vào `OwnDashboardView`;
- hai view này không nhìn thấy hai tab BoD hoặc team chart;
- BoD cross-team không reuse `TeamDashboardView`.

### 1.5 Current data shape and missing pieces

`src/lib/reporting/p1-reporting.ts:18-30` hiện có fact fields theo ngày/project/recruiter/provider/employment, không có team field.

`ReportingData` tại `p1-reporting.ts:91-105` có `byDate`, `byProject`, `byRecruiter`, `byProvider`, `byEmployment`, `projectProviderMix`, coverage, sources, date extent và empty flags; chưa có `byTeam`.

R9 yêu cầu additive:

```ts
byTeam: Record<string, ReportingBucket>
```

với `ReportingBucket` hiện có `{ key, display, recruitedCount }`. `byTeam` phải tính server/read-model từ cùng scoped-facts array và thỏa `recruitedTotal === sum(byTeam[*].recruitedCount)`, gồm cả bucket `unknown`.

R9 cũng yêu cầu drill-down server-side, chưa tồn tại trên current main:

- chưa có RPC `direct_entry_reporting_team_drill_down`;
- chưa có `fetchCutoverTeamDrillDown`;
- chưa có `GET /api/reporting/team-drill-down` hoặc file `src/app/api/reporting/team-drill-down/route.ts`; đây là T1B dependency còn thiếu trên current main.
- chưa có `bucket_key` hoặc hai-tab BoD UI.

## 2. Reuse matrix

| Nguồn hiện tại | Có thể reuse | Ràng buộc / không reuse |
|---|---|---|
| `src/app/dashboard/page.tsx:17-60` | auth gate, `searchParams`, `Promise.all`, DB-authoritative audience pass-through | không mở rộng page để tự suy team; drill-down đi qua Route Handler T1B riêng |
| `dashboard-view.tsx:49-105` | dispatch all/team/own và fail-closed error branch | chỉ bọc BoD `all` bằng tab shell; giữ `DashboardBody` làm Tab 1 |
| `dashboard-view.tsx:169-260` | toàn bộ BoD current body làm Tab 1 | không sao chép body sang Tab 2; không đổi card/filter semantics |
| `team-dashboard-view.tsx:28-185` | layout spacing, `Card`, `KpiCard`, trend/table accessibility, responsive grid | không dùng làm cross-team report; không đưa member roster vào Tab 2 |
| `own-dashboard-view.tsx:24-141` | pattern empty/no-match/filter/scoped props | không thay đổi; không cho own nhìn thấy tab BoD |
| `dashboard-shared.tsx:17-87` | `FiltersOrError`, `NoMatchesBlock`, `ScopeNote`, sort/list conventions | `BucketList` hiện là read-only `<details>`; nó chưa có selected state hoặc click/keyboard selection, nên không dùng nguyên trạng cho bucket picker nếu không đạt contract |
| `dashboard-filters.tsx:12-20,46` | existing filter parser keys và nuqs update behavior; `shallow:false`, `scroll:false` giữ server report reload | không trộn `tab` vào `ReportingFilters`; tab state phải là parser riêng để `setFilters(null)` không xóa tab |
| `p3-w06c-audience-view.ts:64-75` | `resolveDashboardMode` làm boundary duy nhất cho all/team/own/error | không thêm client authority check |
| `p1-reporting.ts:56-60,91-105` | `ReportingBucket`, `ReportingData` additive shape và display/count conventions | backend T1B phải thêm `byTeam`; T1A không tự tính từ facts hoặc membership |
| `p1-dashboard.ts:22-63` | `buildDailyTrend`, `sortBuckets`, `topBuckets`; deterministic sort theo count/display | team bucket chart không được âm thầm bỏ bucket khỏi accessible list |
| `p1-chart-data.ts:34-82,93-178` | `stableColorForKey`, color slots, `buildCategorySegments`, `buildBarData`; chart data thuần và testable | `buildBarData` là top-N; `ProjectDonut` gộp 8 slice + `Khác`; cần quyết định rõ all-bucket/list behavior trước implementation |
| `project-donut.tsx:30-63` | theme color, legend, tooltip, `aria-label`, full display trong legend | không có item selection/click; max 8 + `Khác` không đủ làm bucket picker duy nhất nếu cần tất cả nhóm |
| `recruiter-bar-chart.tsx:14-33` | Recharts horizontal-bar visual grammar, `ChartTooltip`, stable colors, no animation | tên component/model là recruiter-specific; tick truncate 18 chars, fixed `h-72`, top-N input và không có click/keyboard selection. Không generic hóa chỉ vì muốn reuse |
| `provider-donut.tsx:10-43` | donut/theme/legend/tooltip pattern | static, không selection; chỉ hợp với summary, không đủ cho drill-down picker |
| `employment-composition.tsx:4-24` | compact accessible bar + legend pattern | không phù hợp nhiều nhóm/selection/pagination |
| `trend-chart.tsx:16-39` | mounted placeholder, responsive container, `role=img`, theme tokens, `ChartTooltip`, no animation | không liên quan team bucket interaction |
| `chart-tooltip.tsx:16-31` | sanitized display/value tooltip, theme token classes | không render key/UUID; giữ labels display-only |
| `Card`/`CardHeader` `src/components/ui/card.tsx:5-19` | existing card/header semantics and tokens | không tạo card lồng card ngoài pattern hiện tại |
| `KpiCard` `src/components/dashboard/kpi-card.tsx:3-29` | compact KPI only if Tab 2 needs count summary | R9 không yêu cầu thêm aggregate dimension/KPI; không thêm nếu không cần |
| `EmptyState` `src/components/reporting/empty-state.tsx:1-8` | no-data state | không dùng làm API error |
| `ErrorState` `src/components/reporting/error-state.tsx:1-7` | role alert generic failure | retry action sẽ nằm tại team panel vì `ErrorState` hiện chỉ render text |
| `Alert` `src/components/ui/alert.tsx:5-24` | `info/warning/error`, `role=status/alert` | dùng cho loading/error/retry, không lộ raw DB code/message |
| `src/lib/theme/theme-registry.ts:10-24,153-180` | semantic tokens, chart slots, light/dark theme | không thêm theme/chart dependency |
| worker tabs `src/components/direct-entry/worker-operations.tsx:391-401,439-457,503+` | baseline mạnh nhất cho tablist, roving `tabIndex`, `aria-selected`, `aria-controls`, ArrowLeft/Right/Home/End, focus movement | team-leader tabs `team-leader-manager.tsx:454-463` chỉ có role/selected, thiếu keyboard/controls; không copy pattern yếu đó |
| `src/components/direct-entry/worker-operations.test.mjs:24-35,58-69` | source assertions cho keyboard, roles, cursor/Load more/reset semantics | W06D tests cần thêm audience/tab/filter/bucket allowlist cases |
| `src/app/layout.tsx:3,25-36` | `NuqsAdapter` đã global; không thêm provider/dependency | tab parser phải tương thích Next App Router adapter |

### Chart recommendation

R9/T0 đã chấp nhận **team-specific horizontal bar sibling** cho Tab 2. Sibling này reuse view-model/color/tooltip conventions của `RecruiterBarChart` nhưng không generic hóa hoặc đổi semantics component recruiter hiện tại:

- phù hợp tên nhóm dài hơn donut;
- có thể hiển thị nhiều bucket hơn mà không biến chart thành một lát donut khó đọc;
- có thể thêm selected state và mouse activation;
- list accessible bên dưới là full source of truth cho tên dài và keyboard selection;
- dùng `stableColorForKey` cho màu ổn định, nhưng UI chỉ render `display`, không render `bucket_key`.

`RecruiterBarChart` không generic đủ cho việc này vì `BarDatum` có semantics `name`, `buildBarData` có `top` limit, tick chỉ giữ 18 ký tự (`recruiter-bar-chart.tsx:10-14`) và component không nhận callback selection. T1A phải thêm sibling team-specific nhỏ, giữ full accessible bucket list và không render `bucket_key`.

## 3. Proposed component tree after T0/R9 and T1B approval

Đây là tree khảo sát, không phải implementation:

```text
DashboardPage (Server Component)
└── DashboardView (server audience boundary)
    ├── error → ErrorState / ReportError
    ├── team → TeamDashboardView (unchanged)
    ├── own → OwnDashboardView (unchanged)
    └── all → BodDashboardTabs (client tab/url shell)
        ├── tab=general → existing DashboardBody (unchanged Tab 1)
        └── tab=team → TeamReportingPanel (client interaction)
            ├── TeamBucketChart (small sibling; horizontal bar recommendation)
            ├── selectable full bucket list (display/count only)
            └── TeamDrilldownPanel
                ├── selected bucket display/title
                ├── sanitized detail table (exact seven row fields)
                ├── Tải thêm with opaque cursor
                └── UnknownPanel
                    ├── legacy aggregate summary card (non-paginated)
                    └── Direct Entry anomaly table (paginated)
```

Boundary decisions:

- `DashboardView` remains the only audience dispatch point.
- Tab 1 receives the existing `DashboardBody`; no second copy of the current BoD layout.
- Tab 2 receives `byTeam` and the server-drill-down contract as props/config, but performs no client-side team join or regrouping.
- Selecting a bucket is ephemeral client state, not a URL value. `bucket_key` is sent to the server request but is never shown or put into a user-facing label. This avoids treating the routing key as display data and avoids adding an opaque internal key to deep links.
- Drill-down fetch occurs only after an explicit bucket selection. No initial auto-fetch, no N+1 per chart bucket, no infinite scroll.

## 4. Two-tab URL and state contract

R9/T0 đã chấp nhận URL contract `tab=general|team`; `general` là mặc định. T1A phải giữ đúng contract này, không tạo query-key khác. R9/T0 cũng chấp nhận team-specific horizontal-bar sibling; không generic hóa `RecruiterBarChart`.

### 4.1 Initial/default/deep-link behavior

- Missing `tab` → `general` (Tab 1, `Báo cáo tổng quát`).
- `tab=general` → Tab 1.
- `tab=team` → Tab 2 after SSR/hydration with no visible authority or data widening.
- Unknown, empty, repeated or malformed `tab` → normalize to `general`; do not select a hidden/third view.
- Refresh preserves the selected tab and all existing reporting filters.
- A deep link containing `tab=team` must server-render with the same initial tab value passed into the client shell, so hydration does not first paint Tab 1 and then jump to Tab 2.
- Selected bucket and cursor remain local state. They are reset when the bucket or reporting filter changes; they are not serialized as `bucket_key` in the URL.

### 4.2 Filter preservation

Các filter chung `from`, `to`, `project`, `recruiter`, `provider`, `employment` vẫn được giữ khi đổi tab. `source` chỉ thuộc current general dashboard filter contract; nó **không** thuộc team report/drill-down contract của R9.

- Tab `general`: giữ nguyên `source` và các filter hiện tại.
- Chuyển sang tab `team`: nếu URL có `source`, phải xóa `source` khỏi URL state và thực hiện authoritative server reload trước khi hiển thị `byTeam` hoặc detail. Không được render team aggregate từ payload đang source-filtered rồi mới âm thầm bỏ `source` khi gọi drill-down.
- Direct URL `tab=team&source=...` áp dụng cùng normalization: giữ `from/to/project/recruiter/provider/employment`, loại `source`, chờ server reload authoritative, rồi mới hiển thị team aggregate/detail.
- Drill-down request tuyệt đối không gửi `source`; nếu client còn gửi `source`, thin parser phải trả `INVALID_FILTER` theo R9. Đây không phải lý do để bỏ `source` im lặng trong khi `byTeam` vẫn dùng payload source-filtered.

`parseReportingFilters` và `ReportingFilters` giữ nguyên. `tab` không thuộc reporting filter parser; `source` vẫn hợp lệ cho general dashboard nhưng không hợp lệ cho team drill-down. `DashboardFilters` tiếp tục dùng `useQueryStates(..., { shallow: false, scroll: false })`; tab state phải là parser riêng để filter reset không làm mất tab.

### 4.3 History and hydration

- Tab changes should use URL history entries (`history: "push"`) so browser Back/Forward traverses the two BoD tabs.
- Tab changes should not refetch the reporting payload; they are UI state updates and should keep `shallow: true` and `scroll: false` unless the final nuqs version requires an equivalent configuration.
- Filter changes preserve `tab`, retain current `shallow:false` server reload semantics, and reset selected bucket/cursor after the new authoritative report is received.
- The server page may receive `tab` in the full `searchParams` record, but reporting parsing must continue to ignore it. The client shell receives a server-normalized initial tab matching the URL.
- Back/Forward tests must cover: general → team → Back = general; filter retained across each transition; direct refresh on `tab=team`; invalid tab falls back to general; no hydration mismatch.

## 5. BoD team report UI contract

### 5.1 Aggregate chart and list

Tab 2 shows only the team aggregate dimension:

- chart data is `report.data.byTeam` from the same server read-model as `recruitedTotal`;
- no client-side grouping of facts;
- no second project/provider/employment aggregate inside Tab 2;
- full bucket list remains available even if the chart uses a compact presentation;
- each visible label comes from server `display`;
- inactive team labels already include the server suffix `" (Đã ngừng hoạt động)"`;
- `unknown` uses server display `"Không xác định"`;
- the UI never renders `bucket_key`, raw `teams.code`, team UUID, membership UUID or any internal identifier.

The bucket list must be a real interactive control, not only the existing read-only `BucketList` table. Each row/button exposes display and recruited count, selected state and an accessible name. Mouse and keyboard selection must resolve to the same handler and reset drill-down pagination to page one.

### 5.2 Drill-down request/response

The UI consumes the exact R9 response envelope from `direct_entry_reporting_team_drill_down`:

```text
bucket: { key, display }
rows: [
  business_date,
  project_display,
  recruiter_display,
  provider_type_display,
  employment_type_display,
  recruited_count,
  first_work_date
]
nextCursor: opaque | null
total: number
applied: current filters
legacy_aggregate_total: present only for unknown
```

Only these seven row fields may reach visible table cells:

1. `business_date`
2. `project_display`
3. `recruiter_display`
4. `provider_type_display`
5. `employment_type_display`
6. `recruited_count`
7. `first_work_date`

The panel title uses `bucket.display`, never `bucket.key`. The UI must not decode, derive or display the key. `total` for the unknown bucket is anomaly-row count only, not legacy aggregate plus anomaly count.

### 5.3 Unknown split

For the server-provided `unknown` bucket, render two distinct sections:

- **Section A — `Tổng hợp từ dữ liệu cũ (tổng hợp theo ngày, không phải entry-level)`**: summary card only, using `legacy_aggregate_total`. It is not paginated and must not show entry-level rows.
- **Section B — `Anomaly Direct Entry (không gán được team)`**: paginated sanitized rows from `rows[]`, with `Tải thêm` driven by `nextCursor`.

Do not call legacy aggregate rows entry-level data. Do not issue a second RPC for Section A; R9 places both pieces in one response.

### 5.4 Pagination and reset

- Initial bucket selection requests page one with `cursor=null`, default `limit=25`.
- `limit` is never user-controlled beyond the locked server bound; UI may use the default 25.
- `Tải thêm` appends the next page using the opaque `nextCursor` returned by the server.
- No infinite scroll and no auto-fetch on panel visibility.
- Hide or disable `Tải thêm` when `nextCursor === null`.
- Bucket change clears existing rows/cursor and requests the new bucket from page one.
- Any reporting filter change clears selected bucket, rows and cursor after the filter result is authoritative.
- Retry replays the same bucket/filter/cursor request; it must not manufacture rows or change the selected bucket optimistically.
- A cursor beyond the last page is rendered as an empty page with `nextCursor=null`, not as a fake error, per R9.

### 5.5 State matrix

| State | Required UI behavior |
|---|---|
| Initial Tab 2 / no bucket selected | show chart + full bucket list and a neutral prompt to select a group; no drill-down request |
| Aggregate data loading | existing dashboard route uses `src/app/dashboard/loading.tsx`; no fake by-team values during server reload |
| Aggregate read error | reuse existing sanitized `ReportError`/`ErrorState`; no chart/list from stale or guessed data |
| No sources/no facts | preserve existing `EmptyState` semantics from `DashboardView` |
| No matches | preserve `NoMatchesBlock`; clear selected bucket because prior detail is stale for new filters |
| Drill-down loading | `role=status`, disable duplicate selection/load-more as appropriate, keep selected display visible |
| Drill-down loaded | show exact allowlisted rows; show `Tải thêm` only when cursor exists |
| Drill-down empty | `role=status`/empty panel for zero anomaly/detail rows; do not treat as API failure |
| Drill-down invalid filter | sanitized `INVALID_FILTER` message; do not display raw DB text; selected state may be cleared |
| Drill-down unavailable/transport error | `role=alert` with retry using the same request parameters; no optimistic rows |
| Unknown bucket | show Section A summary and Section B anomaly pagination; never show legacy as rows |
| Inactive bucket | preserve server suffix and bucket identity; never move it to Unknown or hide it |
| Tab change | preserve reporting filters; switch only the all-audience panel; team/own have no tab shell |

## 6. Responsive and accessibility contract

### 6.1 Tabs

Use the stronger worker pattern from `worker-operations.tsx:391-401,439-457`:

- container `role="tablist"` with a Vietnamese accessible label;
- each control `role="tab"`, stable `id`, `aria-selected`, `aria-controls`, and `tabIndex` roving 0/-1;
- `role="tabpanel"`, stable panel id, `aria-labelledby`, and hidden inactive panel semantics;
- ArrowRight/ArrowLeft wrap between two tabs; Home/End jump; prevent default; focus moves to the selected tab;
- mouse click and keyboard activation share the same tab setter;
- the weaker team-leader pattern (`team-leader-manager.tsx:454-463`) is insufficient because it lacks controls and keyboard movement.

### 6.2 Bucket selection and detail rows

- Use native buttons or equivalent keyboard controls for the bucket list; selection must work with Enter/Space.
- Selected bucket has a programmatic state (`aria-pressed` or equivalent) and a visible focus ring.
- The chart may provide mouse activation, but the synchronized bucket list is the mandatory keyboard path; if chart marks are made interactive, they need the same keyboard action and selected state.
- After selection, move focus to the drill-down heading or announce the loaded panel through `role=status` without stealing focus from an intentional keyboard sequence.
- Table uses a caption, `scope="col"` headings and `scope="row"` where appropriate. Do not expose hidden internal fields through captions, titles or aria labels.

### 6.3 Mobile and long labels

- Preserve the current `max-w-6xl`/responsive padding pattern (`team-dashboard-view.tsx:48`) and one-column-first grid (`team-dashboard-view.tsx:156-179`).
- Tabs wrap when needed; do not force a body-level horizontal scrollbar.
- Long team names wrap or truncate only in a bounded visual cell with the full server display available to assistive technology and the accessible full list. Never replace the display with raw `bucket_key`.
- Detail table may use an inner `overflow-x-auto` container with a deliberate minimum width, as in existing worker tables, but the page itself must not overflow horizontally.
- Chart height/layout must account for a variable number of teams; do not use a fixed layout that overlaps labels or pushes the page wider.
- Verify narrow viewport behavior for 320–390px and desktop widths; no forced horizontal page scroll, clipped focus ring or overlapping tab labels.

## 7. Backend fields and authority boundary

### 7.1 Aggregate fields needed by UI

From the T1B-extended `ReportingData`:

```text
byTeam[bucket_key] = {
  key: opaque routing key,
  display: current server team label,
  recruitedCount: aggregate count
}
```

The UI uses `display` and `recruitedCount`. It uses `key` only as an opaque request value after selection; it does not render it, decode it or use it as an authority decision.

R9 backend projection dependency: facts view/scoped-facts tăng từ 15 lên 19 projected columns/keys với đúng bốn field `team_id`, `team_code`, `team_display_name`, `team_active`. `team_active` chỉ dùng server-side để compose inactive suffix; không vào `ReportingData` client payload theo dạng boolean và không vào drill-down row.

Server guarantees required by R9:

- historical attribution uses stored `direct_entries.team_id`, not current membership;
- inactive team remains its own bucket and server appends ` (Đã ngừng hoạt động)`;
- Vendor system team is a known `Vendor` bucket, not Unknown;
- legacy aggregate and Direct Entry null/orphan rows are combined only in `unknown`;
- `byTeam` reconciles to `recruitedTotal`;
- labels come from current `teams.display_name`, not Admin Catalog or client join.

### 7.2 Drill-down fields needed by UI

The Route Handler response must provide exactly the R9 sanitized envelope. The seven visible row fields are listed in §5.2. Forbidden fields include `entry_id`, `submission_id`, `source_id`, `drive_file_id`, `file_name`, all key variants, `team_id`, `team_code`, `bucket_key`, `auth_subject`, and `app_user_id`.

R9 server taxonomy consumed by UI:

- `INVALID_FILTER` for invalid bucket key, limit/cursor or filter;
- `REPORTING_QUERY_FAILED` for non-`all` audience, RPC failure or transport failure;
- cursor beyond last row is a successful empty page with `nextCursor=null`.

No separate client-side denial inference is allowed. The RPC re-resolves audience server-side and only DB-confirmed `all` may use cross-team drill-down.

## 8. Testing and mutation plan

### 8.1 Focused acceptance tests

The future W06D focused lane must pin at least:

| Area | Required assertion |
|---|---|
| Audience | `all` gets exactly two tabs; `team`/`own` dispatch unchanged and never render tabs/team chart |
| Default | missing/invalid tab selects `Báo cáo tổng quát` |
| URL | deep-link/refresh `tab=team`; tab Back/Forward; common filters preserved; `source` normalized away before team reload/detail |
| Parser boundary | `tab` stays outside `parseReportingFilters`; general preserves `source`; team normalization removes `source` before authoritative reload; drill-down rejects `source` |
| Accessibility | tablist/tab/tabpanel, aria-selected, aria-controls, roving tabIndex, ArrowLeft/Right/Home/End and focus movement |
| Chart/list | chart/list labels use server `display`; no `bucket_key`, raw code or UUID rendered |
| Labels | inactive suffix survives; Unknown label is exact; Vendor stays known if returned by server |
| Selection | mouse and keyboard select the same bucket; selection resets cursor and starts page one |
| Row allowlist | detail rows contain/render exactly the seven R9 fields; forbidden identifiers never appear |
| Unknown split | legacy summary is non-paginated; anomaly rows paginate separately; legacy is not described as entry-level |
| Pagination | opaque cursor, `Tải thêm`, append behavior, no infinite scroll/auto-fetch, disabled/hidden at null cursor |
| Retry/error | loading/error/empty/retry are explicit and sanitized; retry does not fabricate or optimistically retain stale rows |
| Reset | bucket/filter change clears old detail rows and cursor |
| Responsive | no body horizontal overflow; long labels and focus states remain usable on mobile |
| Fetch discipline | no N+1, no client team/membership join, no Admin Catalog call, no parallel fetch from scoped views |

Existing tests to extend/reuse:

- `src/components/dashboard/p3-w06c-dashboard-audience.test.mjs` for dispatch and no client authority;
- `src/lib/reporting/p3-w06c-audience-view.test.mjs` for mode invariants;
- `src/lib/reporting/p1-chart-data.test.mjs` for deterministic colors, totals, sentinel handling and no PII in view-models;
- `src/components/direct-entry/worker-operations.test.mjs` for tab keyboard/ARIA assertion style.

### 8.2 Minimum mutation probes

Each probe must make the focused lane fail, restore the source byte-identically, then pass again:

1. Render BoD tabs/team chart for `team` or `own` → must fail the audience dispatch test.
2. Render `bucket_key`, `team_id`, raw code or UUID in chart/list/title/row → must fail the no-internal-identifier test.
3. Use `TeamDashboardView` or add project/provider/employment re-bucketing inside Tab 2 → must fail the no-second-dimension test.
4. Add any forbidden row field or treat `legacy_aggregate_total` as entry-level rows → must fail exact allowlist/unknown split tests.
5. Auto-fetch/infinite-scroll or fail to reset cursor on bucket/filter change → must fail pagination/reset tests.
6. Remove `aria-controls`, roving `tabIndex` or Arrow/Home/End handling → must fail keyboard tab tests.
7. Feed `tab` into `parseReportingFilters`, show team aggregate/detail before removing URL `source` and completing authoritative reload, or send `source` to drill-down → must fail URL/source-normalization tests.
8. Render stale/optimistic rows after a failed or changed drill-down request → must fail loading/error/reset tests.

## 9. Exact future file boundary

This survey adds no implementation. Once T0 accepts R9 and T1B is green, expected implementation files are:

### T1B dependency files, not part of this UI survey

- One new append-only migration under `supabase/migrations/` selected by T0; R9 says next available is #85 but does not reserve a number.
- `src/lib/reporting/p1-reporting.ts` — additive `byTeam` and team fact projection/read-model invariants.
- `src/lib/reporting/p1-filter.ts` — `parseReportingFilters` và `ReportingFilters` giữ nguyên; không thêm `bucket_key`/`cursor`/`limit` vào đây.
- `src/lib/reporting/p2-w04a-reporting-server.ts` hoặc một reporting sibling — `parseTeamDrillDownRequest` thin parser, `fetchCutoverTeamDrillDown` và sanitized taxonomy.
- `src/app/api/reporting/team-drill-down/route.ts` — locked `GET /api/reporting/team-drill-down`, own auth/cache/runtime boundary and sanitized response mapping.
- T1B contract/read-path/migration tests named by the R9 dependency plan, including by-team read-model and drill-down exact-row tests.

### T1A UI files expected after T1B

- Modify `src/components/dashboard/dashboard-view.tsx` only to keep current dispatch and wrap the `all` branch in the two-tab shell.
- Add `src/components/dashboard/bod-dashboard-tabs.tsx` for `tab` URL state, SSR initial value, ARIA tab contract and keyboard navigation.
- Add `src/components/dashboard/team-reporting-panel.tsx` for bucket selection, drill-down request state, reset/retry and Unknown split.
- Add `src/components/dashboard/team-bucket-chart.tsx` as the accepted team-specific horizontal-bar sibling; do not genericize or alter recruiter semantics.
- Add or extend focused source/assertion tests for the dashboard UI and package lane registration in the implementation task.

### Files intentionally expected to remain unchanged by T1A

- `src/components/dashboard/team-dashboard-view.tsx`
- `src/components/dashboard/own-dashboard-view.tsx`
- `src/components/dashboard/dashboard-shared.tsx` unless a narrowly justified interactive list reuse is accepted
- `src/components/dashboard/dashboard-filters.tsx` preferred unchanged; tab parser stays separate
- `src/app/dashboard/page.tsx` preferred unchanged; its existing actor/audience/read contract is sufficient
- `src/components/ui/*`, chart primitives and theme registry
- all Admin Catalog/API/RPC/schema/migration files

No dependency or chart library is proposed.

## 10. T1B dependency / blocker statement

T1A is blocked until all of the following are true:

1. T0 accepts `P3_W05B_S0_R9_CONTRACT_CONSISTENCY_PASS_AWAITING_T0_REVIEW`.
2. T1B lands exactly one append-only patch-in-place migration without re-emitting W04A/W05A bodies and preserves the W02C employment-display patch.
3. T1B extends the scoped-facts/read-model contract with `byTeam` and exactly four additive fields/keys (`team_id`, `team_code`, `team_display_name`, `team_active`) while preserving existing keys/order/ACL/search_path behavior; `team_active` remains server-only.
4. T1B provides the all-only drill-down RPC, `src/app/api/reporting/team-drill-down/route.ts`, thin parser/server function, opaque cursor, limit 25/100, exact seven-row allowlist and sanitized error taxonomy.
5. T1B tests prove audience re-check, historical attribution, inactive/Unknown/Vendor buckets, canonical bucket-key validation, reconciliation, no N+1 and no forbidden field leakage.
6. The locked Route Handler path/response envelope and T1B backend are available to T1A; T1A must not invent a parallel mock API or bypass the backend.

If any backend field, route, error code or Unknown split changes, this survey must be re-reviewed before UI implementation. No implementation should start from the pre-R9 R6 memo alone.

## 11. Explicit no-implementation statement

This worktree contains only this survey memo. No source/UI/API/schema/migration/test/package/dependency file was modified. No production query/apply, deploy, browser UAT, Admin Catalog call, mock production API, merge to `main`, or implementation stub was created.

## 12. Review target

T0 review should confirm:

- current dispatch and reuse map are factually grounded in current main;
- the two-tab URL contract (`tab=general|team`) is acceptable;
- horizontal bar sibling versus existing chart reuse boundary is acceptable;
- selected bucket remains local and never exposes `bucket_key` as user-facing state;
- Unknown panel and exact seven-field rows match R9;
- T1A/T1B file boundaries and sequencing are accepted;
- implementation remains blocked until R9 and T1B are accepted/green.

## Revision log (R1)

R1 là append-only repair trên `c8e2834e433fa5cb3118cb613bdf18d0a513c503`; không amend/rebase/force-push và không tạo memo/branch khác. R1 cập nhật current contract theo R9 trên `origin/main@cd934b3541c4f4e4663f23cc5df174497f96935e`:

- Thay dependency/status hiện hành từ R7 sang R9; lịch sử R7/R8 chỉ còn trong R9 source-of-truth, không dùng làm contract hiện hành.
- Khóa đúng bốn field/key `team_id`, `team_code`, `team_display_name`, `team_active`, facts/scoped-facts 15→19; `team_active` server-only, không vào client/drill-down row.
- Khóa route `GET /api/reporting/team-drill-down` tại `src/app/api/reporting/team-drill-down/route.ts`.
- Giữ nguyên `parseReportingFilters` và `ReportingFilters`; chuyển `bucket_key/cursor/limit` sang thin `parseTeamDrillDownRequest` trong reporting server module/sibling.
- Ghi nhận T0 đã chấp nhận `tab=general|team`, default `general`, và team-specific horizontal-bar sibling không generic hóa `RecruiterBarChart`.
- Đóng source normalization: general giữ `source`; team loại `source` rồi authoritative reload trước aggregate/detail; drill-down reject `source`; giữ from/to/project/recruiter/provider/employment.
- Implementation vẫn BLOCKED cho tới khi T0 tích hợp/chấp nhận backend/API T1B; không viết UI, mock API, source, migration, test code hoặc package change trong R1.

R1 content scan phải chứng minh current sections không còn stale R7 contract wording, three-field wording, route chưa chốt hoặc lời hứa giữ `source` cho team report.

Survey deliverable: `docs/handoffs/p3-w06d-s0-dashboard-team-ui-survey.md`.
