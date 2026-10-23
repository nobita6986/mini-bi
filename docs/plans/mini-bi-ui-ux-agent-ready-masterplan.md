# MINI BI — MASTER PLAN THỰC THI UI/UX & MOTION (AGENT-READY)

**Phiên bản:** 2.0 — đặc tả giao việc trực tiếp cho Coding Agent  
**Ngày:** 21/10/2026  
**Repository:** `nobita6986/mini-bi` — https://github.com/nobita6986/mini-bi  
**Mốc mã nguồn đã kiểm tra:** `main` tại commit `9eb7228e0cbe815983d6705345e4b0c09cdc7c4b` (21/10/2026).  
**Đường dẫn đề xuất trong repo:** `docs/plans/mini-bi-ui-ux-agent-ready-masterplan.md`  
**Loại tài liệu:** Product specification + technical work order + acceptance criteria + regression checklist.  
**Trạng thái:** Đặc tả triển khai, **chưa** đồng nghĩa mã nguồn đã được sửa.

> **LỆNH GIAO VIỆC:** Coding Agent phải triển khai theo **chính file này**, dùng repo làm nguồn xác minh kỹ thuật. **Không cần, không được yêu cầu lại clip, hình ảnh, ảnh chụp màn hình hoặc truy cập Vessa demo** để hiểu yêu cầu. Các đặc điểm thị giác và hiệu ứng cần triển khai đã được mô tả bằng văn bản và thông số trong file. Nếu repo thay đổi sau commit tham chiếu, kiểm tra đường dẫn mới và ghi lại sai khác; không tự ý đổi yêu cầu sản phẩm.

---

## 0. ĐỌC PHẦN NÀY TRƯỚC KHI CODE — phạm vi đã khóa

### 0.1. Mục tiêu duy nhất

Giữ nguyên Mini BI về **bố cục, thương hiệu, chức năng, số liệu, phân quyền và luồng nghiệp vụ**. Làm cho UI hiện tại **phản hồi nhanh, mượt, hiện đại, đồng nhất**, đặc biệt là:

1. **100% thông báo kết quả thao tác của người dùng ở các route đang hoạt động phải xuất hiện dưới dạng Toast thống nhất**, không lẫn banner thông báo thành công/thất bại trong nội dung trang.
2. **Micro-interactions có mục đích:** hover, press, focus, tab, filter, tooltip, skeleton/loading; thay đổi nhỏ nhưng thấy rõ ngay.
3. **Motion nâng cao có kiểm soát** ở chặng sau: chuyển dữ liệu biểu đồ, KPI, panel, drilldown và tác vụ kéo dài.

**Không phải:** thiết kế lại toàn app, thay header/sidebar, chuyển màu giống một template khác, thêm chức năng BI mới, đổi giao diện spreadsheet, xây notification center kiểu mạng xã hội.

### 0.2. Hai chặng — bắt buộc tách ranh giới

| Chặng | Mục tiêu | Kết quả bắt buộc | Không làm |
|---|---|---|---|
| **Chặng 1 — Quick Wins** | Thay ít, hiệu quả lớn | Toast thống nhất cho action feedback toàn bộ route hoạt động; button/tab/filter/tooltip/loading được polish bằng CSS và component hiện có | DB, API/RPC nghiệp vụ, refactor báo cáo, layout toàn ứng dụng, chart count-up/transition hàng loạt, thư viện animation mới |
| **Chặng 2 — Advanced Interaction** | Nâng tương tác còn lại khi nền tảng đã ổn định | Chart/KPI/panel motion opt-in, tương tác dữ liệu, Toast nâng cao/tác vụ dài, mở rộng các tương tác phù hợp | Motion trang trí liên tục, đếm số giả, Undo giả, progress giả, tăng bundle size không có lý do |

**Ưu tiên 0:** Toast; **ưu tiên 1:** phản hồi button/tab/filter; **ưu tiên 2:** tooltip/loading; **ưu tiên 3:** motion dữ liệu nâng cao.

### 0.3. Những điều KHÔNG ĐƯỢC SỬA

- Không migration; không sửa `supabase/migrations/**`, schema, RLS, SQL RPC, truy vấn phân quyền, hợp đồng API, phép tính BI, dữ liệu/hồ sơ.
- Không thay đổi `all / team / own` audience; giữ quyền server-side cho tab báo cáo CCCD trùng. Không đưa dữ liệu ngoài scope vào DOM trong lúc animate.
- Không can thiệp cơ chế gửi duyệt, xác nhận, idempotency key, `expected_version`, hành vi retry của nghiệp vụ.
- Không sửa `direct-entry` spreadsheet/grid, Excel paste/copy, selection/focus, bàn phím nhập liệu, hoặc animation trên mỗi cell/row.
- Không đổi brand, font, bảng màu và 5 theme hiện hữu. Không tạo một theme “giống Vessa”.
- Không đổi nhãn nghiệp vụ: `UNCONFIRMED` **luôn là “Đang chờ việc”**.
- Không hiển thị CCCD, tài khoản ngân hàng, email nhạy cảm, dữ liệu cá nhân, raw error response, stack trace, token hay id nội bộ dài trong Toast.
- Không phát thông báo thành công trước khi API/DB xác nhận thành công.

### 0.4. Nếu có xung đột kỹ thuật

Thứ tự ưu tiên: **an toàn và phân quyền > đúng nghiệp vụ > a11y/khả năng sử dụng > performance > motion/visual polish**. Nếu một hiệu ứng đòi thay đổi kiến trúc nghiệp vụ hoặc phá keyboard, bỏ hiệu ứng đó, ghi rõ lý do và vẫn hoàn tất các việc độc lập. Không dừng để xin clip/ảnh tham khảo.

---

## 1. “GIAO DIỆN HIỆN ĐẠI” Ở ĐÂY NGHĨA LÀ GÌ? — đặc tả không cần hình ảnh

### 1.1. Ngôn ngữ chuyển động

Giao diện cần tạo cảm giác như một ứng dụng SaaS/B.I. hiện đại: **nhẹ, mềm, chắc chắn, dễ dự đoán**. Animation phải giải thích sự thay đổi trạng thái, không biểu diễn cho đẹp. Chuyển động ngắn, biên độ nhỏ, không rung, không giật, không bật lại/spring quá đà.

**Mô tả chính xác bằng hành vi:**

- Hover nút → màu nền hoặc viền thay đổi từ từ, không nhảy một khung; bóng tăng rất nhẹ nếu thích hợp.
- Nhấn nút → nút co tối đa ~1% trong một nhịp rất ngắn; thả ra về kích thước cũ; disabled và `aria-busy` không co.
- Hover mục điều hướng/tab → màu chữ/nền chuyển mượt, tab được chọn có underline hoặc vùng nền nổi rõ; không đổi chiều cao tab, không đẩy nội dung xuống.
- Bật bộ lọc nâng cao → nội dung hiện bằng fade/reveal ngắn; bố cục không nhảy bất ngờ và trường nhập không được tab đến khi panel ẩn.
- Hover biểu đồ → tooltip nhỏ, bo mềm, nền theo theme, shadow tinh tế, tiêu đề và giá trị dễ đọc; không lag khi rê chuột.
- Mở màn hình → nếu đang tải, placeholder có kích thước gần nội dung thật; khi có dữ liệu không để layout nhảy mạnh.
- Thực hiện thao tác lưu/gửi/duyệt/xuất → **một Toast nổi**, không chèn thêm một thanh xanh/đỏ vào luồng trang.

**Không sao chép:** sidebar thu nhỏ kiểu icon, thanh header nổi, bảng màu nâu/kem, layout Bento mới, biểu đồ kho hàng hay module “Activity / Alerts” không có dữ liệu.

### 1.2. Bảng thông số motion bắt buộc cho Chặng 1

| Tương tác | Duration tiêu chuẩn | Phạm vi animation | Easing | Điều không được làm |
|---|---:|---|---|---|
| Hover button/interactive link | **160 ms** | color, border-color, background-color, shadow | `ease-out` | Không `transition-all` diện rộng |
| Press button | **120 ms** | `transform: scale(0.99)` (nếu phù hợp) | `ease-out` | Không scale disabled/busy/form-sensitive |
| Tab selected/hover | **200 ms** | color, border-color, background-color; indicator nếu chắc chắn không reflow | `ease-out` | Không sửa URL, keyboard behavior |
| Preset filter pill | **180 ms** | color, background-color, border-color | `ease-out` | Không gây nhấp nháy khi reload |
| Advanced filter reveal | **200 ms** | opacity + translateY tối đa 6 px (vùng đã mount) | `ease-out` | Không để input ẩn nằm trong tab order |
| Toast enter | **200 ms** | opacity `0→1`, translateY `-8→0 px` | `cubic-bezier(.22,1,.36,1)` | Không nhảy từ ngoài màn hình xa |
| Toast exit | **160 ms** | opacity `1→0`, translateY `0→-4 px` | `ease-in` | Không xóa ngay trước khi exit kết thúc nếu dùng motion |
| Tooltip | **100–140 ms** nếu animation được phép | opacity tối thiểu, hoặc instant nếu flicker | `ease-out` | Không delay gây khó đọc giá trị |
| Skeleton | Có thể dùng pulse nhẹ theo tính sẵn có | opacity | mặc định | Không pulse với reduced motion |

