import { notFound } from "next/navigation";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function WorkReportsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  const actor = resolution?.ok ? resolution.actor : null;
  return (
    <WorkReportsShell
      actor={actor}
      title="Cần báo cáo"
      description="Các báo cáo được giao cho bạn; lưu nháp hoặc nộp trước hạn."
    >
      <MyObligations />
    </WorkReportsShell>
  );
}
