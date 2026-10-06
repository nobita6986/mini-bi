# Báo cáo T0 — P3-W07C-R1 (Direct Entry UX: lazy defaults, grid zoom, date text input)

| Thuộc tính | Giá trị |
|---|---|
| Task | P3-W07C-R1 — Direct Entry UX hotfix: lazy activation cho `first_work_date` + `national_id_issued_place`, grid zoom controls, đổi `date_of_birth` / `national_id_issued_at` sang text input DD/MM/YYYY |
| Base | `20b570b` (W07C hotfix `a8a02ce`) — production đang ổn định |
| Branch | `feature/p3-w07c-direct-entry-save-date-lazy-defaults-hotfix` (ahead of `origin/main` +9 commits) |
| Commits T0 | `2d51b00` (grid zoom) · `c5009aa` (date text input) — cùng với 7 commit trước trên branch (lazy defaults + docs tightening) |
| Gate | **Local T0** — synthesis pass, chưa UAT môi trường thật |
| Trạng thái | **READY_FOR_INTEGRATION_REVIEW** |

> T0 này gộp hai R1 follow-up độc lập: (1) grid zoom controls; (2) text-input DD/MM/YYYY cho hai cột ngày.
> Lazy defaults (`a8a02ce` + `20b570b`) đã có HANDOFF riêng — xem `docs/handoffs/p3-w07c-direct-entry-save-date-lazy-defaults-hotfix.md`.

## 1. Phạm vi

| Mục | Trước T0 | Sau T0 |
|---|---|---|
| `first_work_date` mặc định (GMT+7) | Gán ngay khi tạo row (eager); row `default-only` vẫn được ghi nhận non-blank sai | `defaultCells()` rỗng; activation chen default **khi user tương tác** (select row, mở quick editor, mobile details onToggle, edit cell, chọn HRP/Vendor, paste/import); row `default-only` vẫn **blank** (loại khỏi batch) |
| Grid zoom | Không có | `−` / `Đặt lại` / `+`, mức 80/90/100/110/120 (mặc định 100), scale width/height/font qua CSS variables; KHÔNG `transform: scale()` / CSS `zoom` |
| `date_of_birth` editor | Native `<input type="date">` (date picker) | Text input DD/MM/YYYY (`<input type="text" inputMode="numeric" placeholder="DD/MM/YYYY">`); commit `parseDDMMToIso` → ISO YYYY-MM-DD; `first_work_date` giữ date picker theo yêu cầu |
| `national_id_issued_at` editor | Native `<input type="date">` (date picker) | Text input DD/MM/YYYY (như trên) |
| Mobile staged card `<details>` | Native date picker cho 2 cột ngày | Text input DD/MM/YYYY, parse trong `onMobileStagedChange` trước khi lưu |
| Source of truth | ISO YYYY-MM-DD (không đổi) | ISO YYYY-MM-DD (không đổi) — toàn bộ validation, payload, DB, contract giữ nguyên |

## 2. Files (12 changed, +742/-92 kể từ R1 source)

