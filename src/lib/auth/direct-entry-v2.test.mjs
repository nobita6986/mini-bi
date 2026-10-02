import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  authorizeDirectEntry,
  resolveActor,
  resolveSelfRecruiterSuggestion,
  validateClientBusinessPayload,
} from "./direct-entry-v2.ts";

const fixture = JSON.parse(readFileSync(
  new URL("../../../docs/contracts/fixtures/p1.6-w02/auth-fixture.json", import.meta.url),
  "utf8",
));
const timestamp = fixture.as_of;
const resourceRef = "00000000-0000-4000-8000-00000000a001";

function repositoryFor(person) {
  return {
    async loadByAuthSubject(authSubject) {
      return authSubject === person.auth_subject ? structuredClone(person.record) : null;
    },
  };
}

async function actorFor(person) {
  const result = await resolveActor({
    session: {
      auth_subject: person.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(person),
    at: timestamp,
  });
  assert.equal(result.ok, true);
  return result.actor;
}

function ownResource(appUserId, currentVersion = 1) {
  return {
    reference: resourceRef,
    owner_user_id: appUserId,
    current_version: currentVersion,
    scope: {
      kind: "own",
      reference: appUserId,
      effective_date: "2026-10-02",
    },
  };
}

function teamResource(teamId = "team_synthetic_01", date = "2026-10-02") {
  return {
    reference: resourceRef,
    owner_user_id: null,
    current_version: 1,
    scope: { kind: "team", reference: teamId, effective_date: date },
  };
}

test("versioned actor contract resolves only trusted Supabase subject mapping", async () => {
  const actor = await actorFor(fixture.staff);
  assert.equal(actor.app_user_id, fixture.staff.record.app_user_id);
  assert.equal(actor.auth_subject, fixture.staff.auth_subject);
  assert.equal(actor.enabled, true);
  assert.equal(actor.session.provider, "supabase");
  assert.equal(actor.session.verification, "getUser");
  assert.equal("role" in actor, false);
});

test("missing authentication, disabled actor, and repository failures deny closed", async () => {
  assert.deepEqual(await resolveActor({
    session: null,
    repository: repositoryFor(fixture.admin),
    at: timestamp,
  }), { ok: false, reason: "UNAUTHENTICATED" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.disabled.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(fixture.disabled),
    at: timestamp,
  }), { ok: false, reason: "ACTOR_DISABLED" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: undefined,
    at: timestamp,
  }), { ok: false, reason: "ACTOR_REPOSITORY_MISSING" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: { async loadByAuthSubject() { return { app_user_id: "bad" }; } },
    at: timestamp,
  }), { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
  const wrongMapping = structuredClone(fixture.staff.record);
  wrongMapping.auth_subject = fixture.admin.auth_subject;
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: { async loadByAuthSubject() { return wrongMapping; } },
    at: timestamp,
  }), { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(fixture.admin),
    at: timestamp,
  }), { ok: false, reason: "ACTOR_MAPPING_MISSING" });
});

test("an ordinary staff member can create and act only in own scope", async () => {
  const actor = await actorFor(fixture.staff);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_create",
    resource: { ...ownResource(actor.app_user_id, null), current_version: null },
    timestamp,
  }).allowed, true);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_own",
    resource: ownResource(actor.app_user_id),
    timestamp,
    expected_version: 1,
  }).allowed, true);
  for (const action of ["submission_create", "change_request_create"]) {
    assert.equal(authorizeDirectEntry({
      actor,
      action,
      resource: ownResource(actor.app_user_id),
      timestamp,
      expected_version: 1,
    }).allowed, true, action);
  }

  const outside = authorizeDirectEntry({
    actor,
    action: "entry_own",
    resource: ownResource(fixture.admin.record.app_user_id),
    timestamp,
    expected_version: 1,
  });
  assert.equal(outside.allowed, false);
  assert.equal(outside.code, "SCOPE_DENIED");
});

test("client-supplied actor, role, capability, and scope fields are rejected", () => {
  assert.deepEqual(validateClientBusinessPayload({
    project_id: "project_synthetic_01",
    worker: { display_name: "Synthetic Person" },
  }), { ok: true });
  for (const payload of [
    { app_user_id: fixture.admin.record.app_user_id },
    { role: "admin" },
    { capabilities: ["entry_admin"] },
    { scope: { kind: "all", reference: "all" } },
    { entry: { actor_id: fixture.admin.record.app_user_id } },
    { entry: { appUserId: fixture.admin.record.app_user_id } },
  ]) {
    assert.equal(validateClientBusinessPayload(payload).ok, false);
  }
});

