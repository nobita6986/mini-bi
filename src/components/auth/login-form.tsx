"use client";

/**
 * P3-W03-S01B - Form dang nhap nho (client). Dung native form; khong dependency auth/state.
 */
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";

import { authUiErrorMessage } from "@/lib/auth/auth-ui";

export function LoginForm({ destination, onError }:
  { destination: string; onError?: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (response.ok) {
        router.replace(destination);
        router.refresh();
        return;
      }
      let code = "AUTH_UNAVAILABLE";
      try {
        const payload: unknown = await response.json();
        if (payload && typeof payload === "object" && "code" in payload &&
            typeof (payload as { code: unknown }).code === "string") {
          code = (payload as { code: string }).code;
        }
      } catch { /* ignore */ }
      setPassword("");
      setError(authUiErrorMessage(code));
      onError?.();
    } catch {
      setPassword("");
      setError(authUiErrorMessage("AUTH_UNAVAILABLE"));
      onError?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-email" className="text-sm font-medium text-foreground">Email</label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          value={email}
          aria-describedby={error ? "login-error" : undefined}
          onChange={(event) => setEmail(event.target.value)}
          className="h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-password" className="text-sm font-medium text-foreground">Mật khẩu</label>
        <div className="relative">
          <input
            id="login-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            spellCheck={false}
            required
            value={password}
            aria-describedby={error ? "login-error" : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className="h-11 w-full rounded-md border border-input bg-background px-3 pr-11 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {showPassword ? <EyeOff aria-hidden className="h-5 w-5" /> : <Eye aria-hidden className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {error && (
        <p id="login-error" role="alert" aria-live="polite"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        aria-busy={busy}
        className="h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {busy ? "Đang đăng nhập…" : "Đăng nhập"}
      </button>
    </form>
  );
}
