/**
 * Project↔Team batch UI regression probes.
 * Each probe runs the focused tests, restores the exact original bytes, and
 * verifies the changed source file has its original SHA-256.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const MODEL = "src/lib/admin/project-team-scope-ui-model.ts";
const COMPONENT = "src/components/admin/project-team-scope-manager.tsx";
const LANE = [
  "--test",
  "src/lib/admin/project-team-scope-ui-model.test.mjs",
  "src/components/admin/project-team-scope-manager.test.mjs",
];

function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`mutation anchor missing: ${from}`);
  return source.replace(from, to);
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const probes = [
  {
    label: "truncate multi-project grant payload",
    file: MODEL,
    mutate: (source) => replace(source,
      "project_ids: [...input.projectIds],",
      "project_ids: input.projectIds.slice(0, 1),"),
  },
  {
    label: "restore client-supplied revoke version",
    file: MODEL,
    mutate: (source) => replace(source,
      "mapping_id: input.mappingId,",
      "mapping_id: input.mappingId, expected_pair_version: 1,"),
  },
  {
    label: "remove separate created/skipped summary",
    file: MODEL,
    mutate: (source) => replace(source,
      "Đã bỏ qua ${skipped.length} dự án đã có mapping hiệu lực",
      "Đã xử lý ${skipped.length} dự án"),
  },
  {
    label: "replace project checkbox with non-checkbox control",
    file: COMPONENT,
    mutate: (source) => replace(source,
      'type="checkbox" checked={checked}',
      'type="text" checked={checked}'),
  },
];

const originals = new Map();
for (const probe of probes) {
  if (!originals.has(probe.file)) originals.set(probe.file, await readFile(path.join(ROOT, probe.file)));
}
const initialHashes = new Map([...originals].map(([file, bytes]) => [file, hash(bytes)]));
const results = [];

async function laneIsRed() {
  try {
    await run(process.execPath, LANE, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    return false;
  } catch (error) {
    return error.code !== 0;
  }
}

try {
  for (const probe of probes) {
    const original = originals.get(probe.file);
    try {
      await writeFile(path.join(ROOT, probe.file), probe.mutate(original.toString("utf8")), "utf8");
      const red = await laneIsRed();
      results.push({ label: probe.label, red });
      console.log(`${red ? "RED   " : "GREEN "}${probe.label}`);
    } finally {
      await writeFile(path.join(ROOT, probe.file), original);
    }
  }
} finally {
  for (const [file, bytes] of originals) await writeFile(path.join(ROOT, file), bytes);
}

const restorationChecks = await Promise.all([...originals].map(async ([file]) =>
  hash(await readFile(path.join(ROOT, file))) === initialHashes.get(file)));
const missed = results.filter((result) => !result.red);
const byteIdentical = restorationChecks.every(Boolean);
console.log(`\nmutation probes red: ${results.length - missed.length}/${results.length}`);
console.log(`sources restored byte-for-byte: ${byteIdentical}`);
if (missed.length || !byteIdentical) process.exitCode = 1;
