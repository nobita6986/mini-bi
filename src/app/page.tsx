/**
 * P3-W06B - Root entry fast-track.
 *
 * Domain root `/` is no longer a marketing/landing page; it now hands the
 * user straight to the access gate (`/dashboard`) on the server. The
 * existing session/access gate at `/dashboard` is the single source of
 * truth for auth, so this page deliberately renders nothing client-side:
 * no landing button, no marketing copy, no client-side router effect.
 * There is no flash because the redirect happens before any UI is
 * streamed.
 *
 * Behaviour preserved end-to-end:
 *   - Anonymous         : `/` -> `/dashboard` -> `/login?next=/dashboard`
 *   - Authenticated     : `/` -> `/dashboard`
 *   - `next=/direct-entry` (explicit deep link via `/login?next=...`)
 *                        : still routed through `resolveSafeAuthDestination`
 *                          on the login page; this file does not see `next`.
 *   - Unsafe / external `next` : still falls back to `/dashboard`
 *                          (enforced by `resolveSafeAuthDestination`
 *                          in `@/lib/auth/auth-ui`).
 *
 * No middleware is added and no new auth framework is introduced: the
 * existing `decideSessionPageAccess` gate on `/dashboard` decides
 * login vs allow, and the login page's `LoginGate` already decides
 * the post-login destination.
 */
import { redirect } from "next/navigation";

// Server-side 307, no streaming UI is rendered.
export const dynamic = "force-dynamic";
export const metadata = {
  title: "mini-bi — Báo cáo tuyển dụng",
};

export default function RootEntry(): never {
  redirect("/dashboard");
}