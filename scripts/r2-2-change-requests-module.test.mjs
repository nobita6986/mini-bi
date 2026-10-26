import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideChangeRequestsPageAccess,
  HISTORICAL_CHANGE_REQUEST_QUEUES,
  probeHistoricalChangeRequestAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import {
  changeRequestWorkspaceTabs,
  canReviewChangeRequests,
  canViewGlobalChangeRequestHistory,
  initialChangeRequestQueue,
  initialChangeRequestWorkspaceMode,
  requestsQuery,
} from "../src/lib/direct-entry/worker-operations-model.ts";
import {
  CURRENT_NAV_ENTRIES,
  filterEntriesForActor,
} from "../src/lib/navigation/registry.ts";
import {
  changeRequestsNavPredicate,
  changeRequestsReviewerPredicate,
  decideNavEntryVisibility,
} from "../src/lib/navigation/registry-capability.ts";

function readRepoFile(relPath) {
  return readFileSync(new URL("../" + relPath, import.meta.url), "utf8");
}

function makeActor(capabilities, scopes = []) {
  return {
    auth_subject: "sub-1",
    app_user_id: "user-1",
    enabled: true,
    capabilities,
    scopes,
    self_recruiter_suggestion: null,
    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
  };
}

test("WP-2.2.1: change request route and permission stay available while global navigation is hidden", () => {
  const item = CURRENT_NAV_ENTRIES.find((entry) => entry.id === "change-requests");
  assert.ok(item, "change-requests nav item exists");
  assert.equal(item.label, "Yêu cầu thay đổi");
  assert.equal(item.path, "/direct-entry/change-requests");
  assert.equal(item.capability, "change_requests");
  assert.deepEqual(item.visibility, { desktop: false, mobile: false });

  const staff = makeActor(["entry_own", "change_request_create"], [{ kind: "own", reference: "user-1" }]);
  const leader = makeActor(["team_manager_assign", "change_review"], [{ kind: "team", reference: "team-a" }]);
  const admin = makeActor(["entry_admin", "change_review"], [{ kind: "all", reference: "all" }]);
  const noAccess = makeActor(["pii_view"], [{ kind: "own", reference: "user-1" }]);

  assert.equal(changeRequestsNavPredicate(staff), true);
  assert.equal(changeRequestsNavPredicate(leader), true);
  assert.equal(changeRequestsNavPredicate(admin), true);
  assert.equal(changeRequestsNavPredicate(noAccess), false);

  const visibleIds = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled: true,
    actor: staff,
    decide: (entry) =>
      decideNavEntryVisibility({
        capabilityKey: entry.capability,
        actor: staff,
        viewport: "desktop",
        entryVisibleInViewport: entry.visibility.desktop,
      }),
  }).map((nav) => nav.id);
  assert.ok(!visibleIds.includes("change-requests"));
});

test("WP-2.2.1: server page gate admits current proposers/reviewers and active historical proposers fail-closed", () => {
  const proposer = { ok: true, actor: makeActor(["change_request_create"], [{ kind: "own", reference: "user-1" }]) };
  const reviewer = { ok: true, actor: makeActor(["change_review"], [{ kind: "team", reference: "team-a" }]) };
  const reassignedActive = { ok: true, actor: makeActor(["pii_view"], []) };
  const disabled = { ok: false, reason: "ACTOR_DISABLED" };

  assert.equal(decideChangeRequestsPageAccess({ uiEnabled: false, actor: proposer }), "NOT_FOUND");
  assert.equal(decideChangeRequestsPageAccess({ uiEnabled: true, actor: proposer }), "ALLOW");
  assert.equal(decideChangeRequestsPageAccess({ uiEnabled: true, actor: reviewer }), "ALLOW");
  assert.equal(decideChangeRequestsPageAccess({ uiEnabled: true, actor: reassignedActive }), "ACCESS_DENIED");
  assert.equal(
    decideChangeRequestsPageAccess({ uiEnabled: true, actor: reassignedActive, hasHistoricalRequests: true }),
    "ALLOW",
    "active actor who previously submitted requests can view their immutable request history",
  );
  assert.equal(
    decideChangeRequestsPageAccess({ uiEnabled: true, actor: disabled, hasHistoricalRequests: true }),
    "ACCOUNT_UNAVAILABLE",
  );

  const pageSource = readRepoFile("src/app/direct-entry/change-requests/page.tsx");
  assert.match(pageSource, /decideChangeRequestsPageAccess/);
  assert.match(pageSource, /resolveChangeRequestHistoricalAccessForRequest/);
  assert.doesNotMatch(pageSource, /state:\s*null/);
  assert.match(pageSource, /<ChangeRequestsWorkspace/);
});

