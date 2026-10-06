import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const rootPage = source("./page.tsx");
const dashboardPage = source("./dashboard/page.tsx");
const loginGate = source("../components/auth/login-gate.tsx");
const authUi = source("../lib/auth/auth-ui.ts");
const loginPage = source("./login/page.tsx");

test("root page (/): server-side redirect to /dashboard, no landing UI", () => {
  // P3-W06B - the root path is a server-only fast-track to the access gate.
  assert.match(rootPage, /import \{ redirect \} from "next\/navigation"/,
    "root page must use Next.js redirect()");
  assert.match(rootPage, /redirect\("\/dashboard"\)/,
    "root page must redirect to /dashboard");
  assert.match(rootPage, /export const dynamic = "force-dynamic"/,
    "root page must opt out of static rendering so the redirect is a server 307, not a meta-tag fallback");
  // No landing content survives.
  assert.doesNotMatch(rootPage, /Mở báo cáo/,
    "landing button must be removed from root");
  assert.doesNotMatch(rootPage, /<h1/,
    "root must not render any visible heading");
  assert.doesNotMatch(rootPage, /import Link from "next\/link"/,
    "root must not import next/link; no client navigation from /");
  assert.doesNotMatch(rootPage, /use client/i,
    "root must be a Server Component (no client effect)");
  assert.doesNotMatch(rootPage, /useEffect|useRouter|useSearchParams/,
    "root must not run any client-side navigation effect");
});

test("dashboard access gate still routes anonymous users to /login?next=/dashboard", () => {
  // P3-W06B: we are removing the landing bridge, not the access gate.
  // /dashboard must still decide auth and forward the user to /login
  // preserving the original destination so the deep link still works.
  assert.match(dashboardPage, /decideSessionPageAccess/);
  assert.match(dashboardPage, /redirect\("\/login\?next=\/dashboard"\)/);
  assert.match(dashboardPage, /export const dynamic = "force-dynamic"/);
});

test("login destination default is /dashboard, with /direct-entry as the only other safe path", () => {
  // LoginGate reads ?next= via useSearchParams and forwards through the
  // same resolveSafeAuthDestination helper that gates the post-login
  // redirect. /direct-entry must remain an explicit deep link, and
  // anything unsafe must collapse to /dashboard.
  assert.match(loginGate, /resolveSafeAuthDestination\(searchParams\.get\("next"\)\)/);
  assert.match(loginGate, /router\.replace\(destination\)/);
  assert.doesNotMatch(loginGate, /router\.push\(/);

  // Source-level invariants on the allowlist helper.
  for (const allowed of ["/dashboard", "/direct-entry"]) {
    assert.match(authUi, new RegExp(`"${allowed}"`));
  }
  assert.match(authUi, /SAFE_AUTH_DESTINATIONS/);
  // The literal return value /dashboard is what LoginGate uses as the
  // default for missing, empty, absolute, or out-of-allowlist `next`.
  assert.match(authUi, /return "\/dashboard"/,
    "default destination for missing/empty/unsafe next must be /dashboard");
  // Open-redirect traps that resolveSafeAuthDestination must still reject.
  assert.match(authUi, /!\s*next\.startsWith\("\/"\)\s*\|\|\s*next\.startsWith\("\/\/"\)/,
    "absolute and protocol-relative URLs must be rejected");
});

test("login page remains a server page with Suspense around LoginGate", () => {
  // Confirm we have not regressed the login host: it must remain a
  // server component so the next= query is read on the server and the
  // client gate is only responsible for the in-page session check.
  assert.match(loginPage, /export const metadata/);
  assert.match(loginPage, /<Suspense/);
  assert.match(loginPage, /<LoginGate \/>/);
});

test("resolveSafeAuthDestination is the single allowlist used by the login gate", () => {
  // Pure source-level: confirm the allowlist only contains the two
  // safe destinations and that the helper's default is /dashboard.
  // The runtime allowlist is already covered by auth-ui.test.mjs in
  // test:server; here we only need to assert the surface contract.
  assert.match(authUi, /export const SAFE_AUTH_DESTINATIONS = \[[^\]]*"\/dashboard"[^\]]*"\/direct-entry"[^\]]*\] as const/);
  assert.match(authUi, /function resolveSafeAuthDestination\(next: string \| null \| undefined\): string \{/);
  // The /dashboard default branch and the open-redirect traps.
  assert.match(authUi, /return "\/dashboard"/);
  assert.match(authUi, /!\s*next\.startsWith\("\/"\)\s*\|\|\s*next\.startsWith\("\/\/"\)/);
  // The two safe paths are exactly /dashboard and /direct-entry.
  // Anything else in SAFE_AUTH_DESTINATIONS would be a regression.
  const allowlistMatch = authUi.match(/SAFE_AUTH_DESTINATIONS = \[([^\]]+)\] as const/);
  assert.ok(allowlistMatch, "SAFE_AUTH_DESTINATIONS must be declared as a const tuple");
  const entries = (allowlistMatch[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  assert.deepEqual(entries, ["/dashboard", "/direct-entry"]);
});