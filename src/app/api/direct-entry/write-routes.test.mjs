import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const postSource = readFileSync(new URL("./batches/route.ts", import.meta.url), "utf8");
const getSource = readFileSync(new URL("./entries/[entryId]/route.ts", import.meta.url), "utf8");

test("write route gates before actor/session setup", () => {
  for (const [source, handler, setup] of [
    [postSource, "POST", "postDirectEntryBatch"],
    [getSource, "GET", "getDirectEntryEntry"],
  ]) {
    const gate = source.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
    const response = source.indexOf('code: "NOT_FOUND"');
    const actorSetup = source.indexOf("getDirectEntryActor(");
    const helperCall = source.indexOf(`${setup}(`);
    assert.ok(gate >= 0 && response > gate && actorSetup > response && helperCall > response, handler);
    assert.match(source, /runtime = "nodejs"/);
    assert.match(source, /dynamic = "force-dynamic"/);
  }
});

test("API route code does not read client-supplied actor, capability or scope", () => {
  assert.doesNotMatch(postSource + getSource, /(?:app_user_id|auth_subject|capability|team_id|provider_type)\s*:\s*request/i);
});
