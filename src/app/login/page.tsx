import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginGate } from "@/components/auth/login-gate";

export const metadata: Metadata = { title: "Đăng nhập — HR Partner" };

export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold">Đăng nhập</h1>
        <p className="mb-5 text-sm text-muted-foreground">Đăng nhập để tiếp tục sử dụng hệ thống.</p>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Đang tải…</p>}>
          <LoginGate />
        </Suspense>
      </div>
    </main>
  );
}
