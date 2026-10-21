import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";

export const dynamic = "force-dynamic";

export default function MyWorkReportsHistoryPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  return <PageShell>
    <PageHeader eyebrow="Báo cáo công việc" title="Lịch sử của tôi" description="Các bản nháp, báo cáo đã nộp và lịch sử revision của bạn." />
    <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/work-reports">Quay lại danh sách cần báo cáo</Link>
    <MyObligations history />
  </PageShell>;
}
