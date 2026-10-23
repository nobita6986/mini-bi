export type OffboardingReportItem = {
  employee_code: string;
  display_name: string;
  project_id: string;
  project_display: string;
  recruiter_id: string;
  recruiter_display: string;
  off_effective_date: string;
  days_since_off: number;
  /** Only present for the all-scope audiences (Full Admin / BoD). */
  phone?: string;
};

export type OffboardingReportList = {
  scope: "all" | "team";
  authority: string;
  can_export: boolean;
  authorization_date: string;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  items: OffboardingReportItem[];
};

export type OffboardingReportExport = {
  authorization_date: string;
  items: OffboardingReportItem[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function isItem(value: unknown): value is OffboardingReportItem {
  return (
    isRecord(value) &&
    typeof value.employee_code === "string" && value.employee_code.trim().length > 0 &&
    typeof value.display_name === "string" && value.display_name.trim().length > 0 &&
    typeof value.project_id === "string" && value.project_id.length > 0 &&
    typeof value.project_display === "string" &&
    typeof value.recruiter_id === "string" && UUID.test(value.recruiter_id) &&
    typeof value.recruiter_display === "string" &&
    typeof value.off_effective_date === "string" && DATE.test(value.off_effective_date) &&
    Number.isInteger(value.days_since_off) && Number(value.days_since_off) >= 3 &&
    (value.phone === undefined || typeof value.phone === "string")
  );
}

export function parseOffboardingReportList(body: unknown): OffboardingReportList | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null;
  const d = body.data;
  if (
    (d.scope !== "all" && d.scope !== "team") ||
    typeof d.authority !== "string" ||
    typeof d.can_export !== "boolean" ||
    typeof d.authorization_date !== "string" ||
    !Array.isArray(d.items) || !d.items.every(isItem) ||
    !Number.isInteger(d.page) || !Number.isInteger(d.page_size) ||
    !Number.isInteger(d.total) || typeof d.has_more !== "boolean"
  ) {
    return null;
  }
  return {
    scope: d.scope as "all" | "team",
    authority: d.authority,
    can_export: d.can_export,
    authorization_date: d.authorization_date,
    page: d.page as number,
    page_size: d.page_size as number,
    total: d.total as number,
    has_more: d.has_more as boolean,
    items: d.items as OffboardingReportItem[],
  };
}

export function parseOffboardingReportExport(body: unknown): OffboardingReportExport | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null;
  const d = body.data;
  if (typeof d.authorization_date !== "string" || !Array.isArray(d.items) || !d.items.every(isItem)) {
    return null;
  }
  return { authorization_date: d.authorization_date, items: d.items as OffboardingReportItem[] };
}
