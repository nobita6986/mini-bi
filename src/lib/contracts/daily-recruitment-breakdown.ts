import { z } from "zod";

/**
 * Contract `daily-recruitment-breakdown/0.2` (R1) — số người tuyển theo ngày và 4 chiều
 * phân loại: dự án, người tuyển, HRP/Vendor, loại hình lao động.
 *
 * Tài liệu: docs/contracts/daily-recruitment-breakdown-v0.2.md
 *
 * KHÔNG chứa và KHÔNG được chứa dữ liệu cá nhân ứng viên.
 *
 * Lớp validation này là `early guard` phía ứng dụng/server (và cho test fixture).
 * NGUỒN CHÂN LÝ CUỐI CÙNG LÀ DATABASE: RPC
 * public.replace_daily_recruitment_breakdown_snapshot_v02 và
 * public.record_recruitment_source_failure_v01 kiểm tra lại toàn bộ payload.
 * Hai lớp phải cập nhật cùng nhau khi đổi version.
 */

export const DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION = "daily-recruitment-breakdown/0.2";
export const DAILY_RECRUITMENT_TIMEZONE = "Asia/Ho_Chi_Minh";
export const DAILY_RECRUITMENT_BREAKDOWN_RPC_NAME = "replace_daily_recruitment_breakdown_snapshot_v02";
export const RECRUITMENT_SOURCE_FAILURE_RPC_NAME = "record_recruitment_source_failure_v01";

/** Sentinel quy ước cho chiều phân loại thiếu/rỗng và ngoài danh mục. */
export const UNKNOWN_DIMENSION_KEY = "__unknown__";
export const UNKNOWN_DIMENSION_DISPLAY = "Không xác định";
export const INVALID_DIMENSION_KEY = "__invalid__";
export const INVALID_DIMENSION_DISPLAY = "Không hợp lệ";

/** Trần số nguyên khớp ràng buộc kiểm tra trong RPC (`^[0-9]{1,9}$`). */
export const DAILY_RECRUITMENT_MAX_COUNT = 999_999_999;
/** Trần độ dài chuỗi phân loại, khớp CHECK constraint của bảng. */
export const MAX_DIMENSION_LENGTH = 200;

export const DIMENSION_FIELDS = ["project", "recruiter", "provider_type", "employment_type"] as const;
export type DimensionField = (typeof DIMENSION_FIELDS)[number];

