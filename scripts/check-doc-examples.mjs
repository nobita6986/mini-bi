#!/usr/bin/env node
/**
 * Kiểm tra MỌI ví dụ JSON trong contract và handoff bằng chính TypeScript validator.
 *
 * Chạy: pnpm docs:check
 *
 * Mục đích: bảo đảm payload ví dụ T2 copy là hợp lệ (thỏa mọi bất biến), tránh
 * ví dụ lệch khỏi contract. Không chạm database.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  dailyRecruitmentBreakdownPayloadSchema,
  recruitmentSourceFailurePayloadSchema,
  rowIssueSchema,
} from "../src/lib/contracts/daily-recruitment-breakdown.ts";

const DOCS = [
  "docs/contracts/daily-recruitment-breakdown-v0.2.md",
  "docs/handoffs/p0-t1-g1.md",
];

function classify(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return "unknown";
  if ("breakdown" in obj) return "snapshot";
  if ("drive_file_id" in obj && "error_code" in obj) return "source_failure";
  if (Object.keys(obj).length === 3 && "source_row_number" in obj && "issue_level" in obj && "error_code" in obj) return "row_issue";
  if ("outcome" in obj && "run_status" in obj && !("drive_file_id" in obj)) return "response";
  return "unknown";
}

function firstIssueMessage(error) {
  const issue = error?.issues?.[0];
  if (!issue) return "không rõ";
  return (issue.path.join(".") || "(root)") + ": " + issue.message;
}

const results = [];
let failureCount = 0;

async function main() {
  for (const doc of DOCS) {
    const content = await readFile(path.join(process.cwd(), doc), "utf8");
    const fence = /\`\`\`json\n([\s\S]*?)\`\`\`/g;
    let match;
    let index = 0;
    while ((match = fence.exec(content)) !== null) {
      index += 1;
      const label = doc + " #" + index;
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch (error) {
        results.push({ doc, index, label, kind: "json-parse", ok: false, detail: error.message });
        failureCount += 1;
        continue;
      }

      const kind = classify(parsed);
      if (kind === "snapshot") {
        const r = dailyRecruitmentBreakdownPayloadSchema.safeParse(parsed);
        results.push({ doc, index, label, kind, ok: r.success, detail: r.success ? "" : firstIssueMessage(r.error) });
        if (!r.success) failureCount += 1;
      } else if (kind === "source_failure") {
        const r = recruitmentSourceFailurePayloadSchema.safeParse(parsed);
        results.push({ doc, index, label, kind, ok: r.success, detail: r.success ? "" : firstIssueMessage(r.error) });
        if (!r.success) failureCount += 1;
      } else if (kind === "row_issue") {
        const r = rowIssueSchema.safeParse(parsed);
        results.push({ doc, index, label, kind, ok: r.success, detail: r.success ? "" : firstIssueMessage(r.error) });
        if (!r.success) failureCount += 1;
      } else if (kind === "response") {
        const missing = ["outcome", "contract_version", "run_status"].filter((k) => !(k in parsed));
        results.push({ doc, index, label, kind, ok: missing.length === 0, detail: missing.length ? "thiếu field: " + missing.join(", ") : "" });
        if (missing.length) failureCount += 1;
      } else {
        results.push({ doc, index, label, kind, ok: false, detail: "không phân loại được (không phải snapshot/source-failure/row-issue/response)" });
        failureCount += 1;
      }
    }
  }

  console.log("FILE                                                          LOẠI            KẾT QUẢ");
  console.log("----                                                          ----            -------");
  for (const r of results) {
    const ok = r.ok ? "PASS" : "FAIL";
    console.log(
      (path.basename(r.doc) + " #" + r.index).padEnd(62) + " " + r.kind.padEnd(15) + " " + ok + (r.ok ? "" : "  -> " + r.detail)
    );
  }
  console.log("");
  console.log("Tổng: " + results.length + " ví dụ JSON, " + (results.length - failureCount) + " pass, " + failureCount + " fail.");
  if (failureCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("DOC-EXAMPLES CHECK THẤT BẠI:", error.message);
  process.exitCode = 1;
});