**Chặng 2 mới áp dụng:** chart **300–400 ms**, KPI **180–300 ms**, panel **180–240 ms**. Giá trị không được animate nếu ảnh hưởng độ chính xác diễn giải.

### 1.3. Chốt lựa chọn kỹ thuật

- Sử dụng **React + Next.js + Tailwind + CSS variables + Radix + Recharts đã có trong repo**.
- **Không thêm Framer Motion/Motion, Sonner hoặc React Hot Toast trong Chặng 1.** Nếu thật sự cần ở Chặng 2 phải kèm bằng chứng không thể đạt UX bằng stack hiện hữu.
- Tổ chức motion bằng CSS classes/tokens dùng chung, không viết timer animation rời rạc ở hàng chục component.
- Default static/ít chuyển động là trạng thái hợp lệ; người dùng không được trả giá bằng lag chỉ để có hiệu ứng.

---

## 2. HIỆN TRẠNG MÃ NGUỒN — dữ kiện đã xác minh

Các đường dẫn dưới đây là **điểm bắt đầu cụ thể**. Agent cần đọc phiên bản hiện tại ở branch đang làm trước khi sửa.

| File | Sự thật trong repo tại commit tham chiếu | Việc agent phải làm |
|---|---|---|
| `src/components/ui/toast.tsx` | Có `FloatingToast` với 4 tone, auto-hide và close; tự tạo Radix Provider trên từng instance, viewport `sr-only`, phần hiển thị chính là `<div>` nổi | Dùng primitives Radix đúng kiến trúc, **một host toàn app**, một API client công khai |
| `src/components/ui/status-banner.tsx` | Có `StatusBanner` inline cho success/info/warning/error | **Không dùng để báo kết quả thao tác**; giữ cho nội dung tồn tại lâu nếu thực sự cần |
| `src/components/ui/alert.tsx` | `Alert` inline dạng info/warning/error | Giữ cho hướng dẫn/cảnh báo bền vững hoặc trạng thái panel; không thay thế Toast thao tác |
| `src/components/direct-entry/change-requests-workspace.tsx` | Quản lý `notice` state; khi duyệt/rút/refresh sau mutation render `<StatusBanner>` ngay phía trên danh sách | Đây là **lỗi UX mẫu phải sửa P0**: thay bằng Toast global, bỏ banner kết quả trong nội dung trang |
| `src/components/direct-entry/direct-entry-change-request-reviewer.tsx` | Có `statusMessage` trong dialog; sau duyệt thành công vừa `setStatusMessage(message)` vừa gọi `onDecided(message)` | Tránh phát thông báo **hai lần**; parent phát Toast cho thành công cuối cùng, child xử lý validation/điều kiện tương ứng |
| `src/components/direct-entry/direct-entry-change-request-proposer.tsx` | `statusMessage` inline cho validation, pending, lỗi gửi | Phân loại: lỗi trường nhập inline; trạng thái bận trên nút; kết quả submit qua Toast ở owner phù hợp |
| `src/components/direct-entry/worker-operations.tsx` | Có `FloatingToast` cho `notice`, song song nhiều `<p role="alert">` / inline message trong drawer/export | Migrate action feedback; giữ field validation & blocking state đúng chức năng |
| `src/components/admin/account-manager.tsx` | Dùng `notice` → `<Alert>` cho kết quả thao tác, ngoài `formError` | Migrate action result sang Toast; không xóa form error |
| `src/components/admin/vendor-catalog-manager.tsx` | Dùng `notice` → `<Alert>` cho kết quả thao tác | Migrate theo cùng policy |
| `src/components/admin/project-team-scope-manager.tsx` | Dùng `<Alert>` cho `notice` kết quả nghiệp vụ | Migrate theo cùng policy |
| `src/components/dashboard/team-entry-detail.tsx` | Lỗi tải thêm đang hiển thị `<Alert>` với nút Retry | Với lỗi **hành động tải thêm khi đã có dữ liệu**, dùng Toast; lỗi toàn vùng không tải được còn error state |
| `src/components/reporting/duplicate-cccd-report-panel.tsx` | Alert “Chỉ xem” + ErrorState khi không có quyền / panel lỗi | Giữ cảnh báo bảo mật và ErrorState; chỉ biến phản hồi reload thành Toast khi thích hợp |
| `src/components/dashboard/bod-dashboard-tabs.tsx` | ARIA tabs, phím mũi tên/Home/End, `nuqs`, `useTransition`, gate quyền tab CCCD | Thêm transition thẩm mỹ, giữ toàn bộ logic tab/URL/access |
| `src/components/dashboard/dashboard-filters.tsx` | Preset pill, advanced filter hiện/ẩn bằng `hidden`, state ở URL | Chỉ polish CSS + reveal an toàn keyboard |
| `src/components/ui/button.tsx` | Button variants, focus-visible, disabled, touch targets | Thêm hover/press nhất quán qua class chung |
| `src/components/ui/card.tsx`, `src/components/dashboard/kpi-card.tsx` | Card/KPI dùng lại nhiều nơi | Chỉ hover-lift với card click được; card read-only không cần hiệu ứng giả nút |
| `src/components/dashboard/chart-tooltip.tsx` | Tooltip custom trong Recharts | Polish font/spacing/shadow/màu, không sửa dữ liệu |
| `src/components/dashboard/trend-chart.tsx`, `recruiter-bar-chart.tsx`, `project-donut.tsx` | `isAnimationActive={false}` | **GIỮ false trong Chặng 1**; Chặng 2 chỉ bật opt-in nếu qua đo đạc |
| `src/app/dashboard/loading.tsx` | Đã có skeleton `animate-pulse` | Điều chỉnh giảm layout shift, tắt pulse dưới reduced-motion |
| `src/app/globals.css`, `src/lib/theme/theme-registry.ts` | 5 theme, light/dark, surface/elevation token, reduced motion cho Recharts | Thêm motion variables/classes **không ghi đè theme** |
| `src/components/app-shell/app-shell.tsx`, `src/app/layout.tsx` | App Shell là Server Component; Root Layout có ThemeProvider | Mount một client Toast Provider trong root boundary, **không convert toàn AppShell thành client** |

**Giới hạn xác minh:** Kiểm tra mã nguồn GitHub, không đăng nhập production hay xác nhận cấu hình deploy. Agent phải kiểm tra diff/các route thực tế của branch triển khai. Bảng trên không thay thế inventory tự động và kiểm tra thủ công ở S1-01.

---

# CHẶNG 1 — QUICK WINS / IMPLEMENTATION ORDERS

## 3. S1-01 — Kiểm kê thông báo, khóa taxonomy (PR 1)

**Mục tiêu:** Có danh sách đầy đủ các nơi đang phát phản hồi thao tác và chốt quyết định chuyển/giữ. Đây là hoạt động bắt buộc dù coding task đầu tiên có ít dòng.

### 3.1. File đầu ra bắt buộc

Tạo `docs/plans/uiux/notification-inventory.md` với tối thiểu các cột:

`route | file/component | event kích hoạt | thông báo hiện nay | class | proposed surface | implementation PR | test case | trạng thái`.

**Không cần clip/ảnh để làm inventory**. Dựa vào code + chạy ứng dụng bằng dữ liệu kiểm thử.

### 3.2. Lệnh rà soát

```bash
rg -n 'FloatingToast|StatusBanner|<Alert|<ErrorState|role=["\x27](alert|status)|aria-live|setNotice|setMessage|setStatusMessage|notice|toast' src --glob '*.tsx' --glob '*.ts'
rg -n 'Đã |thành công|Không thể|Không lưu|Không tải|Thử lại|đã duyệt|đã gửi|đã rút' src/components src/app --glob '*.tsx'
```

Không chuyển đổi hàng loạt dựa vào regex. Mỗi kết quả cần phân loại theo bảng dưới.

### 3.3. TAXONOMY — quy tắc quyết định dứt khoát