test("ID equality never links recruiter and app user without a verified effective link", async () => {
  const actor = await actorFor(fixture.staff);
  assert.equal(actor.self_recruiter_suggestion, null);
  assert.equal(resolveSelfRecruiterSuggestion({
    app_user_id: fixture.staff.record.app_user_id,
    date: "2026-10-02",
    links: [],
  }).kind, "none");
  assert.equal(resolveSelfRecruiterSuggestion({
    app_user_id: fixture.staff.record.app_user_id,
    date: "2026-10-02",
    links: [{
      app_user_id: fixture.staff.record.app_user_id,
      recruiter_id: fixture.staff.record.app_user_id,
      verified: false,
      valid_from: "2026-01-01",
      valid_to: null,
    }],
  }).kind, "none");
});

test("a verified recruiter link gives a suggestion but grants no capability", async () => {
  const noTeamScope = structuredClone(fixture.leader);
  noTeamScope.record.team_scope_grants = [];
  const actor = await actorFor(noTeamScope);
  assert.equal(actor.self_recruiter_suggestion, "rcr_synthetic_01");
  assert.deepEqual(actor.capabilities, ["entry_team", "change_review"]);
  assert.equal(actor.scopes.some((scope) => scope.kind === "team"), false);
  const leader = await actorFor(fixture.leader);
  assert.deepEqual(actor.scopes.filter((scope) => scope.kind === "team").map((scope) => ({
    reference: scope.reference,
    valid_from: scope.valid_from,
    valid_to: scope.valid_to,
  })), []);
  assert.deepEqual(leader.scopes.filter((scope) => scope.kind === "team").map((scope) => ({
    reference: scope.reference,
    valid_from: scope.valid_from,
    valid_to: scope.valid_to,
  })), [{
    reference: "team_synthetic_01",
    valid_from: "2026-09-01",
    valid_to: "2026-10-03",
  }]);
});

test("ambiguous recruiter links and team scope grants fail closed", async () => {
  const overlappingLinkPerson = structuredClone(fixture.leader);
  overlappingLinkPerson.record.recruiter_links.push({
    ...overlappingLinkPerson.record.recruiter_links[0],
    recruiter_id: "rcr_synthetic_02",
  });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: overlappingLinkPerson.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(overlappingLinkPerson),
    at: timestamp,
  }), { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" });

  const overlappingTeamPerson = structuredClone(fixture.leader);
  overlappingTeamPerson.record.team_scope_grants.push({
    ...overlappingTeamPerson.record.team_scope_grants[0],
    valid_from: "2026-10-01",
  });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: overlappingTeamPerson.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(overlappingTeamPerson),
    at: timestamp,
  }), { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" });
});

test("leader scope is effective-dated and checks stable P1.5 team IDs", async () => {
  const actor = await actorFor(fixture.leader);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_team",
    resource: teamResource(),
    timestamp,
    expected_version: 1,
  }).allowed, true);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "change_review",
    resource: teamResource(),
    timestamp,
    reason_ref: "reason_synthetic_01",
    expected_version: 1,
  }).allowed, true);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_team",
    resource: teamResource("team_synthetic_other"),
    timestamp,
    expected_version: 1,
  }).code, "SCOPE_DENIED");
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_team",
    resource: teamResource("team_synthetic_01", "2026-10-03"),
    timestamp,
    expected_version: 1,
  }).code, "SCOPE_DENIED");
});

test("accounting receives only explicitly granted review, status, and payment capabilities", async () => {
  const actor = await actorFor(fixture.accounting);
  for (const action of [
    "change_review",
    "entry_privileged_edit",
    "employment_status.apply",
    "payment_view",
    "payment_edit",
  ]) {
    const decision = authorizeDirectEntry({
      actor,
      action,
      resource: { ...ownResource(fixture.admin.record.app_user_id, 3), scope: {
        kind: "all",
        reference: "all",
        effective_date: "2026-10-02",
      } },
      timestamp,
      reason_ref: "reason_synthetic_01",
      expected_version: 3,
    });
    assert.equal(decision.allowed, true, action);
  }
  assert.equal(authorizeDirectEntry({
    actor,
    action: "pii_export",
    resource: teamResource(),
    timestamp,
  }).code, "CAPABILITY_DENIED");
  assert.equal(authorizeDirectEntry({
    actor,
    action: "document_view",
    resource: teamResource(),
    timestamp,
  }).code, "CAPABILITY_DENIED");
  assert.equal(authorizeDirectEntry({
    actor,
    action: "payment_view",
    resource: {
      ...ownResource(fixture.admin.record.app_user_id, 3),
      scope: {
        kind: "own",
        reference: fixture.admin.record.app_user_id,
        effective_date: "2025-12-31",
      },
    },
    timestamp,
  }).code, "SCOPE_DENIED");
});

