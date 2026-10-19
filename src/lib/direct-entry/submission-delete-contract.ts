export const SUBMISSION_DELETE_REQUEST_KEYS = ["expected_version"] as const;
export const SUBMISSION_DELETE_RESULT_KEYS = [
  "cleanup_objects_queued",
  "deleted",
  "entries_deleted",
  "submission_id",
  "version",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

export function projectSubmissionDeleteRequest(
  value: unknown,
): { expected_version: number } | null {
  if (!isRecord(value) || !exactKeys(value, SUBMISSION_DELETE_REQUEST_KEYS) ||
      typeof value.expected_version !== "number" ||
      !Number.isSafeInteger(value.expected_version) || value.expected_version < 1) return null;
  return { expected_version: value.expected_version };
}

export type SubmissionDeleteResult = {
  submission_id: string;
  deleted: true;
  version: number;
  entries_deleted: number;
  cleanup_objects_queued: number;
};

export function projectSubmissionDeleteResult(
  value: unknown,
  expected: { submission_id: string; expected_version: number },
): SubmissionDeleteResult | null {
  if (!isRecord(value) || !exactKeys(value, SUBMISSION_DELETE_RESULT_KEYS) ||
      value.submission_id !== expected.submission_id || !UUID.test(expected.submission_id) ||
      value.deleted !== true || value.version !== expected.expected_version + 1 ||
      !Number.isSafeInteger(value.version) ||
      typeof value.entries_deleted !== "number" || !Number.isSafeInteger(value.entries_deleted) ||
      value.entries_deleted < 0 ||
      typeof value.cleanup_objects_queued !== "number" ||
      !Number.isSafeInteger(value.cleanup_objects_queued) || value.cleanup_objects_queued < 0) {
    return null;
  }
  return {
    submission_id: expected.submission_id,
    deleted: true,
    version: value.version,
    entries_deleted: value.entries_deleted,
    cleanup_objects_queued: value.cleanup_objects_queued,
  };
}