| Class | Định nghĩa | Hiển thị bắt buộc | Ví dụ |
|---|---|---|---|
| **ACTION_SUCCESS** | Kết quả thành công của hành động tạo/sửa/duyệt/từ chối/rút/xuất/refresh do người dùng khởi phát | **Toast success** | “Đã duyệt yêu cầu thay đổi ddb57d17.” |
| **ACTION_FAILURE** | Hành động vừa thực hiện thất bại; có thể thử lại / cần biết vì sao | **Toast error/warning** | “Không lưu được thay đổi. Vui lòng thử lại.” |
| **ACTION_CONFLICT** | 409, dữ liệu đã đổi, cần tải lại hoặc thao tác lại | **Toast warning** + tùy luồng giữ warning state trong form nếu cần sửa dữ liệu | “Dữ liệu đã thay đổi. Tải lại trước khi tiếp tục.” |
| **ACTION_PROGRESS** | Bận khi người dùng đang gửi/lưu/xuất | `isPending`/spinner/disabled **trên chính control**; Toast progress chỉ Chặng 2 nếu tác vụ dài | “Đang gửi…” trên nút |
| **FIELD_VALIDATION** | Sai/thiếu giá trị cụ thể trong form | **Inline sát field**, `aria-describedby`/`aria-invalid`, không thay bằng Toast duy nhất | “Lý do tối đa 4000 ký tự.” |
| **FORM_BLOCKING_VALIDATION** | Nhiều lỗi form hoặc lỗi logic cần đọc trước khi submit lại | Summary trong dialog/form + focus về trường lỗi đầu tiên; tùy chọn Toast bổ sung chỉ nếu không trùng thông điệp | Thiếu trường bắt buộc |
| **EMPTY_STATE** | Không có kết quả, không có yêu cầu chờ duyệt | **Inline empty state** trong vùng dữ liệu, không Toast | “Chưa có yêu cầu nào đang chờ bạn duyệt.” |
| **LOADING_STATE** | Đang tải nội dung tự động | Skeleton/loading đúng vùng, không Toast | “Đang tải báo cáo…” |
| **BLOCKING_PAGE_ERROR** | Trang/panel không thể hiển thị nội dung, 403/không có kết nối khi load đầu tiên | **Inline ErrorState** + Retry/hướng khắc phục; nếu lỗi phát sinh từ thao tác reload có thể thêm Toast chỉ khi không gây thông báo lặp vô ích | “Không tải được báo cáo.” |
| **PERSISTENT_POLICY** | Quy định, phạm vi quyền, cảnh báo an toàn, mô tả cần luôn nhìn thấy | **Inline Alert/note** đúng vị trí | “Báo cáo CCCD trùng chỉ để xem.” |
| **INLINE_DATA_HINT** | Thống kê, caption, tiến độ trang, hướng dẫn ở chỗ sử dụng | Inline text, không Toast | “Đã hiển thị hết kết quả.” |

**Nguyên tắc quan trọng:** “Tất cả thông báo đều là Toast” được hiểu đúng là **tất cả thông báo KẾT QUẢ CỦA THAO TÁC**. Không được chuyển empty state, validation của từng ô, cảnh báo bảo mật cần lưu lâu, hoặc trạng thái truy cập bị chặn thành Toast tự ẩn 4 giây. Điều đó sẽ làm UX tệ hơn và có thể gây lỗi nghiệp vụ.

### 3.4. Routes phải kiểm kê

- `/dashboard` (BoD, Team, Own, các tab), kể cả tab CCCD có quyền.
- `/direct-entry/**`: nhập liệu, người lao động, yêu cầu thay đổi, dự án và mọi UI action hiện hoạt.
- `/admin/**`: tài khoản, nhân sự, nhóm, nhà cung cấp, loại hình, phân quyền dự án/nhóm, các trang hiện hoạt.
- `/work-reports/**` và những module mới nếu branch triển khai đã bật route tương ứng.
- Auth/session actions nếu có thông báo thao tác (đăng nhập/đổi mật khẩu/đăng xuất).

Không cần migrate API error response (server trả contract như cũ); chỉ thay **presentation** của feedback trong client.

**DoD S1-01:** inventory có trạng thái `migrate / keep-with-reason` cho mọi action-feedback đang hoạt động; các exceptions đều có giải thích. Có thể giao các PR module độc lập từ inventory này.

---

## 4. S1-02 — Một Toast System thống nhất cho toàn ứng dụng (PR 2)

### 4.1. Files chỉ định

- **Thêm:** `src/components/ui/notify-provider.tsx` (client component; Provider + hook `useNotify` + Viewport/host).
- **Chỉnh:** `src/components/ui/toast.tsx` (presentation item/adapter tương thích tạm, không giữ Provider/Viewport lồng ở từng Toast).
- **Chỉnh:** `src/app/layout.tsx` để mount `NotifyProvider` **một lần** dưới `ThemeProvider`, bọc các route client hiện có. Root layout vẫn là Server Component.
- **Thêm:** tests cho provider + lifecycle (tên file phù hợp test runner hiện hành, ví dụ `src/components/ui/notify-provider.test.mjs`).
- **Không:** tạo 2/3 Toast hosts theo Dashboard/Direct Entry/Admin layout.

### 4.2. Hợp đồng API client — PHẢI có cách gọi tương đương

```ts
// Đề xuất chuẩn, agent có thể tách types ra module nhỏ nếu thuận lợi,
// nhưng không được tạo nhiều cách gọi public khác nhau.
export type NotifyTone = "success" | "info" | "warning" | "error";

export type NotifyOptions = {
  title: string;                   // required, plain-text, an toàn thông tin
  description?: string;           // optional
  dedupeKey?: string;             // chống thông báo lặp cho cùng event
  durationMs?: number | null;     // null = persistent
  action?: {
    label: string;
    onClick: () => void;          // chỉ khi action thực sự an toàn/khả dụng
  };
};

export type NotifyApi = {
  success: (options: NotifyOptions) => string;
  info: (options: NotifyOptions) => string;
  warning: (options: NotifyOptions) => string;
  error: (options: NotifyOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

export function useNotify(): NotifyApi;
export function NotifyProvider(props: { children: React.ReactNode }): JSX.Element;
```

**Usage chuẩn:**

```tsx
const notify = useNotify();

// CHỈ sau HTTP 2xx + response đã được contract-validate:
notify.success({
  title: `Đã duyệt yêu cầu thay đổi ${shortRef(requestId)}.`,
  dedupeKey: `change-request-approved:${requestId}:${version}`,
});

// Với 409:
notify.warning({
  title: "Dữ liệu đã thay đổi",
  description: "Tải lại danh sách trước khi thử lại.",
  dedupeKey: `change-request-conflict:${requestId}`,
});

// Lỗi mạng/server chưa thành công:
notify.error({
  title: "Không xử lý được yêu cầu",
  description: "Vui lòng thử lại.",
  dedupeKey: `change-request-error:${requestId}`,
});
```

Agent được phép thay `JSX.Element` bằng `ReactElement` hoặc kiểu tương đương theo phiên bản TypeScript/React trong repo; API và hành vi mới là contract bắt buộc.

### 4.3. UX contract Toast — bắt buộc, không tự quyết khác

| Thuộc tính | Yêu cầu |
|---|---|
| Tone | `success`, `info`, `warning`, `error` |
| Vị trí Desktop | **Góc trên bên phải, ngay bên dưới sticky header**, `right` khoảng 16 px, rộng tối đa 400–440 px; `z-index` lớn hơn nội dung nhưng xét layering với Radix Dialog; không che menu/nút quan trọng |
| Vị trí Mobile | **Gần phía trên và trong safe-area**, căn giữa theo chiều ngang, margin 12 px, không tràn viewport 320 px, không bị bàn phím che; khi header có chiều cao thay đổi cần tính offset phù hợp |
| Hình thức | `bg-surface`, `text-foreground`, border `border`, bo `12–14 px`, shadow mềm, vạch màu semantic bên trái rộng ~4 px; **không đổi bảng màu của 5 theme** |
| Success timeout | **4000 ms** |
| Info timeout | **5000 ms** |
| Warning timeout | **7000 ms** theo mặc định; nếu cần user action quan trọng thì persistent |
| Error timeout | **Persistent (`null`)** mặc định cho lỗi cần xử lý; luôn có nút đóng |
| Tối đa hiển thị | **3 Toast** cùng lúc; phần còn lại nằm trong hàng đợi hữu hạn; không xếp đè nhau |
| Duplicate | Cùng `dedupeKey` trong thời gian hiển thị/queue thì cập nhật/thay thế, **không tạo item thứ hai** |
| Action | Nút nhỏ tùy chọn `Thử lại`/`Mở yêu cầu thay đổi`; không dẫn sai quyền, không click tự động, không CTA không thể dùng khi dialog modal còn khóa focus |
| Dismiss | Có nút đóng, accessible name `Đóng thông báo` |
| Focus | Không tự chiếm focus khi xuất hiện; không làm mất focus input/textarea hoặc selection hiện tại |
| A11y | Thành công/info dùng live-region `polite`; warning/error quan trọng dùng `assertive` phù hợp; **một thông báo không được bị screen reader đọc hai lần** |
| Motion | Fade + translate nhỏ đúng bảng §1.2; khi reduced-motion => không translate và bỏ transition |
| Thời điểm fire | Sau kết quả thật của hành động, không khi button vừa click |
| Vòng đời | Toast không mất khi component con unmount sau một tab/route trong app; không lộ thông báo của session cũ khi logout/đổi account |
| Bảo mật | Chỉ chuỗi được chuẩn hóa, không render HTML/raw response/PII; nếu cần reference dùng `shortRef` đã có |

