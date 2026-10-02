import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const files = {
  catalog: new URL("./catalog/route.ts", import.meta.url),
  drafts: new URL("./drafts/route.ts", import.meta.url),
  entries: new URL("./entries/[entryId]/route.ts", import.meta.url),
};
const sources = Object.fromEntries(
  Object.entries(files).map(([key, url]) => [key, readFileSync(url, "utf8")]),
);

test("catalog and own-drafts GET gates run before session or database setup", () => {
  for (const [name, source] of Object.entries({ catalog: sources.catalog, drafts: sources.drafts })) {
    const gate = source.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
    const notFound = source.indexOf('code: "NOT_FOUND"');
    const session = source.indexOf("getDirectEntryActor(");
    const helperCall = source.indexOf(name === "catalog" ? "getInputCatalog(" : "getOwnDrafts(");
    assert.ok(gate >= 0 && notFound > gate && session > notFound && helperCall > notFound, name);
    assert.match(source, /Cache-Control.*private, no-store/);
    assert.match(source, /runtime = "nodejs"/);
    assert.match(source, /dynamic = "force-dynamic"/);
  }
});

test("PATCH shares the entry route and gates before awaiting params or session", () => {
  const source = sources.entries;
  const patchStart = source.indexOf("export async function PATCH");
  const patchSource = source.slice(patchStart);
  const gate = patchSource.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const notFound = patchSource.indexOf('code: "NOT_FOUND"');
  const params = patchSource.indexOf("await context.params");
  const session = patchSource.indexOf("getDirectEntryActor(");
  assert.ok(patchStart >= 0 && gate >= 0 && notFound > gate && params > notFound && session > params);
  assert.match(patchSource, /patchDraftEntry\(/);
});
