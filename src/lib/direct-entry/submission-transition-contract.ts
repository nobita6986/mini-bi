/**
 * P1.6-W04-S04C-S01A - Hop dong chuyen trang thai submission (DRAFT/REVIEW/SUBMITTED).
 *
 * Pure validator + projection: khong I/O, khong doc session, khong goi DB.
 * Authority (capability, scope, OCC, idempotency) do RPC
 * public.direct_entry_transition_submission enforce - module nay KHONG tao authority thu hai.
 *
 * Ma tran trang thai da khoa o docs/contracts/p1.6-direct-entry-v1.md muc 4:
 *   DRAFT -> REVIEW
 *   REVIEW -> DRAFT
 *   REVIEW -> SUBMITTED
 *   SUBMITTED la terminal (khong transition tiep).
 * DRAFT -> SUBMITTED khong nam trong ma tran; DB trigger direct_entry_submission_transition
 * tu choi bang SQLSTATE 40001 nen application khong the bypass.
 */

export const SUBMISSION_STATES = ["DRAFT", "REVIEW", "SUBMITTED"] as const;

export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const SUBMISSION_TERMINAL_STATE: SubmissionState = "SUBMITTED";

/** Ma tran chuyen trang thai hop le (chi de kiem tra tinh dung dan, khong thay the DB). */
export const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionState, readonly SubmissionState[]>> =
  Object.freeze({
    DRAFT: Object.freeze(["REVIEW"] as const),
    REVIEW: Object.freeze(["DRAFT", "SUBMITTED"] as const),
    SUBMITTED: Object.freeze([] as const),
  });

export const SUBMISSION_TRANSITION_REQUEST_KEYS = [
  "expected_version",
  "target_state",
  "idempotency_key",
] as const;

/** RPC direct_entry_transition_submission tra ve dung ba truong nay (khong co reused/submitted_at). */
export const SUBMISSION_TRANSITION_RESULT_KEYS = [
  "submission_id",
  "state",
  "version",
] as const;

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Truong authority hoac truong dan xuat ma client KHONG duoc gui.
 * Gop tu danh sach W02 (auth_subject, app_user, app_user_id, actor, role, capability, scope, team,
 * provider, created_by, owner) va bo sung rieng cho transition (state, version, submitted_at, audit,
 * revision, timestamp). So sanh theo ten da chuan hoa: bo dau gach, chu thuong.
 */
const FORBIDDEN_CLIENT_FIELDS = new Set([
  "authsubject",
  "appuser",
  "appuserid",
  "userid",
  "sessionid",
  "actor",
  "actorid",
  "createdby",
  "createdbyuserid",
  "owner",
  "owneruserid",
  "role",
  "roles",
  "capability",
  "capabilities",
  "scope",
  "scopes",
  "scopekind",
  "team",
  "teamid",
  "provider",
  "providertype",
  "effectivescope",
  "effectivescopes",
  "selfrecruitersuggestion",
  "state",
  "version",
  "submissionversion",
  "expectedsubmissionversion",
  "submittedat",
  "submitted",
  "createdat",
  "updatedat",
  "audit",
  "auditevent",
  "auditeventid",
  "auditid",
  "revision",
  "revisionid",
  "revisionnumber",
  "tenant",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isSubmissionState(value: unknown): value is SubmissionState {
  return typeof value === "string" && SUBMISSION_STATES.some((state) => state === value);
}

export function isTerminalSubmissionState(value: unknown): boolean {
  return value === SUBMISSION_TERMINAL_STATE;
}

export function allowedTargetStates(from: unknown): readonly SubmissionState[] {
  return isSubmissionState(from) ? SUBMISSION_TRANSITIONS[from] : Object.freeze([] as const);
}

/** DRAFT -> SUBMITTED (va moi chuyen tu SUBMITTED) tra ve false. */
export function isAllowedTransition(from: unknown, to: unknown): boolean {
  if (!isSubmissionState(from) || !isSubmissionState(to)) return false;
  return SUBMISSION_TRANSITIONS[from].includes(to);
}

/**
 * Quet truong authority/derived o moi do sau. Tra ve duong dan truong vi pham hoac null.
 * Fail-closed: gap truong bi cam la tu choi, khong bo qua.
 */
export function findForbiddenClientField(value: unknown, path = ""): { field: string } | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findForbiddenClientField(value[index], path + "[" + index + "]");
      if (nested) return nested;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    const childPath = path === "" ? key : path + "." + key;
    if (FORBIDDEN_CLIENT_FIELDS.has(normalized)) return { field: childPath };
    const nested = findForbiddenClientField(child, childPath);
    if (nested) return nested;
  }
  return null;
}

export type SubmissionTransitionRequest = {
  expected_version: number;
  target_state: SubmissionState;
  idempotency_key: string;
};

export type SubmissionTransitionRequestProjection =
  | { ok: true; value: SubmissionTransitionRequest }
  | { ok: false; code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN"; field: string }
  | { ok: false; code: "SUBMISSION_TRANSITION_INVALID" };

export function projectSubmissionTransitionRequest(
  value: unknown,
): SubmissionTransitionRequestProjection {
  if (!isRecord(value)) return { ok: false, code: "SUBMISSION_TRANSITION_INVALID" };
  const forbidden = findForbiddenClientField(value);
  if (forbidden) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN", field: forbidden.field };
  }
  if (!hasExactKeys(value, SUBMISSION_TRANSITION_REQUEST_KEYS)) {
    return { ok: false, code: "SUBMISSION_TRANSITION_INVALID" };
  }
  const { expected_version: expectedVersion, target_state: targetState, idempotency_key: key } = value;
  if (!isPositiveVersion(expectedVersion)) return { ok: false, code: "SUBMISSION_TRANSITION_INVALID" };
  if (!isSubmissionState(targetState)) return { ok: false, code: "SUBMISSION_TRANSITION_INVALID" };
  if (typeof key !== "string") return { ok: false, code: "SUBMISSION_TRANSITION_INVALID" };
  if (key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { ok: false, code: "SUBMISSION_TRANSITION_INVALID" };
  }
  if (key.trim() === "" || hasControlCharacter(key)) {
    return { ok: false, code: "SUBMISSION_TRANSITION_INVALID" };
  }
  return {
    ok: true,
    value: {
      expected_version: expectedVersion,
      target_state: targetState,
      idempotency_key: key,
    },
  };
}

export type SubmissionTransitionResult = {
  submission_id: string;
  state: SubmissionState;
  version: number;
};

/**
 * Projection ket qua RPC: dung ba truong, submission_id khop yeu cau, state hop le,
 * va version phai bang expected_version + 1 (RPC tang version dung mot lan duoi OCC).
 * Bat ky sai khac nao (ke ca truong la) deu tra null de caller fail-closed.
 */
export function projectSubmissionTransitionResult(
  value: unknown,
  expected: { submission_id: string; expected_version: number },
): SubmissionTransitionResult | null {
  if (!isRecord(value) || !hasExactKeys(value, SUBMISSION_TRANSITION_RESULT_KEYS)) return null;
  if (typeof value.submission_id !== "string" || !UUID.test(value.submission_id)) return null;
  if (value.submission_id !== expected.submission_id) return null;
  if (!isSubmissionState(value.state)) return null;
  if (!isPositiveVersion(value.version)) return null;
  if (!isPositiveVersion(expected.expected_version)) return null;
  if (value.version !== expected.expected_version + 1) return null;
  return {
    submission_id: value.submission_id,
    state: value.state,
    version: value.version,
  };
}
