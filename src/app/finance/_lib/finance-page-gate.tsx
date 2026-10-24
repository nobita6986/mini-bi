import "server-only";

import { cache, type ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import {
  vendorFinanceNavPredicate,
  vendorFinanceRecordNavPredicate,
  type NavActorProjection,
} from "@/lib/navigation/registry-capability";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import {
  decideVendorFinancePageAccess,
  type VendorFinanceServerAccessResult,
} from "@/lib/vendor-finance/ui-model";
import { createVendorFinanceRepository } from "@/lib/vendor-finance/vendor-finance-repository";

const resolveVendorFinanceServerAccess = cache(
  async (authSubject: string, appUserId: string): Promise<VendorFinanceServerAccessResult> => {
    try {
      const result = await createVendorFinanceRepository().getActorAccess({
        auth_subject: authSubject,
        app_user_id: appUserId,
      });
      if (!result.ok) {
        return { ok: false, code: result.code };
      }
      return {
        ok: true,
        can_view: result.data.can_view,
        can_record: result.data.can_record,
      };
    } catch {
      return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
    }
  },
);

export async function renderVendorFinancePageGate(input: {
  requiredMode: "view" | "record";
  resolveNextPath: () => string | Promise<string>;
  render: (context: { canRecord: boolean }) => ReactNode | Promise<ReactNode>;
}): Promise<ReactNode> {
  await connection();
  const enabledFlag = process.env.DIRECT_ENTRY_API_ENABLED;
  if (enabledFlag !== "true") {
    notFound();
  }

  const actor = await resolveActorForRequest().catch(() => null);

  let serverAccess: VendorFinanceServerAccessResult | null = null;
  let canRecord = false;

  if (actor?.ok) {
    const baseProjection: NavActorProjection = {
      capabilities: actor.actor.capabilities,
      scopes: actor.actor.scopes.map((scope) => ({ kind: scope.kind })),
    };

    if (vendorFinanceRecordNavPredicate(baseProjection)) {
      canRecord = true;
      serverAccess = { ok: true, can_view: true, can_record: true };
    } else {
      serverAccess = await resolveVendorFinanceServerAccess(
        actor.actor.auth_subject,
        actor.actor.app_user_id,
      );
      if (serverAccess.ok) {
        canRecord = serverAccess.can_view && serverAccess.can_record;
      } else if (
        input.requiredMode === "view" &&
        vendorFinanceNavPredicate(baseProjection) &&
        serverAccess.code !== "ACTOR_NOT_AVAILABLE"
      ) {
        // Direct `vendor_finance_view @ all` (e.g. BoD view-only) already satisfies view predicate.
        serverAccess = { ok: true, can_view: true, can_record: false };
        canRecord = false;
      }
    }
  }

  const decision = decideVendorFinancePageAccess({
    enabledFlag,
    requiredMode: input.requiredMode,
    actor,
    serverAccess,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN": {
      const nextPath = await input.resolveNextPath();
      redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    }
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return input.render({ canRecord });
  }
}