test("R2.2 Post-merge P0: explicit historical queue probe preserves access for active proposers and deciders after losing current authority", async () => {
  assert.deepEqual(HISTORICAL_CHANGE_REQUEST_QUEUES, [
    "PROPOSER_PENDING",
    "PROPOSER_RESOLVED",
    "REVIEWER_RESOLVED",
  ]);

  const noCurrentAuthority = { ok: true, actor: makeActor([], []) };

  const pendingProposerProbe = await probeHistoricalChangeRequestAccess({
    auth_subject: "sub-p1",
    app_user_id: "user-p1",
    listChangeRequests: async (query) => ({
      ok: true,
      data: { requests: query.state === "PROPOSER_PENDING" ? [{ request_id: "r1" }] : [] },
    }),
  });
  assert.equal(
    decideChangeRequestsPageAccess({
      uiEnabled: true,
      actor: noCurrentAuthority,
      historicalProbe: pendingProposerProbe,
    }),
    "ALLOW",
  );
  assert.equal(
    initialChangeRequestWorkspaceMode({
      canReview: false,
      canPropose: false,
      ...pendingProposerProbe,
    }),
    "proposer",
  );
  assert.equal(
    initialChangeRequestQueue({
      canReview: false,
      canPropose: false,
      ...pendingProposerProbe,
    }),
    "PROPOSER_PENDING",
  );

  const resolvedProposerProbe = await probeHistoricalChangeRequestAccess({
    auth_subject: "sub-p2",
    app_user_id: "user-p2",
    listChangeRequests: async (query) => ({
      ok: true,
      data: { requests: query.state === "PROPOSER_RESOLVED" ? [{ request_id: "r2" }] : [] },
    }),
  });
  assert.equal(
    decideChangeRequestsPageAccess({
      uiEnabled: true,
      actor: noCurrentAuthority,
      historicalProbe: resolvedProposerProbe,
    }),
    "ALLOW",
  );
  assert.equal(
    initialChangeRequestWorkspaceMode({
      canReview: false,
      canPropose: false,
      ...resolvedProposerProbe,
    }),
    "proposer",
  );
  assert.equal(
    initialChangeRequestQueue({
      canReview: false,
      canPropose: false,
      ...resolvedProposerProbe,
    }),
    "PROPOSER_RESOLVED",
  );

  const formerDeciderProbe = await probeHistoricalChangeRequestAccess({
    auth_subject: "sub-d1",
    app_user_id: "user-d1",
    listChangeRequests: async (query) => ({
      ok: true,
      data: { requests: query.state === "REVIEWER_RESOLVED" ? [{ request_id: "r3" }] : [] },
    }),
  });
  assert.equal(
    decideChangeRequestsPageAccess({
      uiEnabled: true,
      actor: noCurrentAuthority,
      historicalProbe: formerDeciderProbe,
    }),
    "ALLOW",
  );
  assert.equal(
    initialChangeRequestWorkspaceMode({
      canReview: false,
      canPropose: false,
      ...formerDeciderProbe,
    }),
    "reviewer",
  );
  assert.equal(
    initialChangeRequestQueue({
      canReview: false,
      canPropose: false,
      ...formerDeciderProbe,
    }),
    "REVIEWER_RESOLVED",
  );

  const navActorWithHistory = {
    capabilities: [],
    scopes: [],
    hasHistoricalChangeRequests: true,
  };
  assert.equal(
    changeRequestsNavPredicate(navActorWithHistory),
    true,
    "the route predicate still recognizes historical access while the global menu entry is hidden",
  );
});

