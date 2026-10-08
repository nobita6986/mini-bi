import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { WorkerOperations } from "@/components/direct-entry/worker-operations";
import { decideWorkerOperationsPageAccess } from "@/lib/auth/direct-entry-page-access";
import {
  workerOperationsAllScopePredicate,
  workerOperationsReviewPredicate,
} from "@/lib/navigation/registry-capability";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * P2.5-W06-R1 - Worker Operations.
 *
 * Cung boundary voi /direct-entry (flag + actor resolver request-scoped) va CUNG predicate
 * voi nav (workerOperationsNavPredicate) — khong hai logic lech nhau.
 *
 * "Toan bo NLD" (scope=all) va review queue chi duoc BAT khi server-side actor projection
 * xac nhan (entry_admin | change_review) + effective all scope; RPC W03/W05 van la authority
 * cuoi cung. Reviewer KHONG duoc mo /direct-entry editor.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Người lao động — mini-bi" };

export default async function WorkerOperationsPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = uiEnabled ? await resolveActorForRequest().catch(() => null) : null;

  switch (decideWorkerOperationsPageAccess({ uiEnabled, actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/direct-entry/workers");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW": {
      const projection = actor !== null && actor.ok ? actor.actor : null;
      const canSeeAllWorkers = projection !== null &&
        workerOperationsAllScopePredicate(projection);
      const canReview = projection !== null && workerOperationsReviewPredicate(projection);
      return (
        <WorkerOperations
          canSeeAllWorkers={canSeeAllWorkers}
          canReview={canReview}
        />
      );
    }
  }
}
