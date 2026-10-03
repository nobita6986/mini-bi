"use client";

/**
 * P3-W03-S01B - UserSessionControl: nho, dat trong AppShell. Chi la UX; route/RPC van la authority.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function UserSessionControl() {
  const router = useRouter();
  const [state, setState] = useState<"loading" | "auth" | "anon" | "unavailable">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/session", {
          cache: "no-store", credentials: "same-origin",
        });
        if (cancelled) return;
        if (res.status === 200) setState("auth");
        else if (res.status === 401) setState("anon");
        else setState("unavailable");
      } catch {
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST", credentials: "same-origin",
      });
      if (res.status === 204) {
        router.replace("/login");
        router.refresh();
        return;
      }
      setError("Không thể đăng xuất lúc này. Vui lòng thử lại.");
    } catch {
      setError("Không thể đăng xuất lúc này. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }

  const linkClass = "inline-flex h-11 items-center rounded-md px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40";

  if (state === "loading") {
    return <span aria-hidden className="inline-block h-11 w-24 animate-pulse rounded bg-muted" />;
  }
  if (state !== "auth") {
    return <Link href="/login" className={linkClass}>Đăng nhập</Link>;
  }
  return (
    <div className="flex items-center gap-2">
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        aria-busy={busy}
        className="inline-flex h-11 items-center rounded-md px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {busy ? "Đang đăng xuất…" : "Đăng xuất"}
      </button>
    </div>
  );
}
