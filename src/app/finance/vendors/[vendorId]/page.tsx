import { Suspense } from "react";
import { notFound } from "next/navigation";

import { VendorFinanceDetailView } from "@/components/vendor-finance/vendor-finance-detail-view";
import { isCanonicalUiVendorId } from "@/lib/vendor-finance/ui-model";

import { renderVendorFinancePageGate } from "../../_lib/finance-page-gate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sổ cái & Đối soát Vendor — Hệ thống báo cáo HRP",
};

function decodeSafeVendorId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return isCanonicalUiVendorId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export default async function FinanceVendorDetailPage({
  params,
}: {
  params: Promise<{ vendorId: string }>;
}) {
  return renderVendorFinancePageGate({
    requiredMode: "view",
    resolveNextPath: async () => {
      const { vendorId } = await params;
      const safeId = decodeSafeVendorId(vendorId);
      return safeId ? `/finance/vendors/${encodeURIComponent(safeId)}` : "/finance/vendors";
    },
    render: async ({ canRecord, canReconcile, canManageProjectAssignments }) => {
      const { vendorId } = await params;
      const safeId = decodeSafeVendorId(vendorId);
      if (!safeId) {
        notFound();
      }
      return (
        <Suspense fallback={null}>
          <VendorFinanceDetailView
            vendorId={safeId}
            initialCanRecord={canRecord}
            initialCanReconcile={canReconcile}
            initialCanManageProjectAssignments={canManageProjectAssignments}
          />
        </Suspense>
      );
    },
  });
}
