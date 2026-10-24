import { redirect } from "next/navigation";

import { renderVendorFinancePageGate } from "./_lib/finance-page-gate";

export const dynamic = "force-dynamic";

export default async function FinanceIndexPage() {
  return renderVendorFinancePageGate({
    requiredMode: "view",
    resolveNextPath: () => "/finance/vendors",
    render: () => {
      redirect("/finance/vendors");
    },
  });
}
