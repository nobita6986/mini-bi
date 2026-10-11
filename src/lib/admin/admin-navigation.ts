import {
  adminAreaNavPredicate,
  adminSecurityNavPredicate,
  type NavActorProjection,
  type NavCapabilityPredicate,
} from "../navigation/registry-capability.ts";

export type AdminSection = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly visible: NavCapabilityPredicate;
};

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { id: "personnel", label: "Nhân sự", href: "/admin/catalog/personnel", visible: adminAreaNavPredicate },
  { id: "teams", label: "Nhóm", href: "/admin/catalog/teams", visible: adminAreaNavPredicate },
  { id: "vendors", label: "Nhà cung cấp", href: "/admin/catalog/vendors", visible: adminAreaNavPredicate },
  { id: "labor-types", label: "Loại hình lao động", href: "/admin/catalog/labor-types", visible: adminAreaNavPredicate },
  { id: "accounts", label: "Tài khoản", href: "/admin/access/accounts", visible: adminSecurityNavPredicate },
];

export function isAdminSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function visibleAdminSections(actor: NavActorProjection | null): readonly AdminSection[] {
  if (!actor) return [];
  return ADMIN_SECTIONS.filter((section) => section.visible(actor));
}
