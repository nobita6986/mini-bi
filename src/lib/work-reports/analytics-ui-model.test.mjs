import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appendUniqueContributions, contributionPageUrl } from "./analytics-ui-model.mjs";

const component = await readFile(new URL("../../components/work-reports/analytics/work-report-analytics.tsx", import.meta.url), "utf8");

test("contribution pages retain filters and cursor while loading over 100 unique rows", () => {
  const filters = new URLSearchParams({ template_id: "template", team_id: "team", finality: "final", metric_key: "workers_started", target_team_id: "target-team" });
  const firstUrl = new URL(contributionPageUrl(filters.toString()), "https://mini-bi.test");
  assert.equal(firstUrl.searchParams.get("limit"), "100");
  assert.equal(firstUrl.searchParams.has("cursor"), false);

  const firstPage = Array.from({ length: 100 }, (_, index) => ({ obligation_id: `obligation-${index}` }));
  const secondUrl = new URL(contributionPageUrl(filters.toString(), "page-2"), "https://mini-bi.test");
  assert.equal(secondUrl.searchParams.get("cursor"), "page-2");
  assert.equal(secondUrl.searchParams.get("template_id"), "template");
  assert.equal(secondUrl.searchParams.get("target_team_id"), "target-team");
  assert.equal(secondUrl.searchParams.get("metric_key"), "workers_started");

  const secondPage = [
    ...Array.from({ length: 5 }, (_, index) => ({ obligation_id: `obligation-${index + 98}` })),
    ...Array.from({ length: 5 }, (_, index) => ({ obligation_id: `obligation-${index + 100}` })),
  ];
  const combined = appendUniqueContributions(firstPage, secondPage);
  assert.equal(combined.length, 105);
  assert.equal(new Set(combined.map((item) => item.obligation_id)).size, 105);
  assert.deepEqual(combined.slice(-5).map((item) => item.obligation_id), Array.from({ length: 5 }, (_, index) => `obligation-${index + 100}`));
});

test("dashboard resets pagination for new queries and exposes cursor load-more", () => {
  assert.match(component, /setContributionQuery\(null\); setNextCursor\(null\)/);
  assert.match(component, /contributionPageUrl\(contributionQuery, nextCursor\)/);
  assert.match(component, /appendUniqueContributions\(current, result\.items\)/);
  assert.match(component, /<CursorLoadMore hasMore=\{nextCursor !== null\}/);
});