| Nhóm | Đường dẫn | Ghi chú |
|---|---|---|
| Editor mới | `src/components/direct-entry/direct-entry-spreadsheet-grid.tsx` | `CellsDateTextEditor` (text DD/MM/YYYY ↔ ISO), routing `editor: "dateText"`, scale CSS vars cho zoom |
| Mobile staged | `src/components/direct-entry/direct-entry-live.tsx` | 4 input `type=date` → `type=text` (2 cột × 2 sections); `onMobileStagedChange` parse DD/MM/YYYY → ISO |
| Column registry | `src/lib/direct-entry/direct-entry-grid-columns.ts` | Thêm editor type `dateText`; 2 cột chuyển từ `"date"` → `"dateText"`; `first_work_date` giữ `"date"` |
| Pure helper | `src/lib/direct-entry/direct-entry-date-format.ts` | `parseDDMMToIso` (DD/MM/YYYY → ISO, fail-closed cho rỗng/sai/không hợp lệ theo lịch) |
| CSS | `src/components/direct-entry/direct-entry-spreadsheet-grid.module.css` | Zoom controls + font/padding/height tokens |
| Test mới | `src/components/direct-entry/direct-entry-grid-zoom.test.mjs` (289 dòng, 17 test) | routing, scale, accessibility, không phá paste/selection |
| Test mới | `src/components/direct-entry/direct-entry-text-cell-regression.test.mjs` (thêm 3 test `R2-T1..T3`) | dateText routing, mobile staged input type, parse trong `onMobileStagedChange` |
| Test mở rộng | `src/lib/direct-entry/direct-entry-date-format.test.mjs` (thêm 2 test) | `parseDDMMToIso` contract: 6/2026 DD/MM/YYYY chuẩn + 11 case fail-closed |
| Test adjusted | `direct-entry-h08-r1-defaults-text-regression.test.mjs`, `direct-entry-live-lazy-default-entrypoints.test.mjs` | Tăng regex 8000 → 12000 chars trong 2 test (bị phá bởi thêm input line) |
| Manifest | `package.json` | (chỉnh sửa nhỏ từ trước R1) |

## 3. Root cause + Fix

### A. `date_of_birth` và `national_id_issued_at` dùng native date picker
- **Triệu chứng:** Người dùng nhập liệu trên màn hình Direct Entry cảm thấy date picker gốc (chọn ngày qua lịch) chậm và không phù hợp với thao tác gõ tay cho ngày sinh / ngày cấp CCCD (rất phổ biến ở VN, dữ liệu thường đã có trên tay).
- **Yêu cầu:** Chuyển 2 cột này sang text input để gõ DD/MM/YYYY; `first_work_date` giữ nguyên (chọn ngày qua lịch vẫn phù hợp vì là ngày bắt đầu đi làm sắp tới).
- **Fix:**
  - Thêm editor type `"dateText"` vào `DirectEntryGridEditor`; 2 cột chuyển sang `editor: "dateText"`.
  - `CellsDateTextEditor` (mới): mount đọc `row.cells[key]` (ISO) → `formatDateToDDMM` → input; commit `parseDDMMToIso` → ISO truyền `onRowChange`; `userTyped` tracking để hiển thị raw khi đang gõ (không ép format), reset về formatted khi blur. Tránh `setValue` trong `useEffect` (đã được lint `react-hooks/set-state-in-effect` rà soát).
  - Mobile staged card 2 sections: `<input type="date">` → `<input type="text" inputMode="numeric" placeholder="DD/MM/YYYY">` + `value={formatDateToDDMM(iso)}`; `onMobileStagedChange` parse DD/MM/YYYY → ISO trước khi `updateSpreadsheetRowCells` (lưu ý: chỉ 2 cột này; các cột khác giữ nguyên raw path).
  - **Source of truth không đổi:** `row.cells[key]` vẫn là ISO YYYY-MM-DD. Validation `isRealCalendarDate`, payload, DB, migration — không sửa.

### B. Lazy activation cho `first_work_date` + `national_id_issued_place` (đã từ R1 source, T0 tóm tắt)
- **Triệu chứng:** `defaultCells()` gán `first_work_date` (HCM-today) + `national_id_issued_place` ("Bộ Công An") ngay khi tạo row; row "default-only" bị đếm là non-blank → có thể lọt vào save batch, lệch validation.
- **Fix:** `defaultCells()` rỗng; `activateSpreadsheetRowLazyDefaults` chen default **trước** patch khi user tương tác. Activation idempotent; user/paste luôn thắng (patch sau activation). Spreadsheet row model thêm helper `activateSpreadsheetRowLazyDefaults({row, now})` thread `now` để test deterministic.
- **Coverage:** 30 initial rows + 10 batch rows (paste-pad) + import path; row `default-only` vẫn blank (`spreadsheetRowIsBlank` coi 2 default vẫn blank).

