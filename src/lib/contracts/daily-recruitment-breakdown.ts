import { z } from "zod";

/**
 * Contract `daily-recruitment-breakdown/0.2` — số người tuyển theo ngày và 4 chiều
 * phân loại: dự án, người tuyển, HRP/Vendor, loại hình làm việc.
 *
 * Tài liệu: docs/contracts/daily-recruitment-breakdown-v0.2.md
 *
 * KHÔNG chứa và KHÔNG được chứa dữ liệu cá nhân ứng viên.
 *
 * Lớp validation này là `early guard` phía ứng dụng/server (và cho test fixture).
 * NGUỒN CHÂN LÝ CUỐI CÙNG LÀ DATABASE: RPC
 * public.replace_daily_recruitment_breakdown_snapshot_v02 kiểm tra lại toàn bộ payload
 * và là nơi quyết định chấp nhận/từ chối. Hai lớp phải cập nhật cùng nhau khi đổi version.
 */

export const DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION = "daily-recruitment-breakdown/0.2";
export const DAILY_RECRUITMENT_TIMEZONE = "Asia/Ho_Chi_Minh";
export const DAILY_RECRUITMENT_BREAKDOWN_RPC_NAME = "replace_daily_recruitment_breakdown_snapshot_v02";

/** Giá trị quy ước cho chiều phân loại thiếu/rỗng. Xem contract §5. */
export const UNKNOWN_DIMENSION_KEY = "__unknown__";
export const UNKNOWN_DIMENSION_DISPLAY = "Không xác định";

/** Trần số nguyên khớp ràng buộc kiểm tra trong RPC (`^[0-9]{1,9}$`). */
export const DAILY_RECRUITMENT_MAX_COUNT = 999_999_999;
/** Trần độ dài chuỗi phân loại, khớp CHECK constraint của bảng. */
export const MAX_DIMENSION_LENGTH = 200;

export const DIMENSION_FIELDS = ["project", "recruiter", "provider_type", "employment_type"] as const;
export type DimensionField = (typeof DIMENSION_FIELDS)[number];

export const TRIGGER_TYPES = ["manual", "schedule", "bot"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

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
  "INVALID_BREAKDOWN",
  "INVALID_DIMENSION",
  "INVALID_DATE",
  "INVALID_VALUE",
  "DUPLICATE_GRAIN_KEY",
  "COUNT_MISMATCH",
  "RUN_SOURCE_MISMATCH",
  "DB_WRITE_FAILED",
  "UNEXPECTED_ERROR",
] as const;
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

/**
 * Chuẩn hóa display value: NFC, trim, gộp khoảng trắng liên tiếp thành một space.
 * Giữ nguyên chữ hoa/thường. Chuỗi rỗng sau chuẩn hóa => null.
 * Mirror của public.recruitment_dimension_display(text) trong database.
 */
export function normalizeDimensionDisplay(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/**
 * Khóa gộp nhóm: như display nhưng lowercase. Không bỏ dấu, không map alias, không suy luận.
 * Mirror của public.recruitment_dimension_key(text) trong database.
 */
export function normalizeDimensionKey(value: string | null | undefined): string | null {
  const display = normalizeDimensionDisplay(value);
  return display === null ? null : display.toLowerCase();
}

/** Key dùng để gộp nhóm, đã quy về giá trị quy ước khi thiếu/rỗng. */
export function dimensionKeyOrUnknown(value: string | null | undefined): string {
  return normalizeDimensionKey(value) ?? UNKNOWN_DIMENSION_KEY;
}

/** Display dùng để hiển thị, đã quy về "Không xác định" khi thiếu/rỗng. */
export function dimensionDisplayOrUnknown(value: string | null | undefined): string {
  return normalizeDimensionDisplay(value) ?? UNKNOWN_DIMENSION_DISPLAY;
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
    dimensionKeyOrUnknown(entry.provider_type),
    dimensionKeyOrUnknown(entry.employment_type),
  ].join("|");
}

const nonBlankString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "không được rỗng" });

const unsignedInt = z.int().min(0).max(DAILY_RECRUITMENT_MAX_COUNT);

/** Chiều phân loại: được phép thiếu hoặc null (=> "Không xác định"). */
const dimensionSchema = z.string().max(MAX_DIMENSION_LENGTH).nullable().optional();

const iso8601WithOffset = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;

export const breakdownEntrySchema = z.strictObject({
  business_date: z.iso.date(),
  recruited_count: unsignedInt,
  project: dimensionSchema,
  recruiter: dimensionSchema,
  provider_type: dimensionSchema,
  employment_type: dimensionSchema,
});

export const dailyRecruitmentBreakdownPayloadSchema = z
  .strictObject({
    contract_version: z.literal(DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION),
    drive_file_id: nonBlankString(255),
    file_name: nonBlankString(512),
    sheet_name: nonBlankString(255),
    sync_run_id: z.uuid(),
    trigger_type: z.enum(TRIGGER_TYPES),
    snapshot_at: z
      .string()
      .regex(iso8601WithOffset, { message: "phải là timestamp ISO-8601 có offset (ví dụ 2026-10-01T09:30:00Z)" })
      .refine((value) => !Number.isNaN(Date.parse(value)), { message: "không parse được thành timestamp" }),
    timezone: z.literal(DAILY_RECRUITMENT_TIMEZONE),
    rows_read: unsignedInt,
    rows_valid: unsignedInt,
    rows_rejected: unsignedInt,
    breakdown: z.array(breakdownEntrySchema),
  })
  .superRefine((payload, ctx) => {
    if (payload.rows_valid + payload.rows_rejected !== payload.rows_read) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "rows_valid + rows_rejected phải bằng rows_read",
        params: { contractErrorCode: "ROWS_COUNT_MISMATCH" },
      });
    }

    const seen = new Set<string>();
    for (const [index, entry] of payload.breakdown.entries()) {
      const key = grainKey(entry);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["breakdown", index],
          message:
            "cùng một tổ hợp (ngày, dự án, người tuyển, HRP/Vendor, loại hình) xuất hiện nhiều lần sau chuẩn hóa",
          params: { contractErrorCode: "DUPLICATE_GRAIN_KEY" },
        });
      }
      seen.add(key);
    }

    const total = payload.breakdown.reduce((sum, entry) => sum + entry.recruited_count, 0);
    if (total !== payload.rows_valid) {
      ctx.addIssue({
        code: "custom",
        path: ["breakdown"],
        message: "tổng recruited_count phải bằng rows_valid",
        params: { contractErrorCode: "COUNT_MISMATCH" },
      });
    }
  });

export type DailyRecruitmentBreakdownPayload = z.infer<typeof dailyRecruitmentBreakdownPayloadSchema>;
export type BreakdownEntry = z.infer<typeof breakdownEntrySchema>;

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
  breakdown: "INVALID_BREAKDOWN",
  business_date: "INVALID_DATE",
  recruited_count: "INVALID_VALUE",
  project: "INVALID_DIMENSION",
  recruiter: "INVALID_DIMENSION",
  provider_type: "INVALID_DIMENSION",
  employment_type: "INVALID_DIMENSION",
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

/** Validate payload; trả về contract error code để so khớp với kết quả từ RPC. */
export function validateDailyRecruitmentBreakdownPayload(input: unknown): PayloadValidationResult {
  const parsed = dailyRecruitmentBreakdownPayloadSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, payload: parsed.data };
  }
  return {
    ok: false,
    errorCode: contractErrorCodeForIssues(parsed.error.issues),
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
  };
}
