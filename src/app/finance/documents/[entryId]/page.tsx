import { notFound } from "next/navigation";

import { VendorFinanceDocumentView } from "@/components/vendor-finance/vendor-finance-document-view";
import { isUuidString } from "@/lib/vendor-finance/ui-model";

import { renderVendorFinancePageGate } from "../../_lib/finance-page-gate";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Chứng từ tài chính Vendor — Hệ thống báo cáo HRP",
};

function normalizeSafeEntryId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw).trim();
    return isUuidString(decoded) ? decoded.toLowerCase() : null;
  } catch {
    return null;
  }
}

export default async function FinanceDocumentPage({
  params,
}: {
  params: Promise<{ entryId: string }>;
}) {
  return renderVendorFinancePageGate({
    requiredMode: "view",
    resolveNextPath: async () => {
      const { entryId } = await params;
      const safeId = normalizeSafeEntryId(entryId);
      return safeId ? `/finance/documents/${encodeURIComponent(safeId)}` : "/finance/vendors";
    },
    render: async () => {
      const { entryId } = await params;
      const safeId = normalizeSafeEntryId(entryId);
      if (!safeId) {
        notFound();
      }
      return <VendorFinanceDocumentView entryId={safeId} />;
    },
  });
}