**Lưu ý Radix:** `FloatingToast` hiện import `Toast as RadixToast` nhưng viewport lại `sr-only` và card thực tế là div ngoài primitive toast. **Không coi đây là full Radix Toast**. S1-02 phải triển khai host đúng theo primitives đã có hoặc một giải pháp React/CSS tương đương có test chứng minh full lifecycle. Không giữ provider/viewport tách rời trong từng usage.

### 4.4. Thiết kế hàng đợi, lifecycle, retry

1. Toast được định danh `id` ổn định (UUID hoặc counter nội bộ, không dùng event PII), lưu `createdAt` và tone; trong cùng vòng render không sinh hai item cho một `dedupeKey`.
2. `dismiss(id)`/timeout phải loại item đúng, không đóng Toast mới do callback cũ.
3. Timer được cleanup khi unmount/dismiss/replace; Strict Mode rerender không làm đúp.
4. Toast thứ tư vào hàng đợi, chỉ hiện khi có chỗ; giới hạn queue không được gây tràn bộ nhớ khi xảy ra lỗi hàng loạt. Nếu cần quy tắc: giữ **tối đa 20 pending**, gộp duplicates, ưu tiên error/warning khi quá giới hạn.
5. `onClick` action callback chạy **một lần** sau click, không tự replay HTTP request ngoài ý muốn. Retry nghiệp vụ phải bảo toàn idempotency contract đang có.
6. Error persistent phải còn đến khi người dùng đóng hoặc điều hướng rời ứng dụng/đổi session; không để lại stale error sau logout.
7. Với dialog đang mở, Toast phải thấy được và thông điệp đọc được bằng trợ năng; **không** đặt CTA chỉ có thể focus bên ngoài một modal đang trap focus. Có thể giữ Retry trên button trong dialog thay vì CTA Toast.
8. Nếu callback `notify.*` gọi trước `onOpenChange(false)` rồi child unmount, Toast vẫn phải hiện bởi Provider ở cấp gốc.

### 4.5. Tiêu chí test bắt buộc

- Render 4 tone; tự ẩn đúng duration; error không tự ẩn; close hoạt động.
- `dedupeKey` giống nhau → đúng 1 Toast; key khác nhau → hiện nhiều.
- 4 sự kiện đồng thời → tối đa 3 Toast visible, sự kiện còn lại vào queue.
- Unmount child, đổi Dashboard tab/route nhưng Provider còn → Toast không biến mất bất ngờ.
- Logout hoặc đổi actor → clear Toast; không tồn tại nội dung của session cũ.
- Reduced motion → không transform animation; keyboard/tab/screen reader không bị focus steal/đọc lặp.
- Desktop/mobile 320px, light/dark, 5 theme; Radix Dialog/drawer không che mất feedback.

**DoD S1-02:** Một hook API, một host, một notification style, test qua. Existing call-site chưa migrate có thể tạm qua adapter; **không được xóa phản hồi cũ trước khi có đường thay thế**.

---

## 5. S1-03 — Sửa đúng vấn đề banner xanh tại “Yêu cầu thay đổi” (PR 3, P0)

### 5.1. Mô tả tình huống chuẩn KHÔNG CẦN ẢNH

Route: `/direct-entry/change-requests`. Khi người có quyền **duyệt** một yêu cầu, trang đang hiển thị một **thanh thông báo màu xanh chiếm chiều ngang nội dung**, nằm trên vùng danh sách/tab, với nội dung ví dụ:

> `Đã duyệt yêu cầu thay đổi ddb57d17.`

Thanh này đẩy nội dung trang xuống và không biến mất theo trải nghiệm Toast thống nhất. **Đây là bug UX phải xóa**. Kết quả mong muốn: sau khi duyệt thành công, **không còn thanh xanh inline**, chỉ có **một Toast success nổi góc trên bên phải** theo §4.3, tự biến mất sau 4 giây. Trang/danh sách cập nhật bình thường, không đổi scroll hoặc kéo giãn layout bởi thông báo.

### 5.2. Thực hiện chi tiết

**File A — `src/components/direct-entry/change-requests-workspace.tsx`**

- Hiện đang khai báo `const [notice, setNotice] = useState<{ tone: StatusBannerTone; text: string } | null>(null);` và JSX `<StatusBanner dataTestId="change-request-workspace-notice">...`.
- **Thay `notice` action-feedback bằng `useNotify()`**. Không render `StatusBanner` cho các kết quả duyệt/từ chối/rút/refresh/mutation lỗi.
- Đúng một lời gọi `notify.success/warning/error` cho mỗi kết quả đã xác nhận; giữ nguyên `loadChangeRequests("replace")`, `intentKeys`, scope/permissions, API URLs và `busyRequestId`.
- Nếu `reloadAfterChangeRequestMutation(message, tone)` được gọi từ child, chuyển việc phát Toast vào **đúng một owner** (workspace/parent). Không phát Toast lần nữa trong child cho cùng event.
- Thông báo rút yêu cầu `Đã rút yêu cầu ${shortRef(...)}.` cũng thành success Toast.
- 409 → warning Toast + tải lại nếu flow hiện có đang thực hiện như vậy; không biến conflict thành success.
- 401/403 → error Toast nếu phát sinh từ thao tác; server gate/permissions vẫn giữ nguyên.
- Không Toast khi danh sách đơn thuần đang loading, rỗng, hoặc hiển thị các tab lịch sử.

**File B — `src/components/direct-entry/direct-entry-change-request-reviewer.tsx`**

- Sau khi duyệt/từ chối thành công, hiện flow có cả `setStatusMessage(message)` lẫn `onDecided(message)` rồi đóng dialog. Chỉ để **parent fire một success Toast**; bỏ thông báo kết quả duplicate ở dialog.
- Validation tại `reason` hoặc điều kiện nhập vẫn hiển thị gần trường/đúng dialog; lỗi request không gắn vào field chuyển sang Toast theo owner rõ ràng. Không ẩn lỗi trước khi người dùng nhìn thấy.
- Không tự đóng dialog khi API fail. Không phát success khi 2xx nhưng response không qua projection/contract validation.
- Nếu `onConflict(...)` được gọi, parent nhận warning **một lần**; reset/reload token giữ nguyên.

**File C — `src/components/direct-entry/direct-entry-change-request-proposer.tsx`**

- Với tạo yêu cầu mới, kết quả gửi thành công đi qua callback `onCreated` tới owner phát Toast; child không phát thêm success trùng.
- `Đang gửi…` chỉ là trạng thái nút/pending, **không mở success/info Toast**.
- Lỗi validation trường `reason` tối đa 4000 ký tự vẫn inline. Lỗi HTTP/network khi đã submit sử dụng Toast; dialog giữ input để sửa/thử lại.

**File D — `src/components/ui/status-banner.tsx`**

- **Không xóa component** vì module khác có thể dùng cho hướng dẫn cố định. Không tự đổi toàn bộ `<StatusBanner>` thành Toast bằng search-replace.
- Sau PR, `change-requests-workspace.tsx` không còn sử dụng `StatusBanner` cho action result.

### 5.3. Copy chuẩn cho các sự kiện

