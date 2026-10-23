import { notFound } from "next/navigation";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function MyWorkReportsHistoryPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  return (
    <WorkReportsShell
      actor={resolution?.ok ? resolution.actor : null}
      title="Lịch sử của tôi"
      description="Các bản nháp, báo cáo đã nộp và lịch sử revision của bạn."
    >
      <MyObligations history />
    </WorkReportsShell>
  );
}
