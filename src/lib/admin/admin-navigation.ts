import {
  adminAreaNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";

export const ADMIN_SECTIONS = [
  { id: "personnel", label: "Nhân sự", href: "/admin/catalog/personnel" },
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export function visibleAdminSections(actor: NavActorProjection | null) {
  return actor && adminAreaNavPredicate(actor) ? ADMIN_SECTIONS : [];
}
