/**
 * Navigation registry thuần (Server-safe, không 'use client').
 *
 * Mục đích:
 * - Đăng ký tất cả menu items mà App Shell render.
 * - Cung cấp metadata ổn định cho P1.6/P2/P3 (status, capability, visibility).
 * - Tách biệt "đăng ký" với "render" để có thể test thuần + filter ở client.
 *
 * Không phải authorization: `capability` chỉ là metadata, không thay thế RBAC.
 * P3 sẽ thay thế `capability` bằng check thật từ session/role.
 *
 * Hiện tại chỉ render 2 entry (Dashboard, Direct Entry).
 * Pipeline Check (Google Sheets → n8n) đã được dự án loại bỏ và không còn
 * là product feature; route cũ vẫn được redirect server-side về /dashboard.
 */

import type { ComponentType, SVGProps } from "react";
import {
  ClipboardList,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

/** Trạng thái vòng đời của một nav entry. */
export type NavStatus = "current" | "planned";

/**
 * Capability metadata cho P3. Hiện tại CHỈ là khai báo tĩnh;
 * filter thật sẽ do P3 thực hiện từ session. Chưa filter ở App Shell.
 *
 * - "any": mọi phiên đều có thể thấy.
 * - "owner" | "finance" | "hrp": token kế thừa từ W04 navigation
 *   (giữ tương thích ngược cho entry dự định mở rộng về sau).
 * - "entry_own" | "entry_team" | "entry_admin": token lấy từ capability set
 *   của Direct Entry (src/lib/contracts/direct-entry-v1.ts). Direct Entry
 *   có thể được truy cập bởi bất kỳ trong ba actor trên, nên metadata
 *   được biểu diễn bằng MỘT trong các token này (chọn token đại diện
 *   cho actor có quyền rộng nhất — admin). App Shell hiện chưa filter;
 *   P3 sẽ dùng session thật để quyết định render/ẩn.
 */
export type NavCapability =
  | "any"
  | "owner"
  | "finance"
  | "hrp"
  | "entry_own"
  | "entry_team"
  | "entry_admin";

/** Icon component type — accept cả LucideIcon và custom SVG component. */
export type NavIcon = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;

/** Visibility rules cho desktop sidebar và mobile Sheet. */
export type NavVisibility = {
  desktop: boolean;
  mobile: boolean;
};

/** Một entry trong navigation registry. */
export type NavEntry = {
  /** Stable id — dùng làm React key và test selector. */
  id: string;
  /** Nhãn hiển thị (tiếng Việt). */
  label: string;
  /** Path trong App Router (e.g. "/dashboard"). */
  path: string;
  /** Mô tả ngắn cho a11y / tooltip. */
  description: string;
  /** Icon component từ lucide-react. */
  icon: NavIcon;
  /** Vòng đời. 'planned' KHÔNG render ở App Shell. */
  status: NavStatus;
  /**
   * Capability metadata cho P3 (chưa filter thật).
   * - "any" → ai cũng có.
   * - token khác → metadata-only; P3 sẽ đối chiếu session.
   */
  capability: NavCapability;
  /** Visibility cho desktop + mobile. */
  visibility: NavVisibility;
};

/**
 * Registry nguồn — chỉ một chỗ để thêm/bớt menu.
 * Renderer (App Shell) chỉ map và filter; không hardcode nhãn ở component.
 *
 * Quy tắc thêm entry:
 * 1. status = 'current' thì App Shell render.
 * 2. status = 'planned' thì App Shell KHÔNG render (chỉ tồn tại trong registry
 *    cho P1.6/P2/P3 sẽ chuyển sang 'current' khi sẵn sàng).
 * 3. visibility phải được set rõ ràng (không mặc định) để tránh render ở
 *    viewport không mong muốn.
 */
export const NAV_ENTRIES: ReadonlyArray<NavEntry> = [
  {
    id: "dashboard",
    label: "Tổng quan",
    path: "/dashboard",
    description: "Báo cáo tổng quan theo dự án, người tuyển, HRP/Vendor.",
    icon: LayoutDashboard,
    status: "current",
    capability: "any",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "direct-entry",
    label: "Nhập liệu",
    path: "/direct-entry",
    description:
      "Nhập liệu trực tiếp cho HRP: hồ sơ, thanh toán, tài liệu. " +
      "Metadata cho biết actor có một trong các quyền entry_own | entry_team | entry_admin; " +
      "P3 sẽ lọc theo session thật.",
    icon: ClipboardList,
    status: "current",
    capability: "entry_admin",
    visibility: { desktop: true, mobile: true },
  },
];

/** Chỉ các entry hiện hành (status = 'current'). */
export const CURRENT_NAV_ENTRIES: ReadonlyArray<NavEntry> = NAV_ENTRIES.filter(
  (e) => e.status === "current"
);

/** Lọc theo viewport và cờ hiển thị server-side của Direct Entry. */
export function entriesForViewport(
  viewport: "desktop" | "mobile",
  directEntryEnabled: boolean,
): ReadonlyArray<NavEntry> {
  return CURRENT_NAV_ENTRIES.filter((entry) =>
    entry.visibility[viewport] && (entry.id !== "direct-entry" || directEntryEnabled)
  );
}

/**
 * P3-W06A: filter cùng registry theo viewport + capability predicate từ session thật.
 *
 * - Nếu `actor === null`: chỉ `any` còn hiện (Dashboard). Direct Entry / AI / admin ẩn.
 * - Nếu `actor` đã resolve: predicate tương ứng với `entry.capability` quyết định.
 * - KHÔNG tạo registry thứ hai; tái sử dụng toàn bộ `NAV_ENTRIES` + `CURRENT_NAV_ENTRIES`.
 * - KHÔNG dùng role name / email / env làm quyền.
 *
 * P3-W06A R1:
 * - Viewport + visibility là trách nhiệm của `filterEntriesForActor` (filter
 *   `entry.visibility[viewport]`). Caller KHÔNG cần truyền `viewport` /
 *   `entryVisibleInViewport` vào predicate.
 * - Capability là trách nhiệm của `decide` (đóng gói `decideNavEntryVisibility`
 *   với `actor` đã biết + capability key).
 * - `decide` nhận `NavEntry` để có thể xét capability key + bất kỳ metadata
 *   nào trong entry (kể cả visibility) nếu cần.
 *
 * Hàm này sống cùng `entriesForViewport` cũ để test cũ vẫn xanh; AppShell sẽ
 * dùng phiên bản này từ P3-W06A trở đi.
 */
export function filterEntriesForActor(input: {
  viewport: "desktop" | "mobile";
  directEntryEnabled: boolean;
  actor: {
    capabilities: readonly string[];
    scopes: readonly { kind: "own" | "team" | "all" }[];
  } | null;
  decide: (entry: NavEntry) => boolean;
}): ReadonlyArray<NavEntry> {
  return CURRENT_NAV_ENTRIES.filter((entry) => {
    if (!entry.visibility[input.viewport]) return false;
    if (entry.id === "direct-entry" && !input.directEntryEnabled) return false;
    return input.decide(entry);
  });
}

/**
 * Tìm entry theo path — dùng cho highlight "active" trong App Shell.
 * Trả về undefined nếu path không thuộc registry (vd. landing page `/`).
 */
export function findEntryByPath(path: string): NavEntry | undefined {
  return CURRENT_NAV_ENTRIES.find((e) => e.path === path);
}
