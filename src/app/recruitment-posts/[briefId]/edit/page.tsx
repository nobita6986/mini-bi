import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { RecruitmentPostForm } from "@/components/recruitment-posts/recruitment-post-form";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { decideRecruitmentPostsPageAccess } from "@/lib/recruitment-posts/recruitment-post-ui-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Chỉnh sửa phiếu tuyển dụng — Hệ thống báo cáo HRP",
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditRecruitmentPostPage({
  params,
}: {
  params: Promise<{ briefId: string }>;
}) {
  await connection();
  const { briefId } = await params;

  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideRecruitmentPostsPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
  });

  const normalizedBriefId =
    typeof briefId === "string" ? briefId.trim().toLowerCase() : "";
  const nextPath = `/recruitment-posts/${encodeURIComponent(normalizedBriefId || "invalid")}/edit`;

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW":
      if (!UUID_REGEX.test(normalizedBriefId)) {
        notFound();
      }
      return <RecruitmentPostForm mode="edit" briefId={normalizedBriefId} />;
  }
}
