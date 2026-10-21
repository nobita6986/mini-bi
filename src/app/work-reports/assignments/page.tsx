import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { AssignmentManager } from "@/components/work-reports/renderer/assignment-manager";

export const dynamic = "force-dynamic";

export default function WorkReportAssignmentsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  return <PageShell>
    <PageHeader eyebrow="Báo cáo công việc" title="Giao báo cáo" description="Tạo giao việc cho nhân viên, nhóm hoặc danh sách nhân viên." />
    <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/work-reports">Quay lại báo cáo của tôi</Link>
    <AssignmentManager />
  </PageShell>;
}
