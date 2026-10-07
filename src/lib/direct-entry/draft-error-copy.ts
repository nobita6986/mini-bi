/**
 * P3-W07D: the single place that turns a sanitized direct-entry draft error code
 * into the copy an operator sees.
 *
 * The two server codes named by the W07D contract are rendered verbatim; every
 * other status keeps the pre-existing generic sentence. Callers pass a code that
 * `fail()` already sanitized, so no provider wording, SQL message, UUID or PII
 * can reach this text.
 */
export const DRAFT_SCOPE_DENIED = "DRAFT_SCOPE_DENIED";
export const DRAFTS_UNAVAILABLE = "DRAFTS_UNAVAILABLE";

export function draftLoadErrorMessage(code: string | null | undefined): string {
  if (code === DRAFT_SCOPE_DENIED) {
    return "Không tải được bản nháp do phạm vi quyền chưa phù hợp. Mã lỗi: DRAFT_SCOPE_DENIED.";
  }
  if (code === DRAFTS_UNAVAILABLE) {
    return "Không tải được bản nháp do máy chủ đang bận. Mã lỗi: DRAFTS_UNAVAILABLE.";
  }
  const fallback = typeof code === "string" && code.length > 0 ? code : DRAFTS_UNAVAILABLE;
  return "Không tải được Direct Entry (" + fallback + ").";
}