test("ordinary users cannot invoke privileged edits; admins require reason, version, and audit", async () => {
  const staff = await actorFor(fixture.staff);
  const staffDecision = authorizeDirectEntry({
    actor: staff,
    action: "entry_privileged_edit",
    resource: ownResource(staff.app_user_id),
    timestamp,
    reason_ref: "reason_synthetic_01",
    expected_version: 1,
  });
  assert.equal(staffDecision.code, "CAPABILITY_DENIED");

  const admin = await actorFor(fixture.admin);
  const adminResource = ownResource(admin.app_user_id, 2);
  assert.equal(authorizeDirectEntry({
    actor: admin,
    action: "entry_own",
    resource: adminResource,
    timestamp,
    expected_version: 2,
  }).code, "REASON_REQUIRED");
  assert.equal(authorizeDirectEntry({
    actor: admin,
    action: "entry_own",
    resource: adminResource,
    timestamp,
    reason_ref: "reason_synthetic_01",
  }).code, "EXPECTED_VERSION_REQUIRED");
  const stale = authorizeDirectEntry({
    actor: admin,
    action: "entry_own",
    resource: adminResource,
    timestamp,
    expected_version: 1,
    reason_ref: "reason_synthetic_01",
  });
  assert.equal(stale.code, "VERSION_CONFLICT");
  assert.equal(stale.audit.outcome, "DENY");
  assert.equal(stale.audit.reason_ref, "reason_synthetic_01");
  assert.equal(stale.audit.app_user_id, admin.app_user_id);
  assert.equal(authorizeDirectEntry({
    actor: admin,
    action: "entry_own",
    resource: { ...adminResource, current_version: -1 },
    timestamp,
    expected_version: 0,
    reason_ref: "reason_synthetic_01",
  }).code, "RESOURCE_VERSION_INVALID");
});

test("Basic Auth is not a session or business actor", async () => {
  const decision = await resolveActor({
    session: null,
    repository: repositoryFor(fixture.admin),
    at: timestamp,
  });
  assert.deepEqual(decision, { ok: false, reason: "UNAUTHENTICATED" });
  const auditDecision = authorizeDirectEntry({
    actor: null,
    action: "entry_create",
    resource: ownResource(fixture.admin.record.app_user_id, null),
    timestamp,
  });
  assert.equal(auditDecision.allowed, false);
  assert.equal(auditDecision.audit.outcome, "DENY");
  assert.equal(auditDecision.audit.auth_subject, null);
  assert.equal(auditDecision.audit.app_user_id, null);
});

test("audit envelopes contain opaque references and no body, claim, token, or PII data", async () => {
  const actor = await actorFor(fixture.accounting);
  const decision = authorizeDirectEntry({
    actor,
    action: "payment_edit",
    resource: {
      ...ownResource(fixture.admin.record.app_user_id, 3),
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
    expected_version: 3,
    reason_ref: "reason_synthetic_01",
  });
  const serialized = JSON.stringify(decision.audit);
  for (const forbidden of ["@", "account_number", "auth_token", "refresh_token", "Synthetic Person"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(decision.audit).sort(), [
    "action",
    "app_user_id",
    "auth_subject",
    "capability",
    "denial_code",
    "outcome",
    "reason_ref",
    "resource_ref",
    "scope",
    "timestamp",
  ]);

  const rawIdentifier = authorizeDirectEntry({
    actor,
    action: "payment_edit",
    resource: {
      ...ownResource(fixture.admin.record.app_user_id, 3),
      reference: "123456789012",
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
    expected_version: 3,
    reason_ref: "reason_synthetic_01",
  });
  assert.equal(rawIdentifier.allowed, false);
  assert.equal(rawIdentifier.audit.resource_ref, null);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "payment_edit",
    resource: ownResource(fixture.admin.record.app_user_id, 3),
    timestamp,
    expected_version: 3,
    reason_ref: "123456789012",
  }).code, "REASON_REQUIRED");
});
