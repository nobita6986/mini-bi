/**
 * P3-W05A-R3 - DB-authorized source filter validation (pure).
 *
 * The legacy source filter is only valid for a DB-confirmed `all` audience
 * AND only for sources present in the DB-provided active/non-test allowlist.
 * An unknown / test / inactive source must be rejected as INVALID_FILTER rather
 * than silently producing an empty report. own/team ignore the source filter
 * (handled by the caller, see R2).
 */

// Mirrors `p1-filter.ts::INVALID_FILTER_CODE` so this leaf module stays
// importable by node:test (Node ESM does not resolve extensionless .ts imports).
const INVALID_FILTER_CODE = "INVALID_FILTER";

export const SOURCE_OUT_OF_SCOPE_MESSAGE = "source không thuộc reporting scope";

export type SourceFilterCheck =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Validate a legacy source filter against the DB-authoritative allowlist
 * (active/non-test source ids). Returns ok when the source is unset or in the
 * allowlist; otherwise returns the existing INVALID_FILTER contract.
 */
export function validateAllSourceFilter(params: {
  source: string | undefined;
  allowlist: readonly string[];
}): SourceFilterCheck {
  if (params.source === undefined) return { ok: true };
  if (!params.allowlist.includes(params.source)) {
    return { ok: false, code: INVALID_FILTER_CODE, message: SOURCE_OUT_OF_SCOPE_MESSAGE };
  }
  return { ok: true };
}

