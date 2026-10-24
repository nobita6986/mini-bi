import { VendorFinanceListView } from "@/components/vendor-finance/vendor-finance-list-view";

import { renderVendorFinancePageGate } from "../_lib/finance-page-gate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Công nợ & Tạm ứng Vendor — Hệ thống báo cáo HRP",
};

export default async function FinanceVendorsPage() {
  return renderVendorFinancePageGate({
    requiredMode: "view",
    resolveNextPath: () => "/finance/vendors",
    render: ({ canRecord }) => <VendorFinanceListView initialCanRecord={canRecord} />,
  });
}