test("R2.2 Post-merge P1: DirectEntryChangeRequestList exposes Xem chi tiết for all non-decidable items including PENDING", () => {
  const listSource = readRepoFile("src/components/direct-entry/direct-entry-change-request-list.tsx");
  assert.match(listSource, /canReviewChangeRequest\(request\) && \([\s\S]{0,350}Xem xét/);
  assert.match(listSource, /!canReviewChangeRequest\(request\) && \([\s\S]{0,350}Xem chi tiết/);
  assert.match(listSource, /canWithdrawChangeRequest\(request\) && \([\s\S]{0,400}Rút yêu cầu/);
  assert.doesNotMatch(listSource, /request\.state !== "PENDING" && \([\s\S]{0,200}Xem chi tiết/);
});

test("WP-2.2.1: 4 business queues + GLOBAL_AUDIT tabs and query builder match R2.1/R2.2 contract", () => {
  assert.equal(initialChangeRequestWorkspaceMode(false), "proposer");
  assert.equal(initialChangeRequestWorkspaceMode(true), "reviewer");
  assert.equal(initialChangeRequestQueue(false), "PROPOSER_PENDING");
  assert.equal(initialChangeRequestQueue(true), "REVIEWER_PENDING");

  const proposerTabs = changeRequestWorkspaceTabs({ mode: "proposer", canViewGlobalHistory: false });
  assert.deepEqual(proposerTabs, [
    { value: "PROPOSER_PENDING", label: "Tôi đã gửi" },
    { value: "PROPOSER_RESOLVED", label: "Lịch sử gửi" },
  ]);

  const teamReviewerTabs = changeRequestWorkspaceTabs({ mode: "reviewer", canViewGlobalHistory: false });
  assert.deepEqual(teamReviewerTabs, [
    { value: "REVIEWER_PENDING", label: "Chờ tôi duyệt" },
    { value: "REVIEWER_RESOLVED", label: "Lịch sử duyệt" },
  ]);

  const globalReviewerTabs = changeRequestWorkspaceTabs({ mode: "reviewer", canViewGlobalHistory: true });
  assert.deepEqual(globalReviewerTabs, [
    { value: "REVIEWER_PENDING", label: "Chờ tôi duyệt" },
    { value: "REVIEWER_RESOLVED", label: "Lịch sử duyệt" },
    { value: "GLOBAL_AUDIT", label: "Lịch sử toàn hệ thống" },
  ]);

  assert.equal(requestsQuery(null, "PROPOSER_PENDING"), "?page_size=20&state=PROPOSER_PENDING");
  assert.equal(requestsQuery(null, "PROPOSER_RESOLVED"), "?page_size=20&state=PROPOSER_RESOLVED");
  assert.equal(requestsQuery(null, "REVIEWER_PENDING"), "?page_size=20&state=REVIEWER_PENDING");
  assert.equal(requestsQuery(null, "REVIEWER_RESOLVED"), "?page_size=20&state=REVIEWER_RESOLVED");
  assert.equal(requestsQuery(null, "GLOBAL_AUDIT", "7"), "?page_size=20&state=GLOBAL_AUDIT&days=7");

  assert.equal(
    changeRequestsReviewerPredicate({ capabilities: ["change_review"], scopes: [{ kind: "team" }] }),
    true,
    "Team Leader with change_review@team enters reviewer mode",
  );
  assert.equal(
    changeRequestsReviewerPredicate({ capabilities: ["team_manager_assign"], scopes: [{ kind: "team" }] }),
    true,
    "Team Leader with team_manager_assign@team enters reviewer mode",
  );
  assert.equal(
    canReviewChangeRequests({ capabilities: ["change_review"], scopes: [{ kind: "all" }] }),
    true,
    "All-scope reviewer passes canReviewChangeRequests",
  );
  assert.equal(
    canViewGlobalChangeRequestHistory(["change_review"], [{ kind: "team" }]),
    false,
    "Team Leader does not receive global audit tab",
  );
  assert.equal(
    canViewGlobalChangeRequestHistory(["change_review"], [{ kind: "all" }]),
    true,
    "All-scope reviewer receives global audit tab",
  );
});

test("WP-2.2.1 P0: DirectEntryChangeRequestReviewer enforces read-only snapshot mode when state !== PENDING or !can_decide", () => {
  const reviewerSource = readRepoFile("src/components/direct-entry/direct-entry-change-request-reviewer.tsx");
  assert.match(reviewerSource, /const terminal = detail\.state !== "PENDING"/);
  assert.match(reviewerSource, /const readOnlyView = terminal \|\| !detail\.can_decide/);
  const readOnlyBranchIndex = reviewerSource.indexOf("if (readOnlyView)");
  const entryFetchIndex = reviewerSource.indexOf('"/api/direct-entry/entries/"');
  assert.ok(readOnlyBranchIndex > 0 && entryFetchIndex > readOnlyBranchIndex,
    "readOnlyView branch returns before /api/direct-entry/entries/[entryId] is ever called");
  const readOnlyBlock = reviewerSource.slice(readOnlyBranchIndex, entryFetchIndex);
  assert.match(readOnlyBlock, /kind:\s*"terminal"/);
  assert.match(readOnlyBlock, /return;/);
  assert.match(reviewerSource, /const canDecide = loadState === "ready" && model\?\.kind === "reviewable"/);
  assert.match(reviewerSource, /const canReject = request\?\.state === "PENDING" && request\.can_decide === true/);
});

test("WP-2.2.2: /direct-entry hides change-request actions, replaces window.confirm, and polishes CSS tokens", () => {
  const liveSource = readRepoFile("src/components/direct-entry/direct-entry-live.tsx");
  const workerOpsSource = readRepoFile("src/components/direct-entry/worker-operations.tsx");
  const shellCss = readRepoFile("src/components/direct-entry/direct-entry-shell.module.css");
  const gridCss = readRepoFile("src/components/direct-entry/direct-entry-spreadsheet-grid.module.css");

  assert.equal(liveSource.includes("DirectEntryChangeRequestList"), false);
  assert.equal(liveSource.includes("DirectEntryChangeRequestReviewer"), false);
  assert.equal(liveSource.includes("DirectEntryChangeRequestProposer"), false);
  assert.doesNotMatch(liveSource, /href="\/direct-entry\/change-requests"/);
  assert.doesNotMatch(workerOpsSource, /href="\/direct-entry\/change-requests"/);

  assert.equal(liveSource.includes("window.confirm"), false, "no native window.confirm in direct-entry-live.tsx");
  assert.match(liveSource, /data-testid="confirm-delete-draft-row-dialog"/);

  assert.equal(shellCss.includes("var(--destructive"), false);
  assert.equal(shellCss.includes("var(--danger"), false);
  assert.equal(shellCss.includes("var(--success"), false);
  assert.equal(shellCss.includes("var(--text-muted"), false);
  assert.equal(gridCss.includes("var(--destructive"), false);
  assert.match(shellCss, /var\(--semantic-error/);
  assert.match(gridCss, /var\(--semantic-error/);
});

test("WP-2.2.3: shared UI primitives are genuinely reused across >= 2 consumer modules", () => {
  const workspaceSource = readRepoFile("src/components/direct-entry/change-requests-workspace.tsx");
  const liveSource = readRepoFile("src/components/direct-entry/direct-entry-live.tsx");
  const workerOpsSource = readRepoFile("src/components/direct-entry/worker-operations.tsx");
  const vendorManager = readRepoFile("src/components/admin/vendor-catalog-manager.tsx");
  const projectTeamManager = readRepoFile("src/components/admin/project-team-scope-manager.tsx");
  const formBuilderSource = readRepoFile("src/components/work-reports/form-builder/form-builder.tsx");
  const reviewInboxSource = readRepoFile("src/components/work-reports/renderer/review-inbox.tsx");
  const obligationsSource = readRepoFile("src/components/work-reports/renderer/my-obligations.tsx");

  assert.match(workspaceSource, /from "@\/components\/ui\/notify-provider"/);
  assert.equal(workspaceSource.includes("change-request-workspace-notice"), false);
  assert.match(formBuilderSource, /from "@\/components\/ui\/status-banner"/);
  assert.match(reviewInboxSource, /from "@\/components\/ui\/status-banner"/);
  assert.match(obligationsSource, /from "@\/components\/ui\/status-banner"/);

  assert.match(workspaceSource, /from "@\/components\/ui\/cursor-load-more"/);
  assert.match(workerOpsSource, /from "@\/components\/ui\/cursor-load-more"/);

  assert.match(vendorManager, /from "@\/components\/ui\/offset-pager"/);
  assert.match(projectTeamManager, /from "@\/components\/ui\/offset-pager"/);

  assert.match(vendorManager, /from "@\/components\/ui\/form-dialog"/);
  assert.match(projectTeamManager, /from "@\/components\/ui\/form-dialog"/);
});
