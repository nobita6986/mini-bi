import { Suspense } from "react";

import { VendorFinanceMonthlyReportView } from "@/components/vendor-finance/vendor-finance-monthly-report-view";

import { renderVendorFinancePageGate } from "../_lib/finance-page-gate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Báo cáo công nợ Vendor theo Dự án & Tháng — Hệ thống báo cáo HRP",
};

export default async function FinanceMonthlyReportPage() {
  return renderVendorFinancePageGate({
    requiredMode: "view",
    resolveNextPath: () => "/finance/reports",
    render: ({ canRecord, canReconcile, canManageProjectAssignments }) => (
      <Suspense fallback={null}>
        <VendorFinanceMonthlyReportView
          initialCanRecord={canRecord}
          initialCanReconcile={canReconcile}
          initialCanManageProjectAssignments={canManageProjectAssignments}
        />
      </Suspense>
    ),
  });
}
