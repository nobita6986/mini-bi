import { notFound } from "next/navigation";

import { DirectEntryShell } from "@/components/direct-entry/direct-entry-shell";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

export const dynamic = "force-dynamic";

export const metadata = { title: "Nhập liệu trực tiếp — mini-bi" };

export default function DirectEntryPage() {
  if (!isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED)) {
    notFound();
  }

  return <DirectEntryShell />;
}
