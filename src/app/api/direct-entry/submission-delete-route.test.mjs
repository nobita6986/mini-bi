import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./submissions/[submissionId]/route.ts", import.meta.url), "utf8");

test("submission DELETE route gates before params, session and repository", () => {
  const gate = source.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const params = source.indexOf("await context.params");
  const session = source.indexOf("getDirectEntryActor(");
  const repository = source.indexOf("createSubmissionDeleteRepository()");
  const handler = source.indexOf("deleteDraftSubmission(");
  assert.ok(gate >= 0 && params > gate && session > gate && repository > gate && handler > gate);
  assert.match(source, /export async function DELETE\(/);
  assert.match(source, /runtime = "nodejs"/);
  assert.match(source, /dynamic = "force-dynamic"/);
  assert.doesNotMatch(source, /\.from\s*\(/);
});