| Event | Tone | Chuỗi bắt buộc / mẫu nội dung | Auto-hide |
|---|---|---|---|
| Duyệt thành công | success | `Đã duyệt yêu cầu thay đổi {shortRef}.` | 4 s |
| Từ chối thành công | success | `Đã từ chối yêu cầu thay đổi {shortRef}.` (thành công thao tác, không phải error) | 4 s |
| Rút yêu cầu thành công | success | `Đã rút yêu cầu {shortRef}.` | 4 s |
| Yêu cầu tạo thành công | success | `Đã gửi yêu cầu thay đổi {shortRef}.` nếu ref đã được xác nhận | 4 s |
| Phiên bản xung đột (409) | warning | `Dữ liệu đã thay đổi. Tải lại trước khi tiếp tục.` | 7 s |
| Không có quyền khi mutation (401/403) | error | `Bạn không còn quyền thực hiện thao tác này.` | persistent |
| Lỗi mạng/5xx hoặc phản hồi không hợp lệ | error | `Không xử lý được yêu cầu. Vui lòng thử lại.` | persistent |
| Không có yêu cầu chờ duyệt | **không Toast** | Giữ empty state trong danh sách | — |
| Đang tải danh sách | **không Toast** | Giữ trạng thái loading vùng danh sách | — |

**Không buộc code viết lại toàn bộ wording từ thư viện nghiệp vụ** nếu thông điệp cũ đã đúng hơn; tuy nhiên UX/tone/time/không lặp như trên là chuẩn. Các ref phải ngắn và không làm lộ PII.

### 5.4. Acceptance tests dạng Given / When / Then

1. **Given** đang xem tab “Chờ tôi duyệt”; **when** approve trả response hợp lệ; **then** chỉ 1 Toast success, không có inline success banner, danh sách reload, dialog đóng.
2. **Given** response thành công cho reject; **when** từ chối; **then** tone **success**, không dùng tone error vì tên hành động “từ chối”.
3. **Given** mutation trả 409; **when** xử lý; **then** warning Toast, không đổi kết quả thành công, flow conflict/reload nguyên vẹn.
4. **Given** server trả 500; **when** xử lý; **then** persistent error Toast, dialog giữ dữ liệu và cho phép thử lại đúng quy tắc idempotency hiện có.
5. **Given** đang mở dialog; **when** thất bại; **then** notification nhìn thấy/đọc được và không mất giá trị lý do.
6. **Given** không có yêu cầu đang chờ; **when** mở tab; **then** chỉ có empty state, không có Toast.
7. **Given** approve xong và dialog unmount; **when** Toast được hiển thị; **then** Toast vẫn tồn tại đủ 4 giây, không flicker/nhân đôi.
8. **Given** người dùng bấm liên tiếp; **when** request vẫn busy; **then** không double-submit/double-notify.

**DoD S1-03:** Chính tình huống thanh xanh nêu trên đã biến thành Toast duy nhất, không đổi nghiệp vụ, test liên quan qua.

---

## 6. S1-04 — Chuẩn hóa action-feedback trên CÁC MODULE CÒN LẠI (PR 4.x, P0)

**Mục tiêu:** Hoàn tất lời hứa “mọi thông báo kết quả thao tác dùng Toast” ở tất cả route đang hoạt động, **không chỉ màn hình minh họa**. Chia PR theo module nhỏ; mỗi PR có inventory diff và test.

### 6.1. Danh sách bắt đầu bắt buộc, không phải danh sách kết thúc

| Nhóm PR | Module/file đích | Công việc |
|---|---|---|
| **S1-04A** | `src/components/direct-entry/worker-operations.tsx` | Migrate `FloatingToast` cục bộ và action messages inline cho lưu chỉnh sửa, đề xuất, xuất dữ liệu, conflict, refresh. Giữ field errors gần trường; giữ blocking error với Retry tại vùng nội dung. |
| **S1-04B** | `src/components/admin/account-manager.tsx` | `notice` result trong `<Alert>` → Toast; login/account ops không lộ user PII/raw response; lỗi nhập lý do ở form vẫn inline. |
| **S1-04C** | `src/components/admin/vendor-catalog-manager.tsx`, `project-team-scope-manager.tsx` | Lưu/disable/reload/conflict → Toast; giữ `ConflictReload` hoặc blocking state nếu dữ liệu đã stale. |
| **S1-04D** | Các manager còn lại trong `src/components/admin/**` | Migrate dựa trên inventory, kể cả personnel/team/leader/labor-type/scope actions đang hoạt động. |
| **S1-04E** | `src/components/dashboard/team-entry-detail.tsx`, `src/components/reporting/duplicate-cccd-report-panel.tsx` | Lỗi “Tải thêm” khi rows đã có → Toast + Retry; lỗi reload theo hành động → Toast; giữ panel ErrorState/notice quyền. |
| **S1-04F** | `src/components/direct-entry/**`, `/work-reports/**`, auth và mọi route khác từ inventory | Không bỏ sót action feedback chỉ vì chưa liệt kê; mỗi exception có lý do trong inventory. |

### 6.2. Bộ quy tắc migration cụ thể

- Dùng `useNotify` từ một public API duy nhất. **Không thêm `useState<notice>` + `<FloatingToast>` ở module mới.**
- Khi thành công: gọi `notify.success` **sau** xác nhận response và projection hợp lệ, giữ refresh/revalidate như cũ.
- Khi thất bại: `notify.error` hoặc warning cho 409, không xóa dữ liệu form, không âm thầm đóng modal, không tự retry hành động nguy hiểm.
- Nếu lỗi xảy ra trong dialog: toast chỉ là feedback; sửa lỗi field ở chính field, retry ở chính dialog nếu cần. Tránh CTA Toast không thể truy cập do focus trap.
- Nếu đã có data nhưng “Tải thêm” thất bại: giữ các hàng cũ và scroll position; toast báo lỗi, control Retry vẫn hoạt động theo cursor.
- Nếu toàn panel không dùng được: giữ ErrorState; đừng buộc người dùng đọc Toast 4 giây rồi nhìn màn hình trống.
- Alert là policy/cảnh báo bền vững chỉ được giữ với lời giải thích trong inventory.
- Khi logout: clear Toast và không giữ nội dung qua tài khoản khác.
- `data-testid` nếu test hiện tại dựa vào inline notice phải **được cập nhật một cách rõ ràng**, không giữ DOM banner ẩn chỉ để qua test.

### 6.3. Definition of Done riêng cho S1-04

- Inventory không còn dòng `ACTION_SUCCESS/ACTION_FAILURE/ACTION_CONFLICT` có trạng thái `not migrated` trên **route hoạt động**.
- Không còn **result banner inline** của hành động lưu/gửi/duyệt/rút/xuất/xóa/refresh trên các route đó.
- Không mất cảnh báo chính sách/validation/lỗi chặn trang.
- PR notes liệt kê toàn bộ chỗ đã sửa và danh sách ngoại lệ giữ lại với lý do.

**Nếu còn tác vụ bị chặn kỹ thuật:** Không tuyên bố Chặng 1 hoàn thành, không dùng câu “100% Toast toàn app” trong release notes. Nêu chính xác route/event còn sót.

---

## 7. S1-05 — Nút, tab, điều hướng hiện hữu (PR 5)

### 7.1. Button

**File chính:** `src/components/ui/button.tsx`; chỉ những button tự style khác cần điều chỉnh để đạt cùng hành vi.

**Yêu cầu:**

- `hover`: thay màu/viền/shadow theo token trong **160ms**.
- `active`: scale `0.99` trong **120ms** chỉ với nút tương tác phù hợp; không dịch vị trí lân cận.
- `focus-visible`: ring rõ, không bị animation che/mờ, dùng CSS token hiện tại.
- `disabled`/`aria-busy`: không nhúc nhích khi hover/press; loại double-submit theo state vốn có.
- Giữ touch target tối thiểu **44×44 px trên mobile**.
- Không thay đổi variant màu, kích thước chuẩn hoặc markup để “đẹp hơn” nếu không cần.

### 7.2. Tabs

**File chính:** `src/components/dashboard/bod-dashboard-tabs.tsx` và các tab ở module người lao động/yêu cầu thay đổi nếu chúng dùng class riêng.

- Underline/background của active tab đổi màu trong **200ms**; không thay đổi line-height/border width động dẫn đến layout shift.
- Không thay `useQueryStates`, `history: "push"`, `shallow`, `source` filter hoặc `needsAuthoritativeReload`.
- Giữ `role="tab"`, `aria-selected`, `aria-controls`, `tabIndex`, ArrowLeft/Right, Home, End và focus target.
- Tab không có quyền **không render** như hiện tại; không mount ẩn tab nhạy cảm rồi animate.
- **Chặng 1 không làm cross-fade cả panel/route.** Chỉ polish trạng thái của nút tab.

### 7.3. Navigation

- Cải thiện hover/focus/active của **menu hiện hữu** ở `src/components/app-shell/desktop-nav.tsx`, `mobile-nav.tsx` chỉ nếu có lợi và không phá menu.
- Không thêm sidebar, không di chuyển vị trí header/logo, không thay cấu trúc nav registry/quyền.

