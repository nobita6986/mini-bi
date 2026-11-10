import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { RecruitmentPostForm } from "@/components/recruitment-posts/recruitment-post-form";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { decideRecruitmentPostsPageAccess } from "@/lib/recruitment-posts/recruitment-post-ui-model";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tạo phiếu tuyển dụng — Hệ thống báo cáo HRP",
};

export default async function NewRecruitmentPostPage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideRecruitmentPostsPageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=%2Frecruitment-posts%2Fnew");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW":
      return <RecruitmentPostForm mode="create" />;
  }
}