### C. Grid zoom controls
- **Triệu chứng:** Màn hình Direct Entry quá rộng trên màn nhỏ, hàng quá cao trên desktop. Không có cơ chế zoom.
- **Fix:** `DIRECT_ENTRY_GRID_ZOOM_LEVELS = [80, 90, 100, 110, 120]`; buttons `−` / `Đặt lại` / `+` ở toolbar (`aria-label` Tiếng Việt, `aria-live="polite"` ở label); `data-testid` đầy đủ. Scale `width` (clamp ≥32px), `rowHeight`, `headerRowHeight`, `font-size`, `padding-x/y` qua CSS variables; KHÔNG dùng `transform: scale()` / CSS `zoom` (gây double-scale với browser zoom và vỡ layout flex/grid). Không mutate cells/selection/paste/save.

## 4. Invariants (anti-regression)

| Nhóm | Bảo toàn |
|---|---|
| Source of truth | `row.cells[key]` luôn là ISO YYYY-MM-DD cho date columns; `formatDateToDDMM` chỉ là closed-cell display + mobile input echo |
| Contract | `workerProfileField(key).canonicalHeader` + `validator = isRealCalendarDate` không đổi |
| Date helper | `new Date(...)` chỉ với `Date.UTC(...)` probe; KHÔNG `new Date("YYYY-MM-DD")` hay `new Date(input)` cho user input (tránh UTC leak) |
| `parseDDMMToIso` | fail-closed: `""`/`null`/`undefined` → `""`; sai format → `""`; ngày không tồn tại theo lịch (30/02, 31/04, 29/02 non-leap) → `""`; separator "/" hoặc "-" |
| Routing | `editor: "date"` (first_work_date, leave_date) vẫn qua `DateCellEditor` (native date picker); `editor: "dateText"` (date_of_birth, national_id_issued_at) qua `cellsDateTextEditor`; `editor: "select"`/`"catalog"` qua `SelectCellEditor`; các editor khác qua `cellsTextEditor` |
| Grid zoom | KHÔNG mutate registry, cells, selection, paste, save; CSS variables là nguồn duy nhất; `Math.max(32, ...)` clamp width |
| Lazy defaults | User/paste patch luôn thắng; idempotent activation; row `default-only` vẫn blank |
| Closed-cell display | `editor: "date" \|\| editor: "dateText"` cùng render `formatDateToDDMM(iso)` |
| IME | `CellsTextEditor` (cells khác) vẫn xử lý Vietnamese composition; `CellsDateTextEditor` không cần (chỉ gõ chữ số + `/`/`-`) |

## 5. Quality gates

| Gate | Kết quả |
|---|---|
| `npm run typecheck` | ✓ pass |
| `npm run lint` | 0 errors, 11 warnings (pre-existing, không liên quan hotfix) |
| `node --test src/components/direct-entry/*.test.mjs` | **220 / 220 pass** |
| `node --test src/components/direct-entry/direct-entry-grid-zoom.test.mjs` | 17 / 17 pass (mới) |
| `node --test src/components/direct-entry/direct-entry-text-cell-regression.test.mjs` | 16 / 16 pass (3 mới `R2-T1..T3`) |
| `node --test src/lib/direct-entry/direct-entry-date-format.test.mjs` | 8 / 8 pass (2 mới cho `parseDDMMToIso`) |
| `node --test src/lib/direct-entry/direct-entry-grid-columns.test.mjs` | 6 / 6 pass |
| `node --test src/lib/direct-entry/spreadsheet-row-model.test.mjs` | 11 / 11 pass |
| Tổng (T0 subset) | **259 / 259 pass** |
| `git diff --check` | exit 0 |

> 3 test trong `src/lib/direct-entry/` (`submission-read-repository`, `submission-transition-repository`, `write-api`) fail vì `server-only` import error — **pre-existing, không liên quan hotfix** (xác nhận bằng `git stash` + chạy lại trên HEAD~0 đều fail cùng nguyên nhân).

## 6. UX/UX copy

