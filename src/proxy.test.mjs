import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./proxy.ts", import.meta.url), "utf8");

test("proxy matcher applies the pilot gate to both Direct Entry page and API path families", () => {
  for (const matcher of [
    '"/direct-entry"',
    '"/direct-entry/:path*"',
    '"/api/direct-entry"',
    '"/api/direct-entry/:path*"',
  ]) {
    assert.ok(source.includes(matcher), `missing proxy matcher ${matcher}`);
  }
});

test("Direct Entry proxy decision rejects before request proceeds to route handlers", () => {
  const pathGuard = source.indexOf("if (!isPilotProtectedPath(request.nextUrl.pathname))");
  const accessDecision = source.indexOf("evaluatePilotAccess({");
  const allowBranch = source.indexOf('if (decision.kind === "allow")');
  assert.ok(pathGuard >= 0 && accessDecision > pathGuard);
  assert.ok(allowBranch > accessDecision);
  assert.match(source, /status: 503/);
  assert.match(source, /status: 401/);
  assert.match(source, /"Cache-Control": "private, no-store"/);
  assert.match(source, /"WWW-Authenticate":\s*'Basic realm="/);
  assert.match(source, /Vary: "Authorization"/);
  assert.doesNotMatch(source, /console\.(?:log|error).*(?:Authorization|username|password)/i);
});