**DoD S1-05:** Nút/tab feel mượt nhưng layout và phím tắt y như trước; không animation trên card KPI chỉ đọc hoặc bảng grid.

---

## 8. S1-06 — Filter và chart tooltip (PR 6)

### 8.1. Filter pills

**File:** `src/components/dashboard/dashboard-filters.tsx`.

- Selected/unselected hover chuyển màu trong **180ms**.
- Preset click: trạng thái chọn cập nhật đúng `nuqs` URL và server filter hiện có; không Toast “đã lọc” mỗi lần đổi kỳ.
- Nút “Xóa bộ lọc” giữ nguyên logic xóa; phản hồi pending nếu server đang refresh là đủ.
- Nếu animation của advanced panel khiến nội dung ẩn còn focusable, **bỏ motion đóng** và dùng `hidden` an toàn; có thể chỉ fade/reveal nhẹ lúc mở.

### 8.2. Tooltip biểu đồ

**Files:** `src/components/dashboard/chart-tooltip.tsx`, `project-donut.tsx`, có thể các tooltip chart khác qua inventory.

**Giao diện mục tiêu:** tooltip nền `var(--tooltip)` / surface theo theme; bo `10–12 px`; viền 1px nhẹ; shadow mềm; title font weight semibold, text-sm; hàng giá trị canh phải, số tabular; màu series bằng dot kích thước nhỏ. Không thêm graph library.

- Tooltip xuất hiện nhanh khi hover; không rung/nảy, không tràn/clip ở màn hình nhỏ.
- Không thay công thức/data key, không đổi màu series từ mapping hiện tại.
- Không bật `isAnimationActive` trong Chặng 1; đây là **hover polish**, không phải chart data animation.

**DoD S1-06:** chart đọc dễ hơn; filter mượt; URL/data không sai khác; reduced-motion an toàn.

---

## 9. S1-07 — Loading, skeleton, empty/error feedback (PR 7)

**Files:** `src/app/dashboard/loading.tsx`, các page/panel async nhiều tương tác và `src/components/reporting/*` khi cần.

- Giữ skeleton đang có, điều chỉnh kích thước cho gần chiều cao header/KPI/chart thực tế, hạn chế layout shift.
- Skeleton có thể pulse như hiện tại với motion bình thường; **tắt pulse khi `prefers-reduced-motion: reduce`**.
- Khi tải thêm, giữ dữ liệu cũ và hiện trạng thái busy gần nút/panel thay vì che toàn trang.
- Loading/empty/error state là **trạng thái nội dung**, không phát Toast vô cớ khi mount.
- Nếu người dùng chủ động bấm Retry và Retry thất bại, phát Toast theo taxonomy; vẫn giữ ErrorState khi panel chưa thể dùng.
- Không tạo spinner delay giả / thời gian chờ tối thiểu để khoe hiệu ứng.

**DoD S1-07:** Người dùng thấy hệ thống đang làm gì; không còn khu vực nhảy chiều cao mạnh; không đánh mất dữ liệu cũ khi lỗi tải thêm.

---

## 10. S1-08 — Motion tokens, accessibility, performance gate (PR 8 / release gate)

### 10.1. CSS tokens tối thiểu

**File:** `src/app/globals.css` (hoặc module motion nhỏ được import duy nhất). Thêm các token dưới đây nhưng **không ghi đè theme registry**:

```css
:root {
  --ui-motion-fast: 120ms;
  --ui-motion-hover: 160ms;
  --ui-motion-tab: 200ms;
  --ui-motion-reveal: 200ms;
  --ui-motion-toast-in: 200ms;
  --ui-motion-toast-out: 160ms;
  --ui-motion-ease: cubic-bezier(0.22, 1, 0.36, 1);
}

@media (prefers-reduced-motion: reduce) {
  /* Apply only to newly introduced animation classes/primitives.
     Keep critical focus indicators and semantics visible. */
}
```

Nếu đã có các token tương đương trong branch mới, **tái sử dụng, không nhân đôi**.

### 10.2. Quy tắc motion

- Animate chủ yếu `opacity`, `transform`, `color`, `background-color`, `border-color`, `box-shadow`; ưu tiên compositor-friendly.
- Không dùng `transition-all` ở bảng lớn, root app, chart containers, spreadsheet/grid.
- Không kéo dài tương tác chỉ để motion kết thúc; sự kiện click/filter phải phản hồi ngay.
- Không để element ẩn tương tác được bằng keyboard; không chiếm focus bằng Toast.
- Không chỉ dựa màu sắc để truyền trạng thái; icon/text và `aria-*` vẫn đúng.
- Reduced-motion phải tắt **mọi animation mới** ở Chặng 1, kể cả Toast/tab/filter, không chỉ chart.

### 10.3. Coverage phải kiểm tra

**Thiết bị/viewport:** desktop 1440px, tablet 768px, mobile 375px và 320px.  
**Theme:** `hr-partner`, `ocean-trust`, `emerald-growth`, `violet-future`, `executive-gold`, sáng/tối.  
**Tương tác:** mouse, touch, keyboard-only; `prefers-reduced-motion` normal/reduce.  
**Quyền:** BoD / Team / Own / không có quyền, các tab có gate quyền.  
**Các case nhạy cảm:** Radix dialog đang mở, submit thất bại, reload 409, logout, thay đổi query, pagination, mobile keyboard.

**Không được ghi là đã test 5×2×4×... nếu chỉ chạy một cấu hình.** Ghi environment và những trường hợp chưa thể test thực tế.

---

# CHẶNG 2 — ADVANCED INTERACTION / IMPLEMENTATION ORDERS

Chỉ mở Chặng 2 khi **Chặng 1 được nghiệm thu** và không còn action-feedback inline chưa xử lý trên route active.

## 11. Backlog Chặng 2 — từ dễ đến khó

| ID | Hạng mục | File/module khởi điểm | Hợp đồng triển khai | Độ khó |
|---|---|---|---|---|
| **S2-01** | Animate thay đổi **chart data** có chọn lọc | `trend-chart.tsx`, `recruiter-bar-chart.tsx`, `project-donut.tsx` | Opt-in từng chart, 300–400 ms, chỉ animate khi data thật đổi, reduce-motion/static fallback, không mismatch tooltip/axis | Trung bình |
| **S2-02** | KPI transition số | `kpi-card.tsx` và các view gọi nó | Chỉ khi có response mới hợp lệ; 180–300 ms; giữ định dạng `vi-VN`; không chạy count-up từ 0 vô cớ | Trung bình |
| **S2-03** | Panel/dialog entrance-exit tinh tế | `bod-dashboard-tabs.tsx`, modal/drawer module phù hợp | Fade/slide tối đa 6 px, 180–240 ms; không giữ panel nhạy cảm trái quyền trong DOM, không mất focus | Trung bình |
| **S2-04** | Tương tác BI cross-highlight/drilldown | BI chart/table được phép | Hover tương ứng giữa chart/table; click chỉ khi có hành động thật; scope filter server-authoritative | Trung bình–khó |
| **S2-05** | Toast nâng cao | `notify-provider.tsx` | Update theo lifecycle, group burst, CTA retry, optional Undo **chỉ nếu backend có Undo**, không ghi notification history chứa PII | Trung bình–khó |
| **S2-06** | Feedback tác vụ kéo dài | export/upload/submit module thực tế | Pending → success/error theo tiến độ API có thật; nếu không có % dùng indeterminate, không fake 100% | Khó |
| **S2-07** | Mở rộng micro-motion có chọn lọc | admin, worker drawer, form, route phụ | Dựa trên component shared; không rewrite form/grid; kiểm tra interaction regression | Khó |
| **S2-08** | Perf & motion governance | tests, docs, app monitoring | Baseline/before-after, INP/CLS nếu đo được, duy trì policy | Khó |

### S2-01 — Chart: điều kiện được bật animation

- Ở Chặng 1 Recharts cố ý static; muốn bật ở Chặng 2 cần xác nhận bằng test thực tế.
- Chỉ animate trên **dataset mới đã được server xác nhận**. Khi đổi theme, resize, tab, mount lại không vẽ giả từ 0.
- Dataset lớn hay thao tác filter liên tiếp thì bỏ qua animation, đảm bảo biểu đồ phản ánh số mới sớm nhất.
- `isAnimationActive` điều kiện theo reduced-motion và actual change; không hardcode `true` cho mọi chart.
- Tooltip/axes/labels không trễ sang kết quả cũ giữa transition; nêu rõ cách xử lý trong PR.

### S2-02 — KPI: đúng số hơn hiệu ứng