- Toolbar zoom: nhãn `−` / `Đặt lại` / `+` với `aria-label` Tiếng Việt (`Thu nhỏ bảng nhập liệu` / `Đặt lại tỷ lệ bảng nhập liệu` / `Phóng to bảng nhập liệu`); % hiển thị `aria-live="polite"`.
- Date text input: `placeholder="DD/MM/YYYY"`, `inputMode="numeric"` (mobile keyboard số), không có format mask tự động (user gõ tự do; commit parse, fail-closed → ISO rỗng).
- Mobile staged card: label "Ngày sinh" / "Ngày cấp" giữ nguyên; chỉ thay đổi input type.

## 7. Rủi ro & giới hạn đã biết

1. **`parseDDMMToIso` fail-closed → ISO rỗng:** nếu user gõ "31/02/2026" thì cell lưu `""`; validation `isRealCalendarDate` sẽ báo lỗi `PASTE_DOB_FUTURE`/`PASTE_ISSUED_BEFORE_DOB` (tùy context); user phải sửa. Không có UX warning riêng cho parse fail ở grid (đã có `data-cell-state` ở error path).
2. **Mobile staged card không có format mask:** user gõ `6/10/2026` (không pad) vẫn parse được (regex `(\d{1,2})/(\d{1,2})/(\d{4})`), nhưng hiển thị sẽ normalize về `06/10/2026` khi blur. Có thể gây "value thay đổi khi blur" nếu user quen gõ không pad. Không blocker.
3. **Grid zoom chưa persistence:** chỉ in-memory state; reload page → về 100%. Theo yêu cầu scope T0.
4. **`first_work_date` vẫn native date picker:** theo yêu cầu (chỉ 2 cột này đổi); nếu sau này muốn đổi thêm cần R2.
5. **CSS variables chỉ trong scope `.spreadsheet`:** zoom không ảnh hưởng action rail / drawer / mobile card.
6. **`react-hooks/set-state-in-effect` lint:** lần đầu viết `CellsDateTextEditor` theo pattern `useEffect` + `setValue` của `CellsTextEditor` thì lint fail. Đã refactor sang `userTyped` tracking (derive value từ `row.cells[key]` qua `formatDateToDDMM`; chỉ set `userTyped` qua `onChange`/`onBlur`). Lint pass.

## 8. Điểm còn mở / chờ review

1. **UAT thực tế:** chưa chạy trên môi trường staging; cần xác nhận:
   - Touch keyboard mobile (iOS/Android) hiển thị đúng keyboard số với `inputMode="numeric"`.
   - Người dùng gõ "06/10/2026" trên mobile có bị auto-pad/format nhiễu không.
   - Grid zoom 80/120 không vỡ action rail (rail nằm ngoài `.spreadsheet`, đã verify bằng CSS scoping, cần xác nhận thị giác).
2. **Review change request text input (nếu có):** `direct-entry-change-request-proposer.tsx` còn dùng `type="date"` cho `date_of_birth` — **T0 không sửa** (yêu cầu chỉ trên màn nhập liệu Direct Entry); nếu muốn đồng bộ cần R2.
3. **Quick editor drawer:** `direct-entry-shell.tsx` cũng có `<input type="date">` cho `firstWorkDate` — không thuộc scope T0.
4. **Persistence zoom:** nếu cần, có thể lưu vào `localStorage` qua 1 task nhỏ (không khuyến nghị cho pilot).
5. **`a11y` cho `CellsDateTextEditor`:** hiện không có `aria-label`; cần thêm nếu screen reader test fail (chưa có screen reader test trong repo).
6. **i18n:** DD/MM/YYYY hard-code; nếu mở rộng sang locale khác cần extract.

## 9. Tóm tắt cho T0

- 2 hotfix UX trên Direct Entry spreadsheet + mobile staged card (text input) và 1 hotfix tiện ích (grid zoom).
- Không chạm contract / payload / DB / migration / validation / save logic.
- Source of truth vẫn ISO YYYY-MM-DD; pure string helper `parseDDMMToIso` fail-closed; editor mới `dateText` song song với `date`.
- 0 lint error, **259 test pass** (gồm 22 test mới), `git diff --check` OK.
- Branch `feature/p3-w07c-direct-entry-save-date-lazy-defaults-hotfix` ahead of `origin/main` +9 commits, sẵn sàng review tích hợp và UAT.
