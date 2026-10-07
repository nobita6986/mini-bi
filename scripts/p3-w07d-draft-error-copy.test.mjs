/**
 * P3-W07D - draft load error copy + the two boundary deltas in the TS layer.
 *
 * Source-string + pure-module test: the operator copy must be exactly the two
 * sentences the W07D contract names, and the request layer must stop resolving
 * the patch catalog at the row's historical first_work_date.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  DRAFT_SCOPE_DENIED,
  DRAFTS_UNAVAILABLE,
  draftLoadErrorMessage,
} from "../src/lib/direct-entry/draft-error-copy.ts";

const SCOPE_COPY =
  "Không tải được bản nháp do phạm vi quyền chưa phù hợp. Mã lỗi: DRAFT_SCOPE_DENIED.";
const BUSY_COPY =
  "Không tải được bản nháp do máy chủ đang bận. Mã lỗi: DRAFTS_UNAVAILABLE.";

const DRAFT_API = path.resolve("src/lib/direct-entry/draft-api.ts");
const LIVE_COMPONENT = path.resolve("src/components/direct-entry/direct-entry-live.tsx");

test("W07D copy: the two contract sentences are rendered verbatim", () => {
  assert.equal(draftLoadErrorMessage(DRAFT_SCOPE_DENIED), SCOPE_COPY);
  assert.equal(draftLoadErrorMessage(DRAFTS_UNAVAILABLE), BUSY_COPY);
  assert.equal(DRAFT_SCOPE_DENIED, "DRAFT_SCOPE_DENIED");
  assert.equal(DRAFTS_UNAVAILABLE, "DRAFTS_UNAVAILABLE");
});

test("W07D copy: other statuses keep the pre-existing sanitized sentence", () => {
  assert.equal(draftLoadErrorMessage("DIRECT_ENTRY_UNAVAILABLE"),
    "Không tải được Direct Entry (DIRECT_ENTRY_UNAVAILABLE).");
  assert.equal(draftLoadErrorMessage("SESSION_UNAVAILABLE"),
    "Không tải được Direct Entry (SESSION_UNAVAILABLE).");
  assert.equal(draftLoadErrorMessage(null),
    "Không tải được Direct Entry (DRAFTS_UNAVAILABLE).");
  assert.equal(draftLoadErrorMessage(undefined),
    "Không tải được Direct Entry (DRAFTS_UNAVAILABLE).");
  assert.equal(draftLoadErrorMessage(""),
    "Không tải được Direct Entry (DRAFTS_UNAVAILABLE).");
});

test("W07D copy: no message can carry SQL text, a UUID or provider wording", () => {
  const forbidden = [
    "42501", "errcode", "SQLSTATE", "pg_", "direct_entry_",
    "provider", "vendor", "team_id", "scope_kind",
    "027b623c-0ff6-48eb-bbad-a329209d947f",
  ];
  const codes = [DRAFT_SCOPE_DENIED, DRAFTS_UNAVAILABLE, "DIRECT_ENTRY_UNAVAILABLE", null, undefined];
  for (const code of codes) {
    const message = draftLoadErrorMessage(code);
    for (const needle of forbidden) {
      assert.equal(message.includes(needle), false,
        "draft load copy must not contain " + needle);
    }
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(message), false,
      "draft load copy must not contain an identifier");
  }
});

test("W07D draft PATCH resolves the page catalog at today's HCM date", async () => {
  const source = await readFile(DRAFT_API, "utf8");
  assert.equal(source.includes("effective_date: todayDateIso()"), true);
  assert.equal(source.includes("parsed.patch.first_work_date"), false,
    "the patch catalog must not follow the row's historical work date");
  assert.equal(source.includes('import { todayDateIso } from "../format.ts";'), true);
  // The list boundary answers the dedicated scope code, not the legacy one.
  assert.equal(source.includes('if (result.kind === "denied") return fail(DRAFT_SCOPE_DENIED, 403);'), true);
  assert.equal(source.includes('return fail("ACTOR_NOT_AVAILABLE", 403);\n    }\n    return respond({\n      ok: true,\n      projection_version'), false);
});

test("W07D live component surfaces the sanitized server code", async () => {
  const source = await readFile(LIVE_COMPONENT, "utf8");
  assert.equal(source.includes('throw new Error("DRAFTS_UNAVAILABLE")'), false,
    "the load paths must forward the server code instead of hardcoding the transient one");
  assert.equal(source.includes("draftLoadErrorMessage(loadMessage)"), true);
  assert.equal(source.includes("Không tải được Direct Entry (${loadMessage})"), false);
  // Both draft load paths (initial load + reload) fall back to the sanitized
  // constant instead of a hardcoded literal; the catalog path keeps its own.
  assert.equal((source.match(/: DRAFTS_UNAVAILABLE/g) ?? []).length, 2,
    "both draft load paths must fall back to the sanitized server code constant");
  // The reload path keeps one line; the initial load path wraps, so it is
  // asserted by its parts instead of by whitespace-sensitive formatting.
  assert.equal(source.includes("isRecord(body) && typeof body.code === \"string\" ? body.code : DRAFTS_UNAVAILABLE"), true);
  assert.equal(source.includes("isRecord(draftBody) && typeof draftBody.code === \"string\""), true);
  assert.equal(source.includes("? draftBody.code"), true);
});
