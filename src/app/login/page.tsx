import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginGate } from "@/components/auth/login-gate";

export const metadata: Metadata = { title: "Đăng nhập — HR Partner" };

export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-xs">
        <h1 className="mb-1 text-lg font-semibold text-foreground">Đăng nhập</h1>
        <p className="mb-5 text-sm text-muted">Đăng nhập để tiếp tục sử dụng hệ thống.</p>
        <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
          <LoginGate />
        </Suspense>
      </div>
    </main>
  );
}
