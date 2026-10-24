import { Suspense } from "react";

import { VendorFinanceGovernanceView } from "@/components/vendor-finance/vendor-finance-governance-view";

import { renderVendorFinancePageGate } from "../_lib/finance-page-gate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Phân công Kế toán Dự án & Vai trò Toàn cục — Hệ thống báo cáo HRP",
};

export default async function FinanceProjectAssignmentsPage() {
  return renderVendorFinancePageGate({
    requiredMode: "admin",
    resolveNextPath: () => "/finance/project-assignments",
    render: () => (
      <Suspense fallback={null}>
        <VendorFinanceGovernanceView />
      </Suspense>
    ),
  });
}
