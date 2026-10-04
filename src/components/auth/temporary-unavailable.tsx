"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { authUiErrorMessage } from "@/lib/auth/auth-ui";

/**
 * P3-W03-S02B-R2 - Hạ tầng Auth/actor resolver lỗi: trạng thái tạm thời + retry thủ công.
 * Không auto-loop, không render raw reason/error/UUID.
 */
export function TemporaryUnavailable() {
  const router = useRouter();
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <div role="alert" className="w-full max-w-sm rounded-lg border bg-card p-6 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold">{authUiErrorMessage("AUTH_UNAVAILABLE")}</h1>
        <p className="mb-5 text-sm text-muted-foreground">Vui lòng thử lại sau.</p>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => router.refresh()}
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40">
            Thử lại
          </button>
          <Link href="/dashboard"
            className="inline-flex h-11 items-center justify-center rounded-md border border-input px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring/40">
            Về Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
