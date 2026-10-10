/**
 * P2.5-W06A-R1 - Strict projections cho Project Operations admin RPC.
 *
 * Payload dung chinh xac theo migration #51, extended by migration #72 with
 * server-projected Project Operations authority:
 * - list_projects_admin / get_project_admin tra 10 key master row:
 *     project_id, display_name, active, version, created_at, updated_at,
 *     revision_count, active_assignment_count, can_manage_project_master,
 *     can_assign_managers.
 * - list_project_manager_assignments tra detail assignment (11 key moi row).
 *
 * Server la authority: moi projection FAIL-CLOSED. Thieu/thua key, sai kieu
 * hoac gia tri khong hop le => null (khong bao gio doan y nghia, khong bao gio
 * tra ve doi tuong mot phan).
 */

export type AdminProject = {
  project_id: string;
  display_name: string;
  active: boolean;
  version: number;
  created_at: string | null;
  updated_at: string | null;
  revision_count: number;
  active_assignment_count: number;
  can_manage_project_master: boolean;
  can_assign_managers: boolean;
};

export type AdminAssignment = {
  assignment_id: string;
  project_id: string;
  /** project_version = OCC token cua PROJECT (p.version), khong phai assignment. */
  project_version: number;
  manager_recruiter_id: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  /** version = assignment version (a.version). */
  version: number;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AdminProjectList = {
  authorization_date: string;
  include_inactive: boolean;
  projects: readonly AdminProject[];
};

/** Detail assignment tra tu direct_entry_list_project_manager_assignments. */
export type AdminProjectAssignments = {
  authorization_date: string;
  project_id: string;
  project_version: number;
  project_active: boolean;
  include_history: boolean;
  active_assignment_count: number;
  assignments: readonly AdminAssignment[];
};

/** Detail duoc API ghep tu get_project_admin (master) + list assignments. */
export type AdminProjectDetail = {
  master: AdminProject;
  assignments: AdminProjectAssignments;
};

/** update + set_active (5 key). */
export type AdminProjectMutation = {
  project_id: string;
  display_name: string;
  active: boolean;
  version: number;
  revision_id: string;
};

/** create tra them created: true (6 key). */
export type AdminProjectCreateMutation = AdminProjectMutation & { created: boolean };

/** assign/unassign tra assignment version + project OCC version moi. */
export type AdminAssignmentMutation = {
  assignment_id: string;
  project_id: string;
  /** assignment version (a.version). */
  version: number;
  /** project OCC version moi (p.version) — dung cho OCC buoc tiep theo. */
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

const PROJECT_KEYS = ["project_id", "display_name", "active", "version",
  "created_at", "updated_at", "revision_count", "active_assignment_count",
  "can_manage_project_master", "can_assign_managers"] as const;
const ASSIGNMENT_KEYS = ["assignment_id", "project_id", "project_version",
  "manager_recruiter_id", "valid_from", "valid_to", "effective", "version",
  "revoked_at", "created_at", "updated_at"] as const;

/** Master row 10 key (list item + get_project_admin). */
export function projectAdminProject(value: unknown): AdminProject | null {
  if (!isRecord(value) || !exactKeys(value, PROJECT_KEYS)) return null;
  const project_id = str(value.project_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const created_at = nullableStr(value.created_at);
  const updated_at = nullableStr(value.updated_at);
  const revision_count = int(value.revision_count);
  const active_assignment_count = int(value.active_assignment_count);
  const can_manage_project_master = bool(value.can_manage_project_master);
  const can_assign_managers = bool(value.can_assign_managers);
  if (project_id === null || display_name === null || active === null || version === null ||
      created_at === undefined || updated_at === undefined ||
      revision_count === null || active_assignment_count === null ||
      can_manage_project_master === null || can_assign_managers === null) {
    return null;
  }
  return { project_id, display_name, active, version, created_at, updated_at,
    revision_count, active_assignment_count, can_manage_project_master, can_assign_managers };
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
  const updated_at = str(value.updated_at);
  if (assignment_id === null || project_id === null || project_version === null ||
      manager_recruiter_id === null || valid_from === null || valid_to === undefined ||
      effective === null || version === null || revoked_at === undefined ||
      created_at === null || updated_at === null) {
    return null;
  }
  return { assignment_id, project_id, project_version, manager_recruiter_id,
    valid_from, valid_to, effective, version, revoked_at, created_at, updated_at };
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

/** Detail assignment (direct_entry_list_project_manager_assignments, per-project). */
export function projectAdminAssignments(value: unknown): AdminProjectAssignments | null {
  if (!isRecord(value)) return null;
  const authorization_date = str(value.authorization_date);
  const project_id = str(value.project_id);
  const project_version = int(value.project_version);
  const project_active = bool(value.project_active);
  const include_history = bool(value.include_history);
  const count = int(value.active_assignment_count);
  if (authorization_date === null || project_id === null || project_version === null ||
      project_active === null || include_history === null || count === null ||
      !Array.isArray(value.assignments)) {
    return null;
  }
  const assignments: AdminAssignment[] = [];
  for (const item of value.assignments) {
    const assignment = projectAdminAssignment(item);
    if (!assignment) return null;
    assignments.push(assignment);
  }
  return { authorization_date, project_id, project_version, project_active,
    include_history, active_assignment_count: count, assignments };
}

export function projectAdminMutation(value: unknown): AdminProjectMutation | null {
  if (!isRecord(value) || !exactKeys(value,
    ["project_id", "display_name", "active", "version", "revision_id"])) return null;
  const project_id = str(value.project_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  if (project_id === null || display_name === null || active === null ||
      version === null || revision_id === null) return null;
  return { project_id, display_name, active, version, revision_id };
}

export function projectAdminCreateMutation(value: unknown): AdminProjectCreateMutation | null {
  if (!isRecord(value) || !exactKeys(value,
    ["project_id", "display_name", "active", "version", "revision_id", "created"])) return null;
  const project_id = str(value.project_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  const created = bool(value.created);
  if (project_id === null || display_name === null || active === null ||
      version === null || revision_id === null || created !== true) return null;
  return { project_id, display_name, active, version, revision_id, created };
}

/** assign: 8 key (manager_recruiter_id + valid_from co mat). */
export function projectAdminAssignMutation(value: unknown): AdminAssignmentMutation | null {
  if (!isRecord(value) || !exactKeys(value, ["assignment_id", "project_id",
    "manager_recruiter_id", "valid_from", "valid_to", "version", "project_version",
    "already_assigned"])) return null;
  const assignment_id = str(value.assignment_id);
  const project_id = str(value.project_id);
  const version = int(value.version);
  const project_version = int(value.project_version);
  const valid_to = nullableStr(value.valid_to);
  const already = bool(value.already_assigned);
  if (assignment_id === null || project_id === null || version === null ||
      project_version === null || valid_to === undefined || already === null) return null;
  return { assignment_id, project_id, version, project_version, valid_to, already };
}

/** unassign: 6 key (khong co manager_recruiter_id/valid_from). */
export function projectAdminUnassignMutation(value: unknown): AdminAssignmentMutation | null {
  if (!isRecord(value) || !exactKeys(value, ["assignment_id", "project_id",
    "valid_to", "version", "project_version", "already_unassigned"])) return null;
  const assignment_id = str(value.assignment_id);
  const project_id = str(value.project_id);
  const version = int(value.version);
  const project_version = int(value.project_version);
  const valid_to = nullableStr(value.valid_to);
  const already = bool(value.already_unassigned);
  if (assignment_id === null || project_id === null || version === null ||
      project_version === null || valid_to === undefined || already === null) return null;
  return { assignment_id, project_id, version, project_version, valid_to, already };
}

/** W06A-R2: candidate manager (recruiter identity only; no auth/user/PII). */
export type AdminManagerCandidate = {
  recruiter_id: string;
  display_name: string;
  personnel_code: string | null;
  personnel_position: string | null;
};

export type AdminManagerCandidates = {
  candidates: readonly AdminManagerCandidate[];
};

export function projectAdminCandidate(value: unknown): AdminManagerCandidate | null {
  if (!isRecord(value)) return null;
  const recruiter_id = str(value.recruiter_id);
  const display_name = str(value.display_name);
  const personnel_code = nullableStr(value.personnel_code);
  const personnel_position = nullableStr(value.personnel_position);
  if (recruiter_id === null || display_name === null ||
      personnel_code === undefined || personnel_position === undefined) return null;
  return { recruiter_id, display_name, personnel_code, personnel_position };
}

export function projectAdminCandidates(value: unknown): AdminManagerCandidates | null {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return null;
  const candidates: AdminManagerCandidate[] = [];
  for (const item of value.candidates) {
    const candidate = projectAdminCandidate(item);
    if (!candidate) return null;
    candidates.push(candidate);
  }
  return { candidates };
}
