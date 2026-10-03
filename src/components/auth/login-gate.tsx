"use client";

/**
 * P3-W03-S01B - Bootstrap session khi mo /login. Goi GET /api/auth/session DUNG MOT lan.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { authUiErrorMessage, resolveSafeAuthDestination } from "@/lib/auth/auth-ui";
import { LoginForm } from "./login-form";

export function LoginGate() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const destination = resolveSafeAuthDestination(searchParams.get("next"));
  const [state, setState] = useState<"loading" | "form" | "unavailable" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/session", {
          cache: "no-store", credentials: "same-origin",
        });
        if (res.status === 200) { router.replace(destination); return; }
        if (cancelled) return;
        if (res.status === 401) { setState("form"); return; }
        if (res.status === 403) { setState("unavailable"); return; }
        setState("error");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [destination, router]);

  useEffect(() => { return check(); }, [check, attempt]);

  if (state === "loading") {
    return <p aria-live="polite" className="text-sm text-muted-foreground">Đang kiểm tra phiên đăng nhập…</p>;
  }
  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // 204 khong can phan hoi; noi dung session da bi server xoa khi tra ACCOUNT_NOT_AVAILABLE.
    } finally {
      setBusy(false);
      router.replace("/login");
      router.refresh();
    }
  }

  if (state === "unavailable") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <p>{authUiErrorMessage("ACCOUNT_NOT_AVAILABLE")}</p>
        <button type="button" onClick={() => void logout()} disabled={busy} aria-busy={busy}
          className="h-11 rounded-md border border-input px-3 text-sm">Đăng xuất</button>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <p>{authUiErrorMessage("AUTH_UNAVAILABLE")}</p>
        <button type="button" onClick={() => {
          setState("loading");
          setAttempt((value) => value + 1);
        }}
          className="h-11 rounded-md border border-input px-3 text-sm">Thử lại</button>
      </div>
    );
  }
  return <LoginForm destination={destination} />;
}
