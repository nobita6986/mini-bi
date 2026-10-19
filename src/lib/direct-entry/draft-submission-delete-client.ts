/**
 * PRE-W2-HF - Client boundary cho "Xóa đợt nhập liệu" (submission DRAFT).
 *
 * Contract backend (PR #74):
 *   DELETE /api/direct-entry/submissions/{submissionId}
 *   headers: Content-Type: application/json, Idempotency-Key (1..128, khong control char)
 *   body   : { expected_version: <so nguyen duong> }
 *   200    : { ok, submission_id, deleted, version, entries_deleted, cleanup_objects_queued }
 *   400/401/403/404/409/500 theo ma da sanitize.
 *
 * LUU Y: day la xoa mem/tombstone phia server. `cleanup_objects_queued` chi la so muc trong
 * hang doi don dep, KHONG chung nhan object da bi xoa khoi storage. UI khong duoc noi khac.
 *
 * Client khong gui actor/role/capability/scope; server resolve tu session.
 */

export type DraftSubmissionDeleteResult =
  | {
      kind: "deleted";
      submissionId: string;
      version: number;
      entriesDeleted: number;
      cleanupObjectsQueued: number;
    }
  | { kind: "conflict"; code: "SUBMISSION_CONFLICT" | "SUBMISSION_PROCESSING" }
  | { kind: "rejected"; code: string }
  /** Loi tam thoi / ket qua khong xac dinh: giu ban nhap, thu lai cung Idempotency-Key. */
  | { kind: "retry"; code: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function codeOf(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.code === "string" && value.code.length > 0
    ? value.code
    : fallback;
}

function projectSuccess(value: unknown, submissionId: string): DraftSubmissionDeleteResult | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !==
      "cleanup_objects_queued,deleted,entries_deleted,ok,submission_id,version") return null;
  if (value.ok !== true || value.deleted !== true || value.submission_id !== submissionId) return null;
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) return null;
  if (!Number.isSafeInteger(value.entries_deleted) || (value.entries_deleted as number) < 0) return null;
  if (!Number.isSafeInteger(value.cleanup_objects_queued) ||
      (value.cleanup_objects_queued as number) < 0) return null;
  return {
    kind: "deleted",
    submissionId,
    version: value.version as number,
    entriesDeleted: value.entries_deleted as number,
    cleanupObjectsQueued: value.cleanup_objects_queued as number,
  };
}

export function isDraftSubmissionDeleteKey(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !CONTROL_CHARS.test(value);
}

export async function deleteDraftSubmission(input: {
  submissionId: string;
  expectedVersion: number;
  idempotencyKey: string;
  fetchImpl: FetchLike;
}): Promise<DraftSubmissionDeleteResult> {
  if (!UUID.test(input.submissionId) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      !isDraftSubmissionDeleteKey(input.idempotencyKey)) {
    return { kind: "rejected", code: "SUBMISSION_DELETE_INVALID" };
  }
  let response: Response;
  const callFetch = input.fetchImpl;
  try {
    response = await callFetch(
      `/api/direct-entry/submissions/${encodeURIComponent(input.submissionId)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({ expected_version: input.expectedVersion }),
      },
    );
  } catch {
    return { kind: "retry", code: "SUBMISSION_DELETE_NETWORK" };
  }
  const body = await readJson(response);
  if (response.status === 200) {
    return projectSuccess(body, input.submissionId) ??
      { kind: "retry", code: "SUBMISSION_DELETE_RESPONSE_INVALID" };
  }
  if (response.status >= 200 && response.status < 300) {
    return { kind: "retry", code: "SUBMISSION_DELETE_RESPONSE_INVALID" };
  }
  const code = codeOf(body, response.status >= 500
    ? "SUBMISSION_DELETE_UNAVAILABLE"
    : "SUBMISSION_DELETE_REJECTED");
  if (response.status >= 500) return { kind: "retry", code };
  if (response.status === 409 &&
      (code === "SUBMISSION_CONFLICT" || code === "SUBMISSION_PROCESSING")) {
    return { kind: "conflict", code };
  }
  return { kind: "rejected", code };
}

export function draftSubmissionDeleteErrorMessage(
  result: Exclude<DraftSubmissionDeleteResult, { kind: "deleted" }>,
): string {
  if (result.kind === "retry") {
    if (result.code === "SUBMISSION_DELETE_NETWORK") {
      return "Mất kết nối khi xóa. Chưa xác định được kết quả; đợt nhập liệu vẫn được giữ, hãy thử lại khi kết nối ổn định.";
    }
    if (result.code === "SUBMISSION_DELETE_RESPONSE_INVALID") {
      return "Phản hồi máy chủ chưa xác nhận việc xóa. Đợt nhập liệu vẫn được giữ; hãy tải lại danh sách để đồng bộ.";
    }
    return "Máy chủ chưa xác nhận việc xóa. Đợt nhập liệu vẫn được giữ; hãy thử lại, hệ thống dùng cùng yêu cầu.";
  }
  if (result.code === "SUBMISSION_CONFLICT") {
    return "Đợt nhập liệu đã thay đổi ở nơi khác. Đợt vẫn được giữ; hãy tải lại danh sách rồi thử lại.";
  }
  if (result.code === "SUBMISSION_PROCESSING") {
    return "Đợt nhập liệu đang được xử lý (gửi/duyệt) nên chưa xóa được. Đợt vẫn được giữ; hãy thử lại sau.";
  }
  if (result.code === "SUBMISSION_DELETE_DENIED") {
    return "Bạn không có quyền xóa đợt nhập liệu này. Đợt vẫn được giữ; hãy liên hệ quản trị nếu cần.";
  }
  if (result.code === "SUBMISSION_NOT_FOUND") {
    return "Không tìm thấy đợt nhập liệu trên máy chủ. Đợt vẫn được giữ cho tới khi tải lại danh sách thành công.";
  }
  if (result.code === "UNAUTHENTICATED") {
    return "Phiên làm việc đã hết hiệu lực. Đợt nhập liệu vẫn được giữ; hãy đăng nhập lại.";
  }
  if (result.code === "SUBMISSION_DELETE_INVALID") {
    return "Yêu cầu xóa không hợp lệ (thiếu phiên bản hoặc khóa chống gửi trùng). Đợt nhập liệu vẫn được giữ.";
  }
  return "Không xóa được đợt nhập liệu. Đợt vẫn được giữ; hãy thử lại.";
}