export const TRIGGER_TYPES = ["manual", "schedule", "bot"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Danh mục HRP/Vendor (cột J). */
export const PROVIDER_TYPE_CATALOG = [
  { key: "hrp", display: "HRP" },
  { key: "vendor", display: "Vendor" },
] as const;

/** Danh mục loại hình lao động (cột L). */
export const EMPLOYMENT_TYPE_CATALOG = [
  { key: "thời vụ", display: "Thời vụ" },
  { key: "chính thức", display: "Chính thức" },
] as const;

export const ROW_ISSUE_LEVELS = ["error", "warning"] as const;
export type RowIssueLevel = (typeof ROW_ISSUE_LEVELS)[number];

export const ROW_ISSUE_ERROR_CODES = ["MISSING_DATE", "INVALID_DATE"] as const;
export const ROW_ISSUE_WARNING_CODES = ["INVALID_PROVIDER_TYPE", "INVALID_EMPLOYMENT_TYPE"] as const;
export type RowIssueCode = (typeof ROW_ISSUE_ERROR_CODES)[number] | (typeof ROW_ISSUE_WARNING_CODES)[number];

/** Mã lỗi đọc nguồn cho record_recruitment_source_failure_v01. */
export const SOURCE_FAILURE_ERROR_CODES = [
  "FILE_NOT_NATIVE_SHEET",
  "SHEET_NOT_FOUND",
  "INVALID_HEADER",
  "SOURCE_READ_FAILED",
] as const;
export type SourceFailureErrorCode = (typeof SOURCE_FAILURE_ERROR_CODES)[number];

export const CONTRACT_ERROR_CODES = [
  "INVALID_PAYLOAD",
  "UNSUPPORTED_CONTRACT_VERSION",
  "UNKNOWN_FIELD",
  "MISSING_DRIVE_FILE_ID",
  "MISSING_FILE_NAME",
  "MISSING_SHEET_NAME",
  "INVALID_SYNC_RUN_ID",
  "INVALID_TRIGGER_TYPE",
  "INVALID_SNAPSHOT_AT",
  "UNSUPPORTED_TIMEZONE",
  "INVALID_COUNTS",
  "ROWS_COUNT_MISMATCH",
  "INVALID_ROW_ISSUES",
  "DUPLICATE_ROW_ISSUE",
  "INVALID_BREAKDOWN",
  "INVALID_DIMENSION",
  "INVALID_DATE",
  "INVALID_VALUE",
  "DUPLICATE_GRAIN_KEY",
  "COUNT_MISMATCH",
  "INVALID_WARNING_COUNTS",
  "REJECTED_COUNT_MISMATCH",
  "WARNING_COUNT_MISMATCH",
  "MIXED_ROW_ISSUE_LEVEL",
  "ISSUE_LINKAGE_MISMATCH",
  "RUN_SOURCE_MISMATCH",
  "UNSUPPORTED_SOURCE_ERROR_CODE",
  "DB_WRITE_FAILED",
  "UNEXPECTED_ERROR",
] as const;
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

/**
 * Chuẩn hóa display value free text: NFC, trim, gộp khoảng trắng liên tiếp thành một space.
 * Giữ nguyên chữ hoa/thường. Chuỗi rỗng sau chuẩn hóa => null.
 * Mirror của public.recruitment_dimension_display(text).
 */
export function normalizeDimensionDisplay(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/**
 * Khóa gộp nhóm free text: như display nhưng lowercase.
 * Không bỏ dấu, không map alias, không suy luận.
 * Mirror của public.recruitment_dimension_key(text).
 */
export function normalizeDimensionKey(value: string | null | undefined): string | null {
  const display = normalizeDimensionDisplay(value);
  return display === null ? null : display.toLowerCase();
}

/** Key free text (project/recruiter) với sentinel __unknown__ khi thiếu/rỗng. */
export function dimensionKeyOrUnknown(value: string | null | undefined): string {
  return normalizeDimensionKey(value) ?? UNKNOWN_DIMENSION_KEY;
}

/** Display free text (project/recruiter) với "Không xác định" khi thiếu/rỗng. */
export function dimensionDisplayOrUnknown(value: string | null | undefined): string {
  return normalizeDimensionDisplay(value) ?? UNKNOWN_DIMENSION_DISPLAY;
}

/** Mirror của public.recruitment_provider_type_key(text). */
export function canonicalProviderTypeKey(value: string | null | undefined): string {
  const key = normalizeDimensionKey(value);
  if (key === null) return UNKNOWN_DIMENSION_KEY;
  return PROVIDER_TYPE_CATALOG.some((entry) => entry.key === key) ? key : INVALID_DIMENSION_KEY;
}

/** Mirror của public.recruitment_provider_type_display(text): display suy TỪ key. */
export function canonicalProviderTypeDisplay(value: string | null | undefined): string {
  const key = canonicalProviderTypeKey(value);
  if (key === UNKNOWN_DIMENSION_KEY) return UNKNOWN_DIMENSION_DISPLAY;
  if (key === INVALID_DIMENSION_KEY) return INVALID_DIMENSION_DISPLAY;
  return PROVIDER_TYPE_CATALOG.find((entry) => entry.key === key)?.display ?? INVALID_DIMENSION_DISPLAY;
}

/** Mirror của public.recruitment_employment_type_key(text). */
export function canonicalEmploymentTypeKey(value: string | null | undefined): string {
  const key = normalizeDimensionKey(value);
  if (key === null) return UNKNOWN_DIMENSION_KEY;
  return EMPLOYMENT_TYPE_CATALOG.some((entry) => entry.key === key) ? key : INVALID_DIMENSION_KEY;
}

/** Mirror của public.recruitment_employment_type_display(text): display suy TỪ key. */
export function canonicalEmploymentTypeDisplay(value: string | null | undefined): string {
  const key = canonicalEmploymentTypeKey(value);
  if (key === UNKNOWN_DIMENSION_KEY) return UNKNOWN_DIMENSION_DISPLAY;
  if (key === INVALID_DIMENSION_KEY) return INVALID_DIMENSION_DISPLAY;
  return EMPLOYMENT_TYPE_CATALOG.find((entry) => entry.key === key)?.display ?? INVALID_DIMENSION_DISPLAY;
}

/** Khóa grain sau chuẩn hóa: dùng để phát hiện trùng trong cùng snapshot. */
export function grainKey(entry: {
  business_date: string;
  project?: string | null;
  recruiter?: string | null;
  provider_type?: string | null;
  employment_type?: string | null;
}): string {
  return [
    entry.business_date,
    dimensionKeyOrUnknown(entry.project),
    dimensionKeyOrUnknown(entry.recruiter),
    canonicalProviderTypeKey(entry.provider_type),
    canonicalEmploymentTypeKey(entry.employment_type),
  ].join("|");
}

const nonBlankString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "không được rỗng" });

