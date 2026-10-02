import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("session route gates before calling the existing Supabase session and actor resolver", () => {
  assert.match(source, /process\.env\.DIRECT_ENTRY_API_ENABLED/);
  assert.match(source, /createDirectEntrySessionResponse\(/);
  assert.match(source, /getDirectEntryActor\(createDirectEntryActorRepository\(\)\)/);
  assert.match(source, /GET\(\): Promise<Response>/);
  assert.doesNotMatch(source, /request\.(?:json|text|url|headers)/i);
  assert.match(source, /runtime = "nodejs"/);
  assert.match(source, /dynamic = "force-dynamic"/);
});
