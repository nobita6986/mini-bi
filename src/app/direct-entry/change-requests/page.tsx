import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { ChangeRequestsWorkspace } from "@/components/direct-entry/change-requests-workspace";
import { decideChangeRequestsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { createChangeRequestReadRepository } from "@/lib/direct-entry/change-request-read-repository";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";
import { canViewGlobalChangeRequestHistory } from "@/lib/direct-entry/worker-operations-model";
import {
  changeRequestsNavPredicate,
  changeRequestsReviewerPredicate,
  directEntryNavPredicate,
  workerOperationsNavPredicate,
} from "@/lib/navigation/registry-capability";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Yêu cầu thay đổi — Hệ thống báo cáo HRP" };

export default async function ChangeRequestsPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = uiEnabled ? await resolveActorForRequest().catch(() => null) : null;

  let hasHistoricalRequests = false;
  if (uiEnabled && actor !== null && actor.ok && !changeRequestsNavPredicate(actor.actor)) {
    const repository = createChangeRequestReadRepository();
    const probe = await repository
      .listChangeRequests({
        auth_subject: actor.actor.auth_subject,
        app_user_id: actor.actor.app_user_id,
        page_size: 1,
        cursor: null,
        state: null,
        days: null,
      })
      .catch(() => null);
    hasHistoricalRequests = probe !== null && probe.ok && probe.data.requests.length > 0;
  }

  switch (decideChangeRequestsPageAccess({ uiEnabled, actor, hasHistoricalRequests })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/direct-entry/change-requests");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW": {
      const projection = actor !== null && actor.ok ? actor.actor : null;
      const canReview = projection !== null && changeRequestsReviewerPredicate(projection);
      const canViewGlobalHistory = projection !== null &&
        canViewGlobalChangeRequestHistory(projection.capabilities, projection.scopes);
      const canAccessDirectEntry = projection !== null && directEntryNavPredicate(projection);
      const canAccessWorkerDirectory = projection !== null && workerOperationsNavPredicate(projection);
      return (
        <ChangeRequestsWorkspace
          canReview={canReview}
          canViewGlobalHistory={canViewGlobalHistory}
          canAccessDirectEntry={canAccessDirectEntry}
          canAccessWorkerDirectory={canAccessWorkerDirectory}
        />
      );
    }
  }
}