- Không animate chữ `—`, `N/A`, loading, error, giá trị không hợp lệ.
- Với 1.248, dùng `1.248` theo `vi-VN` ở frame kết thúc. Không nhảy thành số âm/chữ số thập phân sai.
- Không đếm liên tục khi tab remount hay theme toggle; khi reduced-motion hiển thị trực tiếp số cuối.
- Nếu hoạt ảnh số gây hiểu nhầm tại BoD thì cho phép default-off; nêu lý do đo đạc.

### S2-03 — Panel

- Có thể animate panel vào sau khi được phép hiển thị; không render cả `all/team/own` ngoài authority để phục vụ crossfade.
- Dialog đóng/mở phải tuân `Escape`, `onOpenChange`, focus return và trap focus của Radix.
- Với tab URL history, Back/Forward hiển thị đúng panel ngay cả khi animation bị hủy.

### S2-04 — BI interaction

- Không tự động lọc toàn trang khi hover; hover chỉ highlight, click mới là thao tác dữ liệu nếu đã thiết kế.
- Cross-highlight có fallback keyboard/touch; điểm dữ liệu hiện rõ trong tooltip/legend/table.
- Drilldown giữ server guard; không được coi hidden UI là quyền truy cập.

### S2-05 — Toast advanced

- Chỉ thêm trạng thái `loading → success/error` trên cùng Toast khi có luồng thực sự cần; vẫn cho phép pending trên button.
- `Undo` **chỉ** khi có backend/API undo thực sự và quyền đúng, không làm nút giả.
- Dedupe burst theo business operation; không gộp hai hành động khác nhau chỉ vì câu chữ giống nhau.
- Không lưu notification history dài hạn, account/session metadata hay PII vào `localStorage`.

### S2-06 — Tác vụ dài

- Cần đo thời gian thực, xác minh API có tiến độ không; nếu không có progress signal, dùng trạng thái bất định.
- Không show success khi browser vừa nhận HTTP 2xx nhưng file chưa thực sự có thể tải/nhận là lỗi.
- Lỗi/chặn quyền luôn có hướng khắc phục; không auto-retry mutation nguy hiểm.

---

## 12. THỨ TỰ PR — có thể giao ngay, không cần họp thiết kế

| PR | Task IDs | Output bắt buộc | Điều kiện merge |
|---|---|---|---|
| **UIUX-S1-01** | S1-01 | `notification-inventory.md`, danh sách action feedback + exceptions | Inventory đủ route active, không phân loại bừa `Alert` |
| **UIUX-S1-02** | S1-02 | Provider+hook+viewport dùng chung; 4 tone/queue/dedupe/duration; tests | Một host; a11y/timer/reduced-motion đạt |
| **UIUX-S1-03** | S1-03 | Chuyển trang Yêu cầu thay đổi thành Toast; bỏ banner xanh thao tác | 8 acceptance cases §5.4 đạt; không trùng trong dialog |
| **UIUX-S1-04A…F** | S1-04 | Migration theo module và inventory cập nhật; tests | Không còn action inline ở module hoàn tất; nghiệp vụ không đổi |
| **UIUX-S1-05** | S1-05 | Button/tab/nav micro-motion | Keyboard/URL/quyền không regression |
| **UIUX-S1-06** | S1-06 | Filters/tooltip polish | Filter logic/chart values không đổi |
| **UIUX-S1-07** | S1-07 | Loading/skeleton/error UX | Không layout shift bất thường, retry giữ data |
| **UIUX-S1-08** | S1-08 | Motion tokens, reduced-motion/perf/tests/QA report | **Release Gate Chặng 1** qua |
| **UIUX-S2-01…08** | S2-01…08 | Mỗi tính năng opt-in riêng, test/perf | Chỉ sau Chặng 1, ship từng module |

**Thứ tự thực thi là mặc định bắt buộc:** 01 → 02 → 03 → 04A…F → 05 → 06 → 07 → 08. Có thể làm song song các nhánh sau khi hợp đồng Toast ổn định nhưng không gộp thành một PR khổng lồ.

### 12.1. Quy tắc mỗi PR

Mỗi PR phải có: (a) scope chính xác; (b) files changed; (c) danh sách logic được giữ nguyên; (d) các case có test; (e) bằng chứng giảm motion/mobile; (f) `notification-inventory.md` diff nếu thay kênh feedback; (g) blockers rõ ràng.

Không dừng ở “code chạy” mà bỏ qua documentation/test. Không trộn một PR UIUX với refactor SQL, auth, report calculations hay API.

---

## 13. KỊCH BẢN KIỂM THỬ BẮT BUỘC (đủ cho Agent tự dựng test)

### 13.1. Notification

| ID | Given | When | Then |
|---|---|---|---|
| **NT-01** | Trang Yêu cầu thay đổi có 1 request duyệt được | API duyệt trả success hợp lệ | 1 Toast success, không `StatusBanner` inline, danh sách cập nhật |
| **NT-02** | Dialog review có lý do đã nhập | API trả 5xx | Error Toast persistent, không đóng dialog, không mất lý do |
| **NT-03** | Request ở version cũ | API trả 409 | 1 Toast warning, reload/concurrency policy giữ nguyên |
| **NT-04** | Người dùng từ chối thành công | API xác nhận | Success Toast, không error Toast |
| **NT-05** | Worker edit/save hợp lệ | API success | Success Toast, không inline success banner, dữ liệu reload như cũ |
| **NT-06** | Export trả lỗi | API thất bại | Error Toast, không lộ file contents/PII, action vẫn recoverable |
| **NT-07** | 4 notification khác nhau cùng lúc | Fire 4 events | Tối đa 3 Toast visible, còn lại queue; không overlap |
| **NT-08** | Lặp cùng dedupeKey | Fire 2 events | Chỉ một Toast theo business event |
| **NT-09** | Toast success vừa fire | Child dialog/tab unmount | Toast còn đúng vòng đời |
| **NT-10** | Một Toast đang hiện | Logout/đổi tài khoản | Toast cũ bị clear, không lộ sang session mới |
| **NT-11** | Form có lỗi một field | Submit invalid | Field error sát trường, không thay bằng Toast duy nhất |
| **NT-12** | Dashboard không có dữ liệu | Mở trang | Empty state tại panel, không Toast “không có dữ liệu” |
| **NT-13** | User không có quyền xem CCCD report | Open deep link | Server gate vẫn chặn, UI không hiện tab trái phép |
| **NT-14** | Thông báo đang hiển thị | Press Tab / keyboard | Không focus steal, close/action accessible, không đọc live region hai lần |

### 13.2. Motion & visual

| ID | Điều kiện | Kỳ vọng |
|---|---|---|
| **MO-01** | Hover/press một button enabled | Feedback 160/120ms, không layout jump, không double-submit |
| **MO-02** | Hover một card KPI không click được | Không có cursor-pointer/hover-lift giả tính tương tác |
| **MO-03** | Switch BoD tab bằng mouse/keyboard | URL đúng, `aria-selected` đúng, state indicator mượt, quyền giữ nguyên |
| **MO-04** | Chọn filter preset / browser Back | Report nhận đúng query, không hiển thị số thuộc filter cũ như kết quả mới |
| **MO-05** | Đóng bộ lọc nâng cao | Input bên trong không nhận focus bằng Tab khi đã ẩn |
| **MO-06** | Hover chart nhiều lần nhanh | Tooltip không lag/flicker, không làm thay data, không clip |
| **MO-07** | Reduce motion ON | Không scale/slide/fade animation mới; Recharts Chặng 1 giữ static; thông tin vẫn hiện đầy đủ |
| **MO-08** | Mobile 320px + keyboard | Toast không tràn viewport/đè nút submit, modal thao tác được |
| **MO-09** | 5 theme × sáng/tối | Border, text, shadow, semantic tone tương phản rõ; không hardcode brand mới |
| **MO-10** | Spreadsheet paste, edit, selection | Hành vi giống trước; không có animation trên cell/row |

