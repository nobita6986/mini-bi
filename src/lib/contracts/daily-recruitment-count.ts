import { z } from "zod";

/**
 * Contract `daily-recruitment-count/0.1` — báo cáo số người tuyển theo ngày.
 *
 * Tài liệu: docs/contracts/daily-recruitment-count-v0.1.md
 *
 * Lớp validation này là `early guard` phía ứng dụng/server (và cho test fixture).
 * NGUỒN CHÂN LÝ CUỐI CÙNG LÀ DATABASE: RPC public.replace_daily_recruitment_snapshot_v01
 * kiểm tra lại toàn bộ payload và là nơi quyết định chấp nhận/từ chối.
 * Hai lớp phải luôn được cập nhật cùng nhau khi contract đổi version.
 */

export const DAILY_RECRUITMENT_COUNT_CONTRACT_VERSION = "daily-recruitment-count/0.1";
export const DAILY_RECRUITMENT_TIMEZONE = "Asia/Ho_Chi_Minh";
export const DAILY_RECRUITMENT_RPC_NAME = "replace_daily_recruitment_snapshot_v01";

/** Trần số nguyên khớp với ràng buộc kiểm tra trong RPC (`^[0-9]{1,9}$`). */
export const DAILY_RECRUITMENT_MAX_COUNT = 999_999_999;

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
  "INVALID_DAILY_COUNTS",
  "INVALID_DATE",
  "INVALID_VALUE",
  "DUPLICATE_BUSINESS_DATE",
  "COUNT_MISMATCH",
  "RUN_SOURCE_MISMATCH",
  "DB_WRITE_FAILED",
  "UNEXPECTED_ERROR",
] as const;
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

const nonBlankString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "không được rỗng" });

const unsignedInt = z.int().min(0).max(DAILY_RECRUITMENT_MAX_COUNT);

/** ISO-8601 timestamp có offset tường minh (Z hoặc ±hh:mm). */
const iso8601WithOffset = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/;

const countEntrySchema = z.strictObject({
  business_date: z.iso.date(),
  recruited_count: unsignedInt,
});

export const dailyRecruitmentCountPayloadSchema = z
  .strictObject({
    contract_version: z.literal(DAILY_RECRUITMENT_COUNT_CONTRACT_VERSION),
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
    daily_counts: z.array(countEntrySchema),
  })
  .superRefine((payload, ctx) => {
    // R8: rows_valid + rows_rejected = rows_read
    if (payload.rows_valid + payload.rows_rejected !== payload.rows_read) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "rows_valid + rows_rejected phải bằng rows_read",
        params: { contractErrorCode: "ROWS_COUNT_MISMATCH" },
      });
    }

    const seen = new Set<string>();
    for (const [index, entry] of payload.daily_counts.entries()) {
      if (seen.has(entry.business_date)) {
        ctx.addIssue({
          code: "custom",
          path: ["daily_counts", index, "business_date"],
          message: "business_date xuất hiện nhiều lần trong cùng snapshot",
          params: { contractErrorCode: "DUPLICATE_BUSINESS_DATE" },
        });
      }
      seen.add(entry.business_date);
    }

    // R9: tổng recruited_count = rows_valid
    const total = payload.daily_counts.reduce((sum, entry) => sum + entry.recruited_count, 0);
    if (total !== payload.rows_valid) {
      ctx.addIssue({
        code: "custom",
        path: ["daily_counts"],
        message: "tổng recruited_count phải bằng rows_valid",
        params: { contractErrorCode: "COUNT_MISMATCH" },
      });
    }
  });

export type DailyRecruitmentCountPayload = z.infer<typeof dailyRecruitmentCountPayloadSchema>;
export type DailyRecruitmentCountEntry = z.infer<typeof countEntrySchema>;

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
  daily_counts: "INVALID_DAILY_COUNTS",
  business_date: "INVALID_DATE",
  recruited_count: "INVALID_VALUE",
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
  | { ok: true; payload: DailyRecruitmentCountPayload }
  | { ok: false; errorCode: ContractErrorCode; message: string };

/** Validate payload; trả về contract error code để so khớp với kết quả từ RPC. */
export function validateDailyRecruitmentCountPayload(input: unknown): PayloadValidationResult {
  const parsed = dailyRecruitmentCountPayloadSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, payload: parsed.data };
  }
  return {
    ok: false,
    errorCode: contractErrorCodeForIssues(parsed.error.issues),
    message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
  };
}
