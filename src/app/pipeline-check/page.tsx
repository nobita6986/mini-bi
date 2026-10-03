import { redirect } from "next/navigation";

/**
 * Pipeline Check là trang vận hành theo dõi Google Sheets → n8n → Supabase.
 * Dự án đã bỏ kiến trúc n8n/Google Sheets; trang không còn là product feature
 * và bị loại khỏi navbar (xem docs/handoffs/app-nav-02a.md).
 *
 * Direct hit vào /pipeline-check được redirect server-side về /dashboard
 * (Next.js 16: `redirect()` throws NEXT_REDIRECT). Không fetch dữ liệu,
 * không render pipeline UI, không tiếp tục tuyên bố n8n là kiến trúc hiện hành.
 *
 * Source lịch sử của trang cũ giữ ở git history (commit trước APP-NAV-02A);
 * DB/reporting history không bị xóa.
 */

export const dynamic = "force-dynamic";

export default function PipelineCheckPage(): never {
  redirect("/dashboard");
}