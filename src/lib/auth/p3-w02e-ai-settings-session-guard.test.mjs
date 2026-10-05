/**
 * P3-W02E — Re-audit cho POST /api/ai/settings.
 *
 * Muc tieu: khoa rang POST /api/ai/settings da duoc P3-W02E them guardApiSession()
 * theo dung thu tu nhu cac AI route anh em (activate / disable / rotate / test)
 * va nhu GET cung route.
 *
 * Route Next khong import duoc bang Node thuan (alias "@/" + server-only), nen
 * hop dong route duoc kiem bang assert tren source cua route (cung pattern nhu
 * w04a-panel-api.test.mjs va pilot-removal.test.mjs). Duong HTTP that duoc
 * kiem bang probe server cuc bo o buoc verify.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const ROUTE = new URL("../../app/api/ai/settings/route.ts", import.meta.url);
const GUARD = new URL("./api-session-guard.ts", import.meta.url);

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function sliceFunctionBody(sourceText, functionName) {
  // Tra ve block than ham (sau dau { dau tien den } dong cap dau tien) de assert vi tri guard.
  const anchor = `export async function ${functionName}`;
  const start = sourceText.indexOf(anchor);
  assert.ok(start >= 0, "khong tim thay ham " + functionName);
  let depth = 0;
  let bodyStart = -1;
  for (let index = start; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === "{") {
      if (bodyStart === -1) bodyStart = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (bodyStart !== -1 && depth === 0) {
        return sourceText.slice(bodyStart, index + 1);
      }
    }
  }
  throw new Error("khong tim thay than ham " + functionName);
}

test("P3-W02E P1: POST /api/ai/settings goi guardApiSession() truoc khi wiring/body", () => {
  const route = source(ROUTE);
  const postBody = sliceFunctionBody(route, "POST");

  // Guard session phai xuat hien trong than ham POST.
  assert.match(postBody, /await guardApiSession\(\)/,
    "POST phai goi await guardApiSession()");
  assert.match(postBody, /if \(!session\.ok\) return session\.response;/,
    "POST phai reject response khi session khong ok");

  // Thu tu fail-closed: settings guard TRUOC, session guard TRUOC wiring TRUOC body.
  const settingsGuardAt = postBody.indexOf("guardSettingsRequest(request");
  const sessionGuardAt = postBody.indexOf("await guardApiSession()");
  const wiringAt = postBody.indexOf("createSettingsWiring()");
  const bodyAt = postBody.indexOf("readSettingsJsonBody(request");

  assert.ok(settingsGuardAt >= 0, "POST phai goi guardSettingsRequest");
  assert.ok(sessionGuardAt > settingsGuardAt,
    "session guard phai chay SAU settings guard (flag + CSRF + rate limit truoc)");
  assert.ok(wiringAt > sessionGuardAt,
    "wiring phai chay SAU session guard");
  assert.ok(bodyAt > sessionGuardAt,
    "doc body phai chay SAU session guard");
});

test("P3-W02E P2: GET va POST cung route deu co guardApiSession() (khong chi mot method)", () => {
  const route = source(ROUTE);
  const getBody = sliceFunctionBody(route, "GET");
  const postBody = sliceFunctionBody(route, "POST");

  assert.match(getBody, /await guardApiSession\(\)/, "GET phai goi guardApiSession()");
  assert.match(postBody, /await guardApiSession\(\)/, "POST phai goi guardApiSession()");

  // Kiem soat duy nhat: source phai chua it nhat 2 lan await guardApiSession()
  // (GET + POST), va POST khong duoc su dung PILOT_ACTOR_REF thay cho session guard.
  const matches = route.match(/await guardApiSession\(\)/g) ?? [];
  assert.equal(matches.length >= 2, true,
    "route phai goi await guardApiSession() it nhat 2 lan (GET + POST)");

  // PILOT_ACTOR_REF van duoc phep lam settings actor_ref key cho rate limit
  // (P3-W02A follow-up se di chuyen); nhung khong duoc dung de THAY guard session.
  // Dam bao khong co pattern 'PILOT_ACTOR_REF as session' hoac 'session = PILOT_ACTOR_REF'.
  assert.equal(/session\s*=\s*PILOT_ACTOR_REF/.test(route), false,
    "PILOT_ACTOR_REF khong duoc dung thay cho session guard");
});

test("P3-W02E P3: response cua guard phai giu contract private, no-store + 401 UNAUTHENTICATED", () => {
  const guard = source(GUARD);
  // P1.7-H04 da khoa contract nay; W02E khong duoc thay doi.
  assert.match(guard, /apiSessionError\("UNAUTHENTICATED", 401\)/);
  assert.match(guard, /"cache-control": "private, no-store"/);
});

test("P3-W02E P4: PILOT_ACTOR_REF con lai chi lam rate-limit key, khong phai session", () => {
  // Sau W02E, flag actor_ref trong guardSettingsRequest van la PILOT_ACTOR_REF
  // (rate limit follow-up P3-W02A). Xac nhan rang no chi xuat hien o settings guard,
  // khong thay the guard session.
  const route = source(ROUTE);
  const postBody = sliceFunctionBody(route, "POST");

  // Trong POST, PILOT_ACTOR_REF van xuat hien nhu actor_ref cua settings guard.
  assert.match(postBody, /actor_ref: PILOT_ACTOR_REF/);
  // Nhung khong co guard session nao "return" hoac "= PILOT_ACTOR_REF".
  assert.equal(/redirect\([^)]*PILOT_ACTOR_REF/.test(postBody), false);
  // Guard session phai tra Response JSON (khong redirect HTML).
  assert.equal(/redirect\(/.test(postBody), false,
    "POST khong duoc redirect HTML (van la API, khong phai page)");
});