const unsignedInt = z.int().min(0).max(DAILY_RECRUITMENT_MAX_COUNT);
const uuidV4 = z.uuid({ version: "v4" });

/** Chiều phân loại: được phép thiếu hoặc null (=> "Không xác định"). */
const dimensionSchema = z.string().max(MAX_DIMENSION_LENGTH).nullable().optional();

const iso8601WithOffset = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;
const snapshotAtSchema = z
  .string()
  .regex(iso8601WithOffset, { message: "phải là timestamp ISO-8601 có offset (ví dụ 2026-10-01T09:30:00Z)" })
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "không parse được thành timestamp" });

export const breakdownEntrySchema = z.strictObject({
  business_date: z.iso.date(),
  recruited_count: unsignedInt,
  project: dimensionSchema,
  recruiter: dimensionSchema,
  provider_type: dimensionSchema,
  employment_type: dimensionSchema,
});

/**
 * Một issue mức hàng nguồn. CHỈ được chứa 3 field này.
 * Không nhận raw value, tên ứng viên hay bất kỳ dữ liệu PII nào.
 */
export const rowIssueSchema = z
  .strictObject({
    source_row_number: z.int().min(1).max(DAILY_RECRUITMENT_MAX_COUNT),
    issue_level: z.enum(ROW_ISSUE_LEVELS),
    error_code: z.enum([...ROW_ISSUE_ERROR_CODES, ...ROW_ISSUE_WARNING_CODES]),
  })
  .refine(
    (issue) =>
      issue.issue_level === "error"
        ? (ROW_ISSUE_ERROR_CODES as readonly string[]).includes(issue.error_code)
        : (ROW_ISSUE_WARNING_CODES as readonly string[]).includes(issue.error_code),
    { message: "error_code không khớp với issue_level" }
  );

const envelopeShape = {
  contract_version: z.literal(DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION),
  drive_file_id: nonBlankString(255),
  file_name: nonBlankString(512),
  sheet_name: nonBlankString(255),
  sync_run_id: uuidV4,
  trigger_type: z.enum(TRIGGER_TYPES),
  snapshot_at: snapshotAtSchema,
  timezone: z.literal(DAILY_RECRUITMENT_TIMEZONE),
};

export const dailyRecruitmentBreakdownPayloadSchema = z
  .strictObject({
    ...envelopeShape,
    rows_read: unsignedInt,
    rows_valid: unsignedInt,
    rows_rejected: unsignedInt,
    rows_warned: unsignedInt,
    warning_issues: unsignedInt,
    row_issues: z.array(rowIssueSchema),
    breakdown: z.array(breakdownEntrySchema),
  })
  .superRefine((payload, ctx) => {
    const issue = (path: PropertyKey[], message: string, contractErrorCode: ContractErrorCode) =>
      ctx.addIssue({ code: "custom", path, message, params: { contractErrorCode } });

    // Thứ tự kiểm tra phải khớp RPC để hai lớp trả cùng error code.
    // 1) Trùng khóa grain sau chuẩn hóa
    const seen = new Set<string>();
    for (const [index, entry] of payload.breakdown.entries()) {
      const key = grainKey(entry);
      if (seen.has(key)) {
        issue(
          ["breakdown", index],
          "cùng một tổ hợp (ngày, dự án, người tuyển, HRP/Vendor, loại hình) xuất hiện nhiều lần sau chuẩn hóa",
          "DUPLICATE_GRAIN_KEY"
        );
      }
      seen.add(key);
    }

    const errorRows = new Set<number>();
    const warnRows = new Set<number>();
    let warningCount = 0;
    const warningCodes = new Set<string>();
    for (const rowIssue of payload.row_issues) {
      if (rowIssue.issue_level === "error") errorRows.add(rowIssue.source_row_number);
      else {
        warnRows.add(rowIssue.source_row_number);
        warningCount += 1;
        warningCodes.add(rowIssue.error_code);
      }
    }

    const hasInvalidProvider = payload.breakdown.some(
      (entry) => canonicalProviderTypeKey(entry.provider_type) === INVALID_DIMENSION_KEY
    );
    const hasInvalidEmployment = payload.breakdown.some(
      (entry) => canonicalEmploymentTypeKey(entry.employment_type) === INVALID_DIMENSION_KEY
    );

    // 2) rows_read = rows_valid + rows_rejected
    if (payload.rows_valid + payload.rows_rejected !== payload.rows_read) {
      issue([], "rows_valid + rows_rejected phải bằng rows_read", "ROWS_COUNT_MISMATCH");
    }

    // 3) tổng breakdown = rows_valid
    const total = payload.breakdown.reduce((sum, entry) => sum + entry.recruited_count, 0);
    if (total !== payload.rows_valid) {
      issue(["breakdown"], "tổng recruited_count phải bằng rows_valid", "COUNT_MISMATCH");
    }

    // 4) rows_warned <= rows_valid
    if (payload.rows_warned > payload.rows_valid) {
      issue(["rows_warned"], "rows_warned phải nhỏ hơn hoặc bằng rows_valid", "INVALID_WARNING_COUNTS");
    }

    // 5) rows_rejected = số row khác nhau có issue_level=error
    if (payload.rows_rejected !== errorRows.size) {
      issue(
        ["rows_rejected"],
        "rows_rejected phải bằng số source_row_number khác nhau có issue_level=error",
        "REJECTED_COUNT_MISMATCH"
      );
    }

    // 6) rows_warned / warning_issues phải khớp row_issues
    if (payload.rows_warned !== warnRows.size || payload.warning_issues !== warningCount) {
      issue(["warning_issues"], "rows_warned/warning_issues không khớp với row_issues", "WARNING_COUNT_MISMATCH");
    }

    // 7) một hàng không thể vừa bị loại vừa được cảnh báo
    for (const row of warnRows) {
      if (errorRows.has(row)) {
        issue(["row_issues"], "một hàng không thể vừa bị loại vừa được cảnh báo", "MIXED_ROW_ISSUE_LEVEL");
        break;
      }
    }

    // 8) nhóm __invalid__ và cảnh báo tương ứng phải xuất hiện cùng nhau
    if (hasInvalidProvider !== warningCodes.has("INVALID_PROVIDER_TYPE")) {
      issue(
        ["row_issues"],
        "nhóm __invalid__ của HRP/Vendor và cảnh báo INVALID_PROVIDER_TYPE phải xuất hiện cùng nhau",
        "ISSUE_LINKAGE_MISMATCH"
      );
    }
    if (hasInvalidEmployment !== warningCodes.has("INVALID_EMPLOYMENT_TYPE")) {
      issue(
        ["row_issues"],
        "nhóm __invalid__ của loại hình và cảnh báo INVALID_EMPLOYMENT_TYPE phải xuất hiện cùng nhau",
        "ISSUE_LINKAGE_MISMATCH"
      );
    }
  });

/**
 * Payload cho record_recruitment_source_failure_v01.
 * Không có counts và không có breakdown: nguồn không đọc được thì không có snapshot.
 */
export const recruitmentSourceFailurePayloadSchema = z.strictObject({
  ...envelopeShape,
  error_code: z.enum(SOURCE_FAILURE_ERROR_CODES),
  sanitized_reason: z.string().max(500).nullable().optional(),
});

export type DailyRecruitmentBreakdownPayload = z.infer<typeof dailyRecruitmentBreakdownPayloadSchema>;
export type BreakdownEntry = z.infer<typeof breakdownEntrySchema>;
export type RowIssue = z.infer<typeof rowIssueSchema>;
export type RecruitmentSourceFailurePayload = z.infer<typeof recruitmentSourceFailurePayloadSchema>;

const PATH_ERROR_CODES: Record<string, ContractErrorCode> = {
  contract_version: "UNSUPPORTED_CONTRACT_VERSION",
  drive_file_id: "MISSING_DRIVE_FILE_ID",
  file_name: "MISSING_FILE_NAME",
  sheet_name: "MISSING_SHEET_NAME",
  sync_run_id: "INVALID_SYNC_RUN_ID",
  trigger_type: "INVALID_TRIGGER_TYPE",
  snapshot_at: "INVALID_SNAPSHOT_AT",
  timezone: "UNSUPPORTED_TIMEZONE",
  rows_read: "INVALID_COUNTS",
  rows_valid: "INVALID_COUNTS",
  rows_rejected: "INVALID_COUNTS",
  rows_warned: "INVALID_WARNING_COUNTS",
  warning_issues: "WARNING_COUNT_MISMATCH",
  row_issues: "INVALID_ROW_ISSUES",
  breakdown: "INVALID_BREAKDOWN",
  business_date: "INVALID_DATE",
  recruited_count: "INVALID_VALUE",
  project: "INVALID_DIMENSION",
  recruiter: "INVALID_DIMENSION",
  provider_type: "INVALID_DIMENSION",
  employment_type: "INVALID_DIMENSION",
  source_row_number: "INVALID_ROW_ISSUES",
  issue_level: "INVALID_ROW_ISSUES",
  error_code: "INVALID_ROW_ISSUES",
};

/** Suy ra contract error code tương ứng với issue đầu tiên, để đối chiếu với RPC. */
export function contractErrorCodeForIssues(
  issues: readonly { code: string; path: PropertyKey[]; params?: Record<string, unknown> }[]
): ContractErrorCode {
  const first = issues[0];
  if (!first) return "UNEXPECTED_ERROR";

  const explicit = first.params?.contractErrorCode;
  if (typeof explicit === "string" && (CONTRACT_ERROR_CODES as readonly string[]).includes(explicit)) {
    return explicit as ContractErrorCode;
  }

  if (first.code === "unrecognized_keys") return "UNKNOWN_FIELD";

  for (let index = first.path.length - 1; index >= 0; index -= 1) {
    const segment = first.path[index];
    if (typeof segment === "string" && segment in PATH_ERROR_CODES) {
      return PATH_ERROR_CODES[segment];
    }
  }

  return "INVALID_PAYLOAD";
}

export type PayloadValidationResult =
  | { ok: true; payload: DailyRecruitmentBreakdownPayload }
  | { ok: false; errorCode: ContractErrorCode; message: string };

function toValidationResult(parsed: {
  success: boolean;
  data?: unknown;
  error?: { issues: readonly { code: string; path: PropertyKey[]; params?: Record<string, unknown>; message: string }[] };
}): PayloadValidationResult {
  if (parsed.success) {
    return { ok: true, payload: parsed.data as DailyRecruitmentBreakdownPayload };
  }
  const issues = parsed.error?.issues ?? [];
  return {
    ok: false,
    errorCode: contractErrorCodeForIssues(issues),
    message: issues.map((issue) => (issue.path.join(".") || "(root)") + ": " + issue.message).join("; "),
  };
}

/** Validate payload snapshot; trả contract error code để so khớp với RPC. */
export function validateDailyRecruitmentBreakdownPayload(input: unknown): PayloadValidationResult {
  return toValidationResult(dailyRecruitmentBreakdownPayloadSchema.safeParse(input));
}

/** Validate payload lỗi nguồn. */
export function validateRecruitmentSourceFailurePayload(input: unknown): PayloadValidationResult {
  return toValidationResult(recruitmentSourceFailurePayloadSchema.safeParse(input));
}