### 13.3. Commands tối thiểu (đã có script ở repo)

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:p3-1-hf-change-request-panel
pnpm test:r2-2
pnpm test:p3-w06c
pnpm test:p3-w06d
pnpm test:app-nav-02a
```

**Bắt buộc thêm unit/DOM tests cho Toast mới** và chạy targeted tests liên quan mọi module đã sửa. Lệnh `pnpm test` full suite nên chạy trước release nếu môi trường cho phép; nếu không, ghi chính xác lý do/command/test chưa chạy, **không tự tuyên bố pass**. `pnpm build` cũng nên chạy trước merge cuối chặng khi có môi trường build đầy đủ.

### 13.4. Test manual không thể thay bằng chỉ đọc mã

Agent cần kiểm tra trực tiếp trong môi trường test/staging có quyền phù hợp: luồng tạo/duyệt/rút yêu cầu; worker edit/export; action ở admin; dashboard filters/tabs; reduced-motion; mobile/dialog stacking. Nếu không có tài khoản/staging, viết automated tests mô phỏng HTTP và **đánh dấu manual UAT pending**, không tạo dữ liệu production hay đoán kết quả.

---

## 14. DEFINITION OF DONE (DoD) VÀ GATE PHÁT HÀNH

### Chặng 1 chỉ PASS khi **tất cả** điều kiện đúng

- [ ] Một `NotifyProvider` toàn app; một API `useNotify`; 4 tone; timer, 3 visible, dedupe, dismiss và queue chạy đúng.
- [ ] Banner xanh “Đã duyệt yêu cầu thay đổi …” ở `/direct-entry/change-requests` đã thành **Toast success duy nhất**, không đẩy layout.
- [ ] **Không còn inline action-result banner ở bất kỳ route hoạt động nào** theo inventory cuối cùng; các item `keep` chỉ thuộc `FIELD_VALIDATION / BLOCKING_PAGE_ERROR / PERSISTENT_POLICY / EMPTY_STATE / LOADING_STATE / INLINE_DATA_HINT` và có lý do.
- [ ] Thành công/thất bại/conflict không lặp Toast hoặc báo sai tone; idempotency và stale version guard nguyên vẹn.
- [ ] Button/tab/filter/tooltip/loading có polish nhẹ theo thông số; Recharts data animation **vẫn tắt**.
- [ ] Không sửa DB/API/RPC/logic BI, auth/quyền, nav layout; không đổi nhãn `UNCONFIRMED`.
- [ ] Keyboard, touch/mobile, reduced-motion, theme, dialog focus/stacking kiểm tra qua.
- [ ] Tests/quality commands ghi kết quả thật; nếu thiếu UAT, ghi pending và không claim đã UAT.
- [ ] Có PR summary, inventory cuối, ngoại lệ, notes rollback.

### Chặng 2 chỉ PASS khi

- [ ] Từng animation/chart/KPI opt-in có kiểm thử correctness, accessibility, performance và fallback.
- [ ] Không có số giả, progress giả, Undo giả, hoặc animation làm chậm dữ liệu.
- [ ] Toast nâng cao không phá API public/tính nhất quán của Chặng 1.
- [ ] Luồng dài vẫn an toàn với quyền, đồng thời không làm mất draft khi lỗi.
- [ ] Có tài liệu maintenance cho coding agent tiếp theo.

### Hard blockers / tự động FAIL

- Screenshot/clip trở thành điều kiện để viết code.
- Màn hình duyệt vẫn có success inline màu xanh bên cạnh Toast.
- `StatusBanner` hoặc `<Alert>` vẫn được dùng để render **kết quả thao tác** ở route đã tuyên bố migrated.
- Toast thành công phát trước API xác nhận; báo thành công khi 409/5xx.
- Toast chứa CCCD, PII, error response thô; Toast của tài khoản cũ còn sau logout.
- Enable animation Recharts diện rộng ngay Chặng 1 hoặc thêm framework chỉ vì hover.
- Thay đổi schema/RPC/role/scope hoặc mất trạng thái input/tab keyboard.
- Báo test passed trong khi chưa chạy.

---

## 15. QUY TRÌNH LÀM VIỆC CHO CODING AGENT — CHỈ DÙNG FILE NÀY

### 15.1. Thứ tự thao tác chính xác

1. Đọc file này toàn bộ; đối chiếu commit hiện tại (`git rev-parse HEAD`) và liệt kê các path thay đổi nếu khác snapshot.
2. Kiểm tra `git status --short`; **không ghi đè thay đổi của người khác**. Nếu worktree không sạch, giữ nguyên và ghi chú.
3. Bắt đầu **S1-01**. Tạo inventory đủ route đang hoạt động, xác nhận `StatusBanner` result và `FloatingToast` cũ như §2/§5.
4. Thực hiện **S1-02** tạo toast foundation và tests; không âm thầm xóa notice cũ đang dùng trước khi migrate.
5. Thực hiện **S1-03** sửa trang Yêu cầu thay đổi đúng acceptance scenarios.
6. Thực hiện **S1-04A…F** đến khi inventory action result sạch; mỗi module một commit/PR nhỏ nếu workflow hỗ trợ.
7. Làm **S1-05/06/07**, sau đó **S1-08** review QA và kết luận pass/fail Chặng 1.
8. Chỉ triển khai **Chặng 2** khi người giao việc yêu cầu bắt đầu Chặng 2 hoặc đã có phạm vi chặng rõ ràng. **Không tự làm cả 2 chặng trong một PR.**

### 15.2. Chuẩn cập nhật tiến độ của Agent

Sau mỗi PR/task, báo tối thiểu:

```text
Task ID:
Files created/changed:
Before -> After:
Action-feedback items migrated / remaining:
Tests run (exact command + result):
Risks/regressions checked:
Unresolved / UAT pending:
Next task:
```

### 15.3. Quy tắc điều chỉnh khi repo đã đổi

- Nếu file đổi đường dẫn, tìm theo component/function và giữ nguyên semantic behavior; ghi before/after path.
- Nếu nền tảng toast đã được thay từ sau commit tham chiếu, **tái sử dụng implementation tốt hơn**, không tạo hệ thống thứ hai. Chỉ bổ sung các contract còn thiếu.
- Nếu feature flag làm một route không hoạt động, ghi `inactive/flagged` trong inventory; không xóa route hoặc lén bật flag.
- Nếu UI đã có motion vừa đủ, không thay chỉ vì task có tên motion; xác nhận bằng test và đánh dấu completed-with-evidence.
- Không tự ý mở rộng sang UI redesign, analytics feature backlog hoặc schema DB.

### 15.4. Lệnh giao việc ngắn để copy/paste

> **Triển khai CHẶNG 1 của Master Plan trong `docs/plans/mini-bi-ui-ux-agent-ready-masterplan.md` (hoặc file Markdown tôi đính kèm). Đây là tài liệu yêu cầu DUY NHẤT: không hỏi clip/ảnh/demo. Làm đúng thứ tự S1-01 → S1-08, bắt đầu bằng audit notification, xây một Toast System chung, sửa trước banner duyệt tại `/direct-entry/change-requests`, rồi migrate toàn bộ action feedback của các route hiện hoạt. Tiếp đó polish hover/press/tab/filter/tooltip/loading bằng stack hiện có. Không redesign, không DB/RPC/API/business logic, không bật Recharts animation trong Chặng 1. Mỗi PR phải có test + diff inventory, báo exact commands/results và unresolved items. Nếu không có môi trường UAT, ghi pending rõ ràng, không đoán pass. Không tự triển khai Chặng 2 nếu chưa được yêu cầu.**

---

## 16. ROLLBACK VÀ BẢO TRÌ

- Mỗi PR nhỏ để revert độc lập; animation dùng opt-in classes/variants nên có thể tắt mà không làm mất dữ liệu.
- Nếu Toast Host mới lỗi, có thể rollback S1-02 + module migration tương ứng; không delete adapter cũ trước khi hết call sites.
- Nếu report tab/filter regression, revert CSS motion PR trước; không sửa quyền/report server để vá UI regression.
- Định kỳ chạy lại inventory khi thêm module mới: **không cho thêm `StatusBanner`/`Alert` chỉ để báo thành công/thất bại của click**.
- Trong PR review, hỏi: *Đây là kết quả hành động, lỗi field, hay trạng thái nội dung?* Nếu là kết quả hành động → Toast API chung.

---

## 17. TÓM TẮT CAM KẾT CUỐI CÙNG

**Mini BI vẫn là Mini BI.** Không thay lại giao diện từ đầu. Agent chỉ làm UX mượt và nhất quán hơn: nút dễ hiểu hơn, tab/filter phản hồi tốt hơn, tooltip rõ hơn, loading ít giật hơn, và **mọi kết quả thao tác có Toast chung thay vì thông báo inline lẫn lộn**.

**Chặng 1 = Quick Wins, đặc biệt “Toast-first” và micro-interactions. Chặng 2 = animation/tương tác nâng cao, chỉ khi đủ điều kiện.** File này đã có định nghĩa thị giác bằng lời, thời lượng animation, luồng UI, ví dụ copy, phạm vi source code, thứ tự PR, test/DoD. **Không có phụ thuộc vào bất kỳ clip, hình ảnh hay tài liệu minh họa bên ngoài nào để coding agent thực thi.**
