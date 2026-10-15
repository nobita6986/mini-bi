/**
 * PRE-W2-HF Project↔Team authority (T1A) - Pure UI model for mapping admin.
 */
import {
  parseGrant,
  parseRevoke,
} from "./project-team-scope-contract.ts";
import {
  newIdempotencyKey,
  validateReason,
  validateUuid,
} from "../direct-entry/project-operations-model.ts";

export const MAPPING_PAGE_SIZE = 25;

export type MappingFilter = { projectId: string; includeHistory: boolean; page: number };

export function buildMappingListQuery(input: MappingFilter): URLSearchParams | null {
  if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1000) return null;
  const params = new URLSearchParams({ page: String(input.page), page_size: String(MAPPING_PAGE_SIZE) });
  if (input.projectId.trim()) params.set("project_id", input.projectId.trim());
  if (input.includeHistory) params.set("include_history", "true");
  return params;
}

export function buildGrantRequest(input: {
  projectId: string; teamId: string; expectedPairVersion: number;
  effectiveFrom: string; reason: string; idempotencyKey: string;
}): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const raw = {
    project_id: input.projectId.trim(), team_id: input.teamId,
    expected_pair_version: input.expectedPairVersion,
    effective_from: input.effectiveFrom || null,
    reason: input.reason, idempotency_key: input.idempotencyKey,
  };
  const parsed = parseGrant(raw);
  if (!parsed.ok) return { ok: false, message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { ok: true, body: raw };
}

export function buildRevokeRequest(input: {
  mappingId: string; expectedPairVersion: number;
  effectiveTo: string; reason: string; idempotencyKey: string;
}): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const raw = {
    mapping_id: input.mappingId, expected_pair_version: input.expectedPairVersion,
    effective_to: input.effectiveTo || null,
    reason: input.reason, idempotency_key: input.idempotencyKey,
  };
  const parsed = parseRevoke(raw);
  if (!parsed.ok) return { ok: false, message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { ok: true, body: raw };
}

export type MappingUiOutcome =
  | { kind: "applied"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

export function classifyMappingResponse(status: number): MappingUiOutcome {
  if (status === 200) return { kind: "applied", message: "Đã lưu thay đổi. Danh sách đang được cập nhật." };
  if (status === 401) return { kind: "denied", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 409) return { kind: "conflict", message: "Dữ liệu đã thay đổi ở nơi khác. Tải lại trước khi tiếp tục." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ." };
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng." };
}

export function newMappingKey(): string {
  return newIdempotencyKey();
}
