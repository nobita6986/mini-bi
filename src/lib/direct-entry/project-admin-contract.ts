/**
 * P2.5-W06A - Strict projections cho Project Operations admin RPC.
 *
 * Server la authority: moi projection o day FAIL-CLOSED. Thieu/thua key, sai kieu
 * hoac gia tri khong hop le => null (khong bao gio doan y nghia, khong bao gio
 * tra ve mot doi tuong mot phan).
 */

export type AdminProject = {
  project_id: string;
  display_name: string;
  active: boolean;
  version: number;
};

export type AdminAssignment = {
  assignment_id: string;
  project_id: string;
  project_version: number;
  manager_recruiter_id: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  version: number;
  revoked_at: string | null;
  created_at: string;
};

export type AdminProjectList = {
  authorization_date: string;
  include_inactive: boolean;
  projects: readonly AdminProject[];
};

export type AdminProjectDetail = {
  authorization_date: string;
  project_id: string;
  project_version: number;
  project_active: boolean;
  active_assignment_count: number;
  assignments: readonly AdminAssignment[];
};

export type AdminProjectMutation = {
  project_id: string;
  display_name: string;
  active: boolean;
  version: number;
  revision_id: string;
};

export type AdminAssignmentMutation = {
  assignment_id: string;
  project_id: string;
  version: number;
  project_version: number;
  valid_to: string | null;
  already: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function nullableStr(value: unknown): string | null | undefined {
  return value === null ? null : (str(value) ?? undefined);
}
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

const PROJECT_KEYS = ["project_id", "display_name", "active", "version"] as const;
const ASSIGNMENT_KEYS = ["assignment_id", "project_id", "project_version",
  "manager_recruiter_id", "valid_from", "valid_to", "effective", "version",
  "revoked_at", "created_at", "updated_at"] as const;

export function projectAdminProject(value: unknown): AdminProject | null {
  if (!isRecord(value) || !exactKeys(value, PROJECT_KEYS)) return null;
  const project_id = str(value.project_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  if (project_id === null || display_name === null || active === null || version === null) return null;
  return { project_id, display_name, active, version };
}

export function projectAdminAssignment(value: unknown): AdminAssignment | null {
  if (!isRecord(value) || !exactKeys(value, ASSIGNMENT_KEYS)) return null;
  const assignment_id = str(value.assignment_id);
  const project_id = str(value.project_id);
  const project_version = int(value.project_version);
  const manager_recruiter_id = str(value.manager_recruiter_id);
  const valid_from = str(value.valid_from);
  const valid_to = nullableStr(value.valid_to);
  const effective = bool(value.effective);
  const version = int(value.version);
  const revoked_at = nullableStr(value.revoked_at);
  const created_at = str(value.created_at);
  if (assignment_id === null || project_id === null || project_version === null ||
      manager_recruiter_id === null || valid_from === null || valid_to === undefined ||
      effective === null || version === null || revoked_at === undefined || created_at === null) {
    return null;
  }
  return { assignment_id, project_id, project_version, manager_recruiter_id,
    valid_from, valid_to, effective, version, revoked_at, created_at };
}

export function projectAdminList(value: unknown): AdminProjectList | null {
  if (!isRecord(value)) return null;
  const authorization_date = str(value.authorization_date);
  const include_inactive = bool(value.include_inactive);
  if (authorization_date === null || include_inactive === null || !Array.isArray(value.projects)) {
    return null;
  }
  const projects: AdminProject[] = [];
  for (const item of value.projects) {
    const project = projectAdminProject(item);
    if (!project) return null;
    projects.push(project);
  }
  return { authorization_date, include_inactive, projects };
}

export function projectAdminDetail(value: unknown): AdminProjectDetail | null {
  if (!isRecord(value)) return null;
  const authorization_date = str(value.authorization_date);
  const project_id = str(value.project_id);
  const project_version = int(value.project_version);
  const project_active = bool(value.project_active);
  const count = int(value.active_assignment_count);
  if (authorization_date === null || project_id === null || project_version === null ||
      project_active === null || count === null || !Array.isArray(value.assignments)) {
    return null;
  }
  const assignments: AdminAssignment[] = [];
  for (const item of value.assignments) {
    const assignment = projectAdminAssignment(item);
    if (!assignment) return null;
    assignments.push(assignment);
  }
  return { authorization_date, project_id, project_version, project_active,
    active_assignment_count: count, assignments };
}

export function projectAdminMutation(value: unknown): AdminProjectMutation | null {
  if (!isRecord(value)) return null;
  const project_id = str(value.project_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  if (project_id === null || display_name === null || active === null ||
      version === null || revision_id === null) return null;
  return { project_id, display_name, active, version, revision_id };
}

export function projectAdminAssignmentMutation(
  value: unknown,
  input: { assignment_id: string; already_key: "already_assigned" | "already_unassigned" },
): AdminAssignmentMutation | null {
  if (!isRecord(value)) return null;
  const assignment_id = str(value.assignment_id);
  const project_id = str(value.project_id);
  const version = int(value.version);
  const project_version = int(value.project_version);
  const valid_to = nullableStr(value.valid_to);
  const already = bool(value[input.already_key]);
  if (assignment_id === null || project_id === null || version === null ||
      project_version === null || valid_to === undefined || already === null) return null;
  return { assignment_id, project_id, version, project_version, valid_to, already };
}
