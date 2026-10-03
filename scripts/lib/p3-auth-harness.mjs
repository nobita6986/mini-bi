/**
 * P3-W03-S01C - synthetic browser harness helpers for the auth UI.
 *
 * Replays the auth UI flows against a stub `fetch` so the acceptance
 * script can observe URL / method / headers / body for each scenario.
 * No DB, no Supabase Auth, no live Next.js dev server, no Playwright.
 */

export function createAuthStubFetch(overrides = {}) {
  const calls = [];
  const sessionQueue = [...(overrides.session ?? [])];
  let sessionIndex = 0;

  const fetchStub = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = null; }
    } else if (init.body instanceof Uint8Array) {
      body = init.body;
    }
    calls.push({ url, method, headers, body });

    if (overrides.networkFailure) {
      throw new TypeError("Failed to fetch");
    }

    if (method === "GET" && /\/api\/auth\/session$/.test(url)) {
      const queued = sessionQueue[sessionIndex++] ?? sessionQueue[sessionQueue.length - 1] ?? { status: 401, body: { ok: false, code: "AUTH_UNAUTHENTICATED" } };
      return jsonResponse(queued.status, queued.body);
    }

    if (method === "POST" && /\/api\/auth\/login$/.test(url)) {
      const login = overrides.login ?? { status: 200, body: { ok: true, app_user_id: "synthetic-user", capabilities: [], scopes: [] } };
      return jsonResponse(login.status, login.body);
    }

    if (method === "POST" && /\/api\/auth\/logout$/.test(url)) {
      const logout = overrides.logout ?? { status: 204, body: null };
      if (logout.body === null) {
        return new Response(null, { status: logout.status });
      }
      return jsonResponse(logout.status, logout.body);
    }

    return jsonResponse(200, { ok: true });
  };
  fetchStub.calls = calls;
  fetchStub.sessionIndex = () => sessionIndex;
  return fetchStub;
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Persistent state for the LoginGate so a manual retry increments the attempt
// and produces a fresh session request.
const gateState = new Map();

function gateKey(initialAttempt) {
  return `gate:${initialAttempt}`;
}

async function simulateLoginGate(options) {
  const stub = options.stub;
  const initialAttempt = options.attempt ?? 0;
  const key = gateKey(initialAttempt);
  let pending = gateState.get(key);
  if (!pending) {
    pending = { cancelled: false, attempt: initialAttempt };
    gateState.set(key, pending);
  }
  pending.cancelled = false;
  try {
    const res = await stub("/api/auth/session", { method: "GET", cache: "no-store", credentials: "same-origin" });
    if (pending.cancelled) return { state: "cancelled" };
    if (res.status === 200) return { state: "redirect", destination: options.destination ?? "/dashboard" };
    if (res.status === 401) return { state: "form" };
    if (res.status === 403) return { state: "unavailable" };
    return { state: "error" };
  } catch (cause) {
    return { state: "error", error: cause.message };
  }
}

async function simulateLoginForm(options) {
  const stub = options.stub;
  const email = options.email ?? "user@example.invalid";
  const password = options.password ?? "synthetic-password";
  if (options.busyAlready) return { state: "skipped" };
  try {
    const res = await stub("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
    });
    if (res.ok) return { state: "redirect" };
    let code = "AUTH_UNAVAILABLE";
    try {
      const payload = await res.json();
      if (payload && typeof payload === "object" && typeof payload.code === "string") code = payload.code;
    } catch { /* ignore */ }
    return { state: "error", code };
  } catch (cause) {
    return { state: "error", code: "AUTH_UNAVAILABLE", error: cause.message };
  }
}

async function simulateSessionControl(options) {
  const stub = options.stub;
  let session;
  try {
    const res = await stub("/api/auth/session", { method: "GET", cache: "no-store", credentials: "same-origin" });
    session = res.status;
  } catch (cause) {
    return { state: "unavailable" };
  }
  if (session === 200) return { state: "auth" };
  if (session === 401) return { state: "anon" };
  return { state: "unavailable" };
}

async function simulateLogout(options) {
  const stub = options.stub;
  if (options.busyAlready) return { state: "skipped" };
  try {
    const res = await stub("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    if (res.status === 204) return { state: "redirect" };
    return { state: "error" };
  } catch (cause) {
    return { state: "error" };
  }
}

export function resetHarness() {
  gateState.clear();
}

export { simulateLoginGate, simulateLoginForm, simulateSessionControl, simulateLogout };