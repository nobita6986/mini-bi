import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL(
  "./entries/[entryId]/payment/route.ts",
  import.meta.url,
), "utf8");

test("payment PATCH is gated before params, auth, repository, and DB setup", () => {
  const gate = route.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const notFound = route.indexOf('code: "NOT_FOUND"');
  const params = route.indexOf("await context.params");
  const auth = route.indexOf("getDirectEntryActor(");
  const repository = route.indexOf("createDirectEntryWriteRepository()");
  const handler = route.indexOf("patchDraftPayment(");
  assert.ok(
    gate >= 0 && notFound > gate && params > notFound && auth > params &&
      repository > params && handler > params,
  );
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.doesNotMatch(route, /\.from\s*\(/);
});
