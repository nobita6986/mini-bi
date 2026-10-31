import {
  adminAreaNavPredicate,
  adminSecurityNavPredicate,
  attendanceReportNavPredicate,
  workerEditHistoryNavPredicate,
  type NavActorProjection,
  type NavCapabilityPredicate,
} from "../navigation/registry-capability.ts";

export type AdminSection = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
};

export type AdminSectionMenuItem =
  | { readonly type: "section"; readonly section: AdminSection }
  | {
      readonly type: "group";
      readonly id: "recruitment";
      readonly label: "Tuyển dụng";
      readonly sections: readonly AdminSection[];
    };

type AdminSectionConfig = AdminSection & {
  readonly visible: NavCapabilityPredicate;
};

export const ADMIN_SECTIONS: readonly AdminSectionConfig[] = [
  { id: "personnel", label: "Nhân sự", href: "/admin/catalog/personnel", visible: adminAreaNavPredicate },
  { id: "teams", label: "Nhóm", href: "/admin/catalog/teams", visible: adminAreaNavPredicate },
  { id: "labor-types", label: "Loại hình lao động", href: "/admin/catalog/labor-types", visible: adminAreaNavPredicate },
  { id: "project-team-scopes", label: "Mapping Dự án ↔ Nhóm", href: "/admin/catalog/project-team-scopes", visible: adminSecurityNavPredicate },
  { id: "vendors", label: "Vendor (NCC)", href: "/admin/catalog/vendors", visible: adminAreaNavPredicate },
  { id: "departments", label: "Phòng ban", href: "/admin/departments", visible: adminSecurityNavPredicate },
  { id: "accounts", label: "Tài khoản truy cập", href: "/admin/access/accounts", visible: adminSecurityNavPredicate },
  { id: "attendance", label: "Báo cáo chấm công", href: "/admin/attendance", visible: attendanceReportNavPredicate },
  { id: "worker-edit-history", label: "Lịch sử chỉnh sửa NLĐ", href: "/admin/worker-edit-history", visible: workerEditHistoryNavPredicate },
];

const RECRUITMENT_SECTION_IDS = new Set([
  "personnel",
  "teams",
  "labor-types",
  "project-team-scopes",
  "vendors",
]);

export function groupAdminSections(sections: readonly AdminSection[]): AdminSectionMenuItem[] {
  const recruitmentSections = sections.filter((section) => RECRUITMENT_SECTION_IDS.has(section.id));
  return [
    ...(recruitmentSections.length > 0
      ? [{ type: "group" as const, id: "recruitment" as const, label: "Tuyển dụng" as const, sections: recruitmentSections }]
      : []),
    ...sections
      .filter((section) => !RECRUITMENT_SECTION_IDS.has(section.id))
      .map((section) => ({ type: "section" as const, section })),
  ];
}

export function isAdminSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function visibleAdminSections(actor: NavActorProjection | null): readonly AdminSection[] {
  if (!actor) return [];
  return ADMIN_SECTIONS
    .filter((section) => section.visible(actor))
    .map(({ id, label, href }) => ({ id, label, href }));
}
