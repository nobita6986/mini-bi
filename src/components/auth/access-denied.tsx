import Link from "next/link";

import { ACCESS_DENIED_MESSAGE } from "@/lib/auth/auth-ui";

/**
 * P3-W03-S02B - UX chung cho truong hop auth hop le nhung thieu quyen truy cap resource.
 * Khong nhan/hien thong tin noi bo (actor, quyen, pham vi) hay ma loi raw. Link chi ve trang an toan.
 */
export function AccessDenied() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <div role="alert" className="w-full max-w-sm rounded-lg border bg-card p-6 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold">{ACCESS_DENIED_MESSAGE}</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Bạn có thể quay về trang chính hoặc đăng nhập lại.
        </p>
        <div className="flex flex-col gap-2">
          <Link href="/dashboard"
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40">
            Về Dashboard
          </Link>
          <Link href="/login"
            className="inline-flex h-11 items-center justify-center rounded-md border border-input px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring/40">
            Đăng nhập
          </Link>
        </div>
      </div>
    </main>
  );
}
