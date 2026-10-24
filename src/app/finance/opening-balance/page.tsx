import { Suspense } from "react";

import { OpeningBalanceWizard } from "@/components/vendor-finance/opening-balance-wizard";

import { renderVendorFinancePageGate } from "../_lib/finance-page-gate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Khởi tạo công nợ đầu kỳ Vendor — Hệ thống báo cáo HRP",
};

export default async function FinanceOpeningBalancePage() {
  return renderVendorFinancePageGate({
    requiredMode: "record",
    resolveNextPath: () => "/finance/opening-balance",
    render: () => (
      <Suspense fallback={null}>
        <OpeningBalanceWizard />
      </Suspense>
    ),
  });
}
