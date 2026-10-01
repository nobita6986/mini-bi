/**
 * Deployment safety cho route /pipeline-check (P0-T1-W04-R2).
 *
 * KHÔNG phải authentication/authorization. Chỉ chống vô tình public route vận hành
 * khi chạy production. Khi dùng dữ liệu thật cho BoD, vẫn bắt buộc triển khai
 * access gate tại P1-W03.
 */

export const PIPELINE_CHECK_ENABLED_FLAG = "PIPELINE_CHECK_ENABLED";

export const PIPELINE_QUERY_FAILED_CODE = "PIPELINE_QUERY_FAILED";
export const PIPELINE_QUERY_FAILED_MESSAGE =
  "Không tải được dữ liệu pipeline. Đây không phải trạng thái không có dữ liệu.";

/**
 * Route /pipeline-check được phép khi:
 * - Không phải production (pnpm dev, test...): luôn cho phép.
 * - Production: chỉ khi PIPELINE_CHECK_ENABLED === "true".
 */
export function isPipelineCheckEnabled(nodeEnv: string | undefined, flag: string | undefined): boolean {
  if (nodeEnv !== "production") return true;
  return flag === "true";
}

export interface SanitizedPipelineError {
  code: string;
  message: string;
}

/**
 * Thông báo ổn định cho UI. KHÔNG bao giờ trả raw error/provider message ra HTML.
 */
export function sanitizePipelineError(): SanitizedPipelineError {
  return { code: PIPELINE_QUERY_FAILED_CODE, message: PIPELINE_QUERY_FAILED_MESSAGE };
}
