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
 * Current entries are filtered by viewport, feature availability and actor capability.
 * Pipeline Check (Google Sheets → n8n) đã được dự án loại bỏ và không còn
 * là product feature; route cũ vẫn được redirect server-side về /dashboard.
 */

import type { ComponentType, SVGProps } from "react";
import {
  Building2,
  ClipboardList,
  FileDiff,
  Landmark,
  LayoutDashboard,
  NotebookPen,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";

/** Trạng thái vòng đời của một nav entry. */
export type NavStatus = "current" | "planned";

/**
 * Capability metadata cho P3. Hiện tại CHỈ là khai báo tĩnh;
 *   predicate thuần lọc theo actor đã resolve.
 *
 * - "any": mọi phiên đều có thể thấy.
 * - "owner" | "finance" | "hrp": token kế thừa từ W04 navigation
 *   (giữ tương thích ngược cho entry dự định mở rộng về sau).
 * - "admin_area": catalog operator (catalog_master_manage + effective all)
 *   hoặc Full Admin triple + effective all.
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
  | "entry_admin"
  | "project_admin"
  | "admin_area"
  | "worker_operations"
  | "change_requests"
  | "work_reports"
  | "work_report_reviews"
  | "workforce_offboarding";

/** Icon component type — accept cả LucideIcon và custom SVG component. */
export type NavIcon = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;

/** Visibility rules cho desktop sidebar và mobile Sheet. */
export type NavVisibility = {
  desktop: boolean;
  mobile: boolean;
};

export type NavGroupId = "new-reports" | "daily-reports";

export const NAV_GROUP_LABELS: Readonly<Record<NavGroupId, string>> = {
  "new-reports": "Báo cáo cấp mới",
  "daily-reports": "Báo cáo hàng ngày",
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
   * - token khác → P3 đối chiếu session đã resolve.
   */
  capability: NavCapability;
  /** Menu cha; entry vẫn được lọc quyền độc lập trước khi nhóm. */
  group?: NavGroupId;
  /** Visibility cho desktop + mobile. */
  visibility: NavVisibility;
};

export type NavMenuEntry = Pick<NavEntry, "id" | "label" | "path" | "group">;
export type NavMenuNode =
  | { type: "entry"; entry: NavMenuEntry }
  | { type: "group"; id: NavGroupId; label: string; entries: NavMenuEntry[] };

/** Nhóm sau khi filter capability/feature flag, nên nhóm rỗng tự biến mất. */
export function groupNavEntries(entries: readonly NavMenuEntry[]): NavMenuNode[] {
  const result: NavMenuNode[] = [];
  for (const entry of entries) {
    if (!entry.group) {
      result.push({ type: "entry", entry });
      continue;
    }
    const group = result.find((item): item is Extract<NavMenuNode, { type: "group" }> =>
      item.type === "group" && item.id === entry.group
    );
    if (group) group.entries.push(entry);
    else result.push({
      type: "group",
      id: entry.group,
      label: NAV_GROUP_LABELS[entry.group],
      entries: [entry],
    });
  }
  return result;
}

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
    group: "new-reports",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "project-operations",
    label: "Dự án",
    path: "/direct-entry/projects",
    description:
      "P2.5-W06A: quản lý dự án (tạo, đổi tên, ngừng/kích hoạt) và gán/thu hồi " +
      "quản lý dự án. Capability 'project_admin' ánh xạ projectAdminNavPredicate " +
      "(entry_admin ∧ effective all scope) đúng DB W02; chỉ là metadata hiển thị — " +
      "quyền thật do RPC admin enforce.",
    icon: Building2,
    status: "current",
    capability: "project_admin",
    group: "new-reports",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "worker-operations",
    label: "Người lao động",
    path: "/direct-entry/workers",
    description:
      "P2.5-W06: tra cứu người lao động theo ba quan hệ — hồ sơ bạn đã nhập, người bạn " +
      "tuyển, và người thuộc dự án bạn đang quản lý. CTA đề xuất thay đổi do server " +
      "allowed_actions quyết định; created_by/recruiter_id không tạo quyền.",
    icon: Users,
    status: "current",
    capability: "worker_operations",
    group: "new-reports",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "change-requests",
    label: "Yêu cầu thay đổi",
    path: "/direct-entry/change-requests",
    description:
      "R2.2: theo dõi yêu cầu thay đổi đã gửi, xử lý yêu cầu chờ duyệt theo thẩm quyền " +
      "hiện tại và tra cứu lịch sử xử lý bất biến.",
    icon: FileDiff,
    status: "current",
    capability: "change_requests",
    group: "new-reports",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "work-reports",
    label: "Báo cáo công việc",
    path: "/work-reports",
    description:
      "Tạo, giao, nộp và tra cứu báo cáo công việc theo capability và resource scope do server xác nhận.",
    icon: NotebookPen,
    status: "current",
    capability: "work_reports",
    group: "daily-reports",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "work-report-reviews",
    label: "Duyệt báo cáo",
    path: "/work-reports/reviews",
    description:
      "Mở hàng đợi báo cáo đang chờ duyệt theo quyền review và phạm vi hiệu lực do máy chủ chiếu.",
    icon: ClipboardList,
    status: "current",
    capability: "work_report_reviews",
    group: "daily-reports",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "finance",
    label: "Tài chính",
    path: "/finance",
    description:
      "Theo dõi công nợ, tạm ứng, sổ cái, đối soát và chứng từ tài chính Vendor theo quyền được máy chủ xác nhận.",
    icon: Landmark,
    status: "current",
    capability: "finance",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "admin",
    label: "Quản trị",
    path: "/admin",
    description: "Quản lý danh mục nhân sự và các thiết lập quản trị được cấp quyền.",
    icon: ShieldCheck,
    status: "current",
    capability: "admin_area",
    visibility: { desktop: true, mobile: true },
  },
];

/**
 * P2.5-W06A: moi route thuoc khu vực Direct Entry (ke ca /direct-entry/projects)
 * deu bi gate boi cung flag DIRECT_ENTRY_UI_ENABLED.
 */
export function isDirectEntryRoute(entry: NavEntry): boolean {
  return entry.path === "/direct-entry" || entry.path.startsWith("/direct-entry/");
}

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
    entry.visibility[viewport] && (!isDirectEntryRoute(entry) || directEntryEnabled)
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
    if (isDirectEntryRoute(entry) && !input.directEntryEnabled) return false;
    return input.decide(entry);
  });
}

/**
 * Tìm entry theo path — dùng cho highlight "active" trong App Shell.
 * Exact match thang; neu khong co, tra entry co path la prefix dai nhat
 * (de /direct-entry/projects highlight "Dự án", khong phai "Nhập liệu").
 * Tra undefined neu path khong thuoc registry (vd. landing page `/`).
 */
export function findEntryByPath(path: string): NavEntry | undefined {
  for (const entry of CURRENT_NAV_ENTRIES) {
    if (path === entry.path) return entry;
  }
  let best: NavEntry | undefined;
  for (const entry of CURRENT_NAV_ENTRIES) {
    if (path.startsWith(entry.path + "/") &&
        (!best || entry.path.length > best.path.length)) {
      best = entry;
    }
  }
  return best;
}
