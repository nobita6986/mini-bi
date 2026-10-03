import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const base = "./entries/[entryId]/documents";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function gated(source) {
  const gate = source.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const missing = source.indexOf('code: "NOT_FOUND"');
  const params = source.indexOf("await context.params");
  const session = source.indexOf("getDirectEntryActor(");
  assert.ok(gate >= 0 && missing > gate && params > missing && session > params);
  assert.match(source, /runtime = "nodejs"/);
  assert.match(source, /dynamic = "force-dynamic"/);
  assert.match(source, /createR2DocumentStorage/);
  assert.doesNotMatch(source, /\bfetch\s*\(|drive\.google|storage\.from\(/i);
}

test("reservation, finalize and download routes gate before session and use R2 storage", () => {
  gated(read(`${base}/route.ts`));
  gated(read(`${base}/[documentId]/finalize/route.ts`));
  gated(read(`${base}/[documentId]/download/route.ts`));
});

test("legacy worker callback route and env names are unreachable from production source", () => {
  assert.equal(existsSync(new URL("./document-worker", import.meta.url)), false);
  const roots = [fileURLToPath(new URL("./", import.meta.url)), fileURLToPath(new URL("../../../lib/direct-entry/", import.meta.url)), fileURLToPath(new URL("../../../components/direct-entry/", import.meta.url))];
  const banned = /DIRECT_ENTRY_DOCUMENT_(?:WORKER|CALLBACK)|document-worker|apply_document_worker_callback|n8n|googleapis|drive\.google/i;
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && banned.test(readFileSync(full, "utf8"))) offenders.push(name);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, []);
});

test("no raw fetch signing or hand-written SigV4 in server document code", () => {
  for (const file of ["../../../lib/direct-entry/r2-document-storage.ts", "../../../lib/direct-entry/document-api.ts", "../../../lib/direct-entry/document-finalize-api.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /\bfetch\s*\(|AWS4-HMAC|createHmac|X-Amz-Signature/);
  }
  assert.match(read("../../../lib/direct-entry/r2-document-storage.ts"), /@aws-sdk\/s3-request-presigner/);
});

test("live and demo boundaries keep upload API calls out of the synthetic demo component", () => {
  const live = read("../../../components/direct-entry/direct-entry-live.tsx");
  const shell = read("../../../components/direct-entry/direct-entry-shell.tsx");
  const demo = shell.slice(shell.indexOf("function DemoDirectEntryShell"), shell.indexOf("export function DirectEntryShell"));
  assert.match(live, /DirectEntryDocumentEditor/);
  assert.doesNotMatch(demo, /\/api\/direct-entry\/entries\/.*\/documents|DirectEntryDocumentEditor/);
  assert.doesNotMatch(live, /INITIAL_DIRECT_ENTRY_ROWS/);
});