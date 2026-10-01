import { connection } from "next/server";

import { fetchReporting } from "@/lib/reporting/p1-reporting-server";
import { fetchReportingOptions } from "@/lib/reporting/p1-options-server";
import { DashboardView } from "@/components/dashboard/dashboard-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan tuyển dụng — mini-bi" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  const params = await searchParams;
  const [report, options] = await Promise.all([fetchReporting(params), fetchReportingOptions()]);
  return <DashboardView report={report} optionsResult={options} />;
}
