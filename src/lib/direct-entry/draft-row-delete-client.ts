export type DraftRowDeleteResult =
  | { kind: "deleted"; entryId: string; entryVersion: number }
  | { kind: "conflict"; code: "DRAFT_CONFLICT" | "DRAFT_FINAL_ROW" }
  | { kind: "rejected"; code: string }
  | { kind: "retry"; code: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

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

function projectSuccess(value: unknown, entryId: string): DraftRowDeleteResult | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !==
      "deleted,entry_id,entry_version,ok") return null;
  if (value.ok !== true || value.deleted !== true || value.entry_id !== entryId ||
      typeof value.entry_version !== "number" || !Number.isSafeInteger(value.entry_version) ||
      value.entry_version < 1) return null;
  return { kind: "deleted", entryId, entryVersion: value.entry_version };
}

export async function deleteDraftRow(input: {
  entryId: string;
  expectedVersion: number;
  idempotencyKey: string;
  fetchImpl: FetchLike;
}): Promise<DraftRowDeleteResult> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      input.idempotencyKey.trim() === "" || input.idempotencyKey.length > 128) {
    return { kind: "rejected", code: "DRAFT_DELETE_INVALID" };
  }
  let response: Response;
  const callFetch = input.fetchImpl;
  try {
    response = await callFetch(
      `/api/direct-entry/entries/${encodeURIComponent(input.entryId)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({ expected_version: input.expectedVersion }),
      },
    );
  } catch {
    return { kind: "retry", code: "DRAFT_DELETE_NETWORK" };
  }
  const body = await readJson(response);
  if (response.status === 200) {
    return projectSuccess(body, input.entryId) ??
      { kind: "retry", code: "DRAFT_DELETE_RESPONSE_INVALID" };
  }
  if (response.status >= 200 && response.status < 300) {
    return { kind: "retry", code: "DRAFT_DELETE_RESPONSE_INVALID" };
  }
  const code = codeOf(body, response.status >= 500
    ? "DRAFT_DELETE_UNAVAILABLE"
    : "DRAFT_DELETE_REJECTED");
  if (response.status >= 500) return { kind: "retry", code };
  if (response.status === 409 && (code === "DRAFT_CONFLICT" || code === "DRAFT_FINAL_ROW")) {
    return { kind: "conflict", code };
  }
  return { kind: "rejected", code };
}

export function draftRowDeleteErrorMessage(result: Exclude<DraftRowDeleteResult, { kind: "deleted" }>): string {
  if (result.kind === "retry") {
    if (result.code === "DRAFT_DELETE_NETWORK") {
      return "Mất kết nối khi xóa. Chưa xác định được kết quả; dòng vẫn được giữ, hãy thử lại khi kết nối ổn định.";
    }
    if (result.code === "DRAFT_DELETE_UNAVAILABLE") {
      return "Máy chủ chưa xác nhận việc xóa. Dòng vẫn được giữ; hãy thử lại, hệ thống sẽ dùng cùng yêu cầu.";
    }
    if (result.code === "DRAFT_DELETE_RESPONSE_INVALID") {
      return "Phản hồi máy chủ chưa xác nhận việc xóa. Dòng vẫn được giữ; hãy tải lại bản nháp để đồng bộ.";
    }
    return "Chưa xác định được kết quả xóa. Dòng vẫn được giữ; hãy thử lại.";
  }
  if (result.code === "DRAFT_FINAL_ROW") return "Không thể xóa hàng cuối của bản nháp.";
  if (result.code === "DRAFT_CONFLICT") {
    return "Dữ liệu đã thay đổi ở nơi khác. Dòng vẫn được giữ; hãy tải lại bản nháp.";
  }
  if (result.code === "ACTOR_DENIED") return "Bạn không còn quyền xóa dòng này.";
  if (result.code === "ENTRY_NOT_FOUND") {
    return "Không tìm thấy dòng trên máy chủ. Dòng vẫn được giữ cho tới khi tải lại thành công.";
  }
  return "Không xóa được dòng. Dữ liệu vẫn được giữ; hãy thử lại.";
}
