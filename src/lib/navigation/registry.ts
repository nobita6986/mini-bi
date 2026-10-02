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
 * Hiện tại chỉ render 2 entry (Dashboard, Pipeline Check).
 * Planned entries (P1.6 direct entry, P2 finance/payment) đã đăng ký
 * nhưng status = 'planned' và sẽ không render.
 */

import type { ComponentType, SVGProps } from "react";
import {
  Activity,
  ClipboardList,
  LayoutDashboard,
  type LucideIcon,
} from "lucide-react";

/** Trạng thái vòng đời của một nav entry. */
export type NavStatus = "current" | "planned";

/**
 * Capability metadata cho P3. Hiện tại CHỈ là khai báo tĩnh;
 * filter thật sẽ do P3 thực hiện từ session. Chưa filter ở App Shell.
 */
export type NavCapability = "any" | "owner" | "finance" | "hrp";

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
  /** Capability metadata cho P3 (chưa filter thật). */
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
    label: "Tổng quan tuyển dụng",
    path: "/dashboard",
    description: "Báo cáo tổng quan theo dự án, người tuyển, HRP/Vendor.",
    icon: LayoutDashboard,
    status: "current",
    capability: "any",
    visibility: { desktop: true, mobile: true },
  },
  {
    id: "pipeline-check",
    label: "Pipeline check",
    path: "/pipeline-check",
    description: "Trạng thái đường dẫn dữ liệu Google Sheets → n8n → Supabase.",
    icon: Activity,
    status: "current",
    capability: "any",
    visibility: { desktop: true, mobile: true },
  },
  // === PLANNED — không render cho đến khi chuyển sang 'current' ===
  {
    id: "direct-entry",
    label: "Nhập liệu trực tiếp",
    path: "/direct-entry",
    description: "Form nhập liệu cho HRP (planned P1.6).",
    icon: ClipboardList,
    status: "planned",
    capability: "hrp",
    visibility: { desktop: true, mobile: true },
  },
];

/** Chỉ các entry hiện hành (status = 'current'). */
export const CURRENT_NAV_ENTRIES: ReadonlyArray<NavEntry> = NAV_ENTRIES.filter(
  (e) => e.status === "current"
);

/** Lọc theo viewport. Dùng ở App Shell để tách desktop sidebar / mobile sheet. */
export function entriesForViewport(viewport: "desktop" | "mobile"): ReadonlyArray<NavEntry> {
  return CURRENT_NAV_ENTRIES.filter((e) => e.visibility[viewport]);
}

/**
 * Tìm entry theo path — dùng cho highlight "active" trong App Shell.
 * Trả về undefined nếu path không thuộc registry (vd. landing page `/`).
 */
export function findEntryByPath(path: string): NavEntry | undefined {
  return CURRENT_NAV_ENTRIES.find((e) => e.path === path);
}
