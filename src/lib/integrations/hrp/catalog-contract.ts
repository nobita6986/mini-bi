export type HrpCatalogProjectLocation = {
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  confirmedAt: string | null;
};

export type HrpCatalogProject = {
  projectId: string;
  displayName: string;
  active: boolean;
  version: number;
  updatedAt: string;
  location: HrpCatalogProjectLocation | null;
};

export type HrpCatalogTeam = {
  teamId: string;
  code: string;
  displayName: string;
  active: boolean;
};

export type HrpCatalogRecruiter = {
  recruiterId: string;
  displayName: string;
  personnelCode: string | null;
  personnelPosition: string | null;
  active: boolean;
  providerTypes: string[];
  teams: HrpCatalogTeam[];
};

export type HrpCatalogLaborType = {
  key: string;
  displayName: string;
  active: boolean;
  sortOrder: number;
  version: number;
};

export type HrpSyncCatalogPayload = {
  ok: true;
  serverTime: string;
  projects: HrpCatalogProject[];
  recruiters: HrpCatalogRecruiter[];
  laborTypes: HrpCatalogLaborType[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((k) => set.has(k));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function projectLocation(value: unknown): HrpCatalogProjectLocation | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["address", "latitude", "longitude", "radiusMeters", "confirmedAt"])
  ) {
    return null;
  }
  if (
    !isNullableString(value.address) ||
    (value.address !== null && value.address.length > 500) ||
    typeof value.latitude !== "number" ||
    !Number.isFinite(value.latitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    typeof value.longitude !== "number" ||
    !Number.isFinite(value.longitude) ||
    value.longitude < -180 ||
    value.longitude > 180 ||
    typeof value.radiusMeters !== "number" ||
    !Number.isSafeInteger(value.radiusMeters) ||
    value.radiusMeters < 50 ||
    value.radiusMeters > 2000 ||
    !isNullableString(value.confirmedAt)
  ) {
    return null;
  }
  return {
    address: value.address,
    latitude: Object.is(value.latitude, -0) ? 0 : value.latitude,
    longitude: Object.is(value.longitude, -0) ? 0 : value.longitude,
    radiusMeters: value.radiusMeters,
    confirmedAt: value.confirmedAt,
  };
}

function projectProjectItem(value: unknown): HrpCatalogProject | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "projectId",
      "displayName",
      "active",
      "version",
      "updatedAt",
      "location",
    ])
  ) {
    return null;
  }
  if (
    !isNonEmptyString(value.projectId) ||
    !isNonEmptyString(value.displayName) ||
    typeof value.active !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !isNonEmptyString(value.updatedAt)
  ) {
    return null;
  }
  const location = value.location === null ? null : projectLocation(value.location);
  if (value.location !== null && !location) {
    return null;
  }
  return {
    projectId: value.projectId,
    displayName: value.displayName,
    active: value.active,
    version: value.version,
    updatedAt: value.updatedAt,
    location,
  };
}

function projectTeamItem(value: unknown): HrpCatalogTeam | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["teamId", "code", "displayName", "active"])
  ) {
    return null;
  }
  if (
    !isUuid(value.teamId) ||
    !isNonEmptyString(value.code) ||
    !isNonEmptyString(value.displayName) ||
    typeof value.active !== "boolean"
  ) {
    return null;
  }
  return {
    teamId: value.teamId.toLowerCase(),
    code: value.code,
    displayName: value.displayName,
    active: value.active,
  };
}

function projectRecruiterItem(value: unknown): HrpCatalogRecruiter | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "recruiterId",
      "displayName",
      "personnelCode",
      "personnelPosition",
      "active",
      "providerTypes",
      "teams",
    ])
  ) {
    return null;
  }
  if (
    !isUuid(value.recruiterId) ||
    !isNonEmptyString(value.displayName) ||
    !isNullableString(value.personnelCode) ||
    !isNullableString(value.personnelPosition) ||
    typeof value.active !== "boolean" ||
    !Array.isArray(value.providerTypes) ||
    !value.providerTypes.every((p) => isNonEmptyString(p)) ||
    !Array.isArray(value.teams)
  ) {
    return null;
  }
  const teams: HrpCatalogTeam[] = [];
  for (const t of value.teams) {
    const projected = projectTeamItem(t);
    if (!projected) return null;
    teams.push(projected);
  }
  return {
    recruiterId: value.recruiterId.toLowerCase(),
    displayName: value.displayName,
    personnelCode: value.personnelCode,
    personnelPosition: value.personnelPosition,
    active: value.active,
    providerTypes: [...value.providerTypes],
    teams,
  };
}

function projectLaborTypeItem(value: unknown): HrpCatalogLaborType | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["key", "displayName", "active", "sortOrder", "version"])
  ) {
    return null;
  }
  if (
    !isNonEmptyString(value.key) ||
    !isNonEmptyString(value.displayName) ||
    typeof value.active !== "boolean" ||
    typeof value.sortOrder !== "number" ||
    !Number.isSafeInteger(value.sortOrder) ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    return null;
  }
  return {
    key: value.key,
    displayName: value.displayName,
    active: value.active,
    sortOrder: value.sortOrder,
    version: value.version,
  };
}

export function projectHrpSyncCatalog(raw: unknown): HrpSyncCatalogPayload | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["ok", "serverTime", "projects", "recruiters", "laborTypes"])
  ) {
    return null;
  }
  if (
    raw.ok !== true ||
    !isNonEmptyString(raw.serverTime) ||
    !Array.isArray(raw.projects) ||
    !Array.isArray(raw.recruiters) ||
    !Array.isArray(raw.laborTypes)
  ) {
    return null;
  }

  const projects: HrpCatalogProject[] = [];
  for (const item of raw.projects) {
    const projected = projectProjectItem(item);
    if (!projected) return null;
    projects.push(projected);
  }

  const recruiters: HrpCatalogRecruiter[] = [];
  for (const item of raw.recruiters) {
    const projected = projectRecruiterItem(item);
    if (!projected) return null;
    recruiters.push(projected);
  }

  const laborTypes: HrpCatalogLaborType[] = [];
  for (const item of raw.laborTypes) {
    const projected = projectLaborTypeItem(item);
    if (!projected) return null;
    laborTypes.push(projected);
  }

  return {
    ok: true,
    serverTime: raw.serverTime,
    projects,
    recruiters,
    laborTypes,
  };
}
