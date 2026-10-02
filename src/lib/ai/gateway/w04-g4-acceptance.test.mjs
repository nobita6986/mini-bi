/**
 * P1.5-W04 — Synthetic G4 acceptance: 12 golden packet G1 + packet do W03 sinh, chạy qua
 * payload minimization → prompt → SCRIPTED provider → output guard → durable job.
 *
 * KHÔNG gọi provider thật. Mọi khẳng định là deterministic.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

import { buildPacketFromSource } from "../packet-builder.mjs";
import { canonicalJson, canonicalHash } from "../engine-shared.mjs";
import { validateAnalysisPacket } from "../../analytics/contracts/analysis-packet.ts";
import { createMemoryAudit, createMemoryQueue } from "./testing/memory-queue.mjs";
import { buildProviderPayload, scanForbiddenKeys, scanForbiddenValues } from "./payload.mjs";
import { validateGeneratedAnalysis } from "./output-guard.mjs";
import { PROMPT_MANIFEST_V1, getPromptManifest } from "./prompt-registry.mjs";
import { SCRIPTED_ADAPTER_VERSION, SCRIPTED_SCENARIOS, createScriptedAdapter } from "./provider.mjs";
import { createAiReportService } from "./service-core.mjs";
import { createDefaultTimeoutSignal } from "./run-one-job.mjs";
import { DEFAULT_POLICY } from "./limits.mjs";
import { buildJobIdentity } from "./job-identity.mjs";
import { computeBackoffMs, decideAfterFailure, canTransition } from "./job-state.mjs";

const ANALYSIS_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-analysis/", import.meta.url);
const IDENT_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const readJson = (base, rel) => JSON.parse(readFileSync(new URL(rel, base), "utf8"));
const baseCatalog = readJson(IDENT_DIR, "catalog.json");

const PROMPT = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
const META = {
  generated_at: "2026-10-12T00:00:00Z",
  generated_from: "reporting-read-model",
  lineage_ref: "1".repeat(64),
  access_scope_hash: "2".repeat(64),
};
const F = (date, project, recruiter, provider, employment, count, sourceKey = "src-a") => ({
  business_date: date,
  project_key: project,
  recruiter_key: recruiter,
  provider_type_key: provider,
  employment_type_key: employment,
  recruited_count: count,
  source_key: sourceKey,
});
const SH = (...keys) => keys.map((key) => ({ source_key: key, status: "covered", quality: "ok", has_current_facts: true }));

function goldenPackets() {
  const dir = new URL("cases/", ANALYSIS_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const row = readJson(ANALYSIS_DIR, "cases/" + name);
      const validated = validateAnalysisPacket(row.packet);
      assert.ok(validated.ok, name + " packet phải hợp lệ");
      return { case_id: row.case_id, packet: validated.value };
    });
}

function w03Packet({ request, facts, catalog = baseCatalog, source_health = SH("src-a") }) {
  const built = buildPacketFromSource({ request, facts, source_health, catalog, metadata: META });
  assert.ok(built.ok, "W03 packet phải hợp lệ: " + (built.ok ? "" : built.code + " " + built.message));
  return built.packet;
}

const WEEK41 = { type: "week", as_of_date: "2026-10-11" };
const teamFacts = [
  F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
  F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  F("2026-10-07", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
];

const degradedSourcePacket = () =>
  w03Packet({
    request: { period: WEEK41 },
    facts: teamFacts,
    source_health: [
      { source_key: "src-a", status: "covered", quality: "ok", has_current_facts: true },
      { source_key: "src-b", status: "stale_snapshot", quality: "partial", has_current_facts: false },
    ],
  });

const teamPartialPacket = () =>
  w03Packet({
    request: { period: WEEK41 },
    facts: [...teamFacts, F("2026-10-08", "proj-gamma", "rec-golf", "vendor", "chính thức", 2)],
  });

const unknownInvalidPacket = () =>
  w03Packet({
    request: { period: WEEK41 },
    facts: [
      F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 2),
      F("2026-10-06", "__unknown__", "rec-bravo", "__invalid__", "thời vụ", 3),
      F("2026-10-06", "proj-beta", "rec-charlie", "hrp", "chính thức", 4),
    ],
  });

const providerFilteredPacket = () =>
  w03Packet({
    request: { period: WEEK41, scope: { filters: { provider_type_keys: ["vendor"] } } },
    facts: [
      F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 2),
      F("2026-10-06", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
    ],
  });

const comparisonUnavailablePacket = () =>
  w03Packet({
    request: { period: { type: "month", as_of_date: "2026-03-30" } },
    facts: [
      F("2026-02-01", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 0),
      F("2026-02-10", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 3),
      F("2026-03-05", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
    ],
  });

function payloadFor(packet) {
  const built = buildProviderPayload(packet, PROMPT);
  assert.ok(built.ok, "payload phải dựng được: " + (built.ok ? "" : built.code + " " + built.message));
  return built.payload;
}

async function runScripted(packet, scenario) {
  const payload = payloadFor(packet);
  const adapter = createScriptedAdapter({ scenario });
  const result = await adapter.generateStructured({
    payload,
    promptManifest: PROMPT,
    modelConfig: { provider_key: "scripted", model_key: "scripted-deterministic-v1", adapter_version: SCRIPTED_ADAPTER_VERSION, timeout_ms: 30000 },
  });
  return { payload, result, guard: result.ok ? validateGeneratedAnalysis(result.structured, packet) : null };
}

function makeService({ queue, audit, packet, scenario, policy = DEFAULT_POLICY, clockMs = Date.parse("2026-10-12T00:00:00Z") }) {
  let nowMs = clockMs;
  const clock = { nowMs: () => nowMs, advance: (ms) => { nowMs += ms; } };
  const service = createAiReportService({
    queue,
    audit,
    packetLoader: async () => ({ ok: true, packet }),
    manifest: PROMPT,
    policy: { config: policy },
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario } },
    timeout: { create: createDefaultTimeoutSignal },
    clock,
  });
  return { service, clock };
}

// R1: runtime chưa có identity catalog authority ⇒ request chỉ đòi project/provider/employment.
const REQUEST = { period: WEEK41, scope: { dimensions: ["project", "provider", "employment"] } };
const IDENTITY_REQUEST = { period: WEEK41, scope: {} };

async function enqueueAndRun({ packet, scenario, service: providedService, clock: providedClock, queue: providedQueue, attempts = 5 }) {
  const queue = providedQueue ?? createMemoryQueue();
  const audit = createMemoryAudit();
  const built = providedService ? { service: providedService, clock: providedClock } : makeService({ queue, audit, packet, scenario });
  const { service, clock } = built;
  const enqueued = await service.enqueueReport({
    input: REQUEST,
    actor_ref: "pilot-admin",
    access_scope_hash: canonicalHash({ pilot: "pilot-admin" }),
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: clock.nowMs(),
  });
  assert.ok(enqueued.ok, "enqueue phải ok: " + (enqueued.ok ? "" : enqueued.code + " " + enqueued.message));
  const runs = [];
  for (let i = 0; i < attempts; i++) {
    const run = await service.runWorker({ worker_ref: "w1", limit: 1, now_ms: clock.nowMs() });
    runs.push(run.results[0]);
    if (run.results[0].kind === "completed" || run.results[0].kind === "failed" || run.results[0].kind === "idle") break;
    clock.advance(120000);
  }
  return { queue, audit, service, clock, enqueued, runs, last: runs[runs.length - 1] };
}

// ---------------------------------------------------------------------------
// A. Golden packets → payload → scripted provider → guard
// ---------------------------------------------------------------------------

test("G4-A: 12 golden packet G1 đi hết pipeline synthetic và PASS guard", async () => {
  const packets = goldenPackets();
  assert.equal(packets.length, 12);
  for (const row of packets) {
    const { payload, result, guard } = await runScripted(row.packet, "valid");
    assert.ok(result.ok, row.case_id + " scripted provider phải ok");
    assert.ok(guard.ok, row.case_id + " guard phải PASS: " + (guard.ok ? "" : guard.code + " " + guard.message));
    assert.equal(guard.value.contract_version, "business-analysis/0.1");
    assert.equal(guard.value.period_ref, row.packet.period.period_ref);
    assert.equal(guard.value.report_status, "draft");
    assert.equal(payload.period.period_ref, row.packet.period.period_ref);
    assert.equal(payload.refs.scope_hash, row.packet.scope.scope_hash);
    assert.equal(payload.refs.snapshot_hash, row.packet.snapshot.hash);
  }
});

test("G4-B: payload minimization — whitelist, không raw/stable/PII, giới hạn kích thước", () => {
  const packet = teamPartialPacket();
  const payload = payloadFor(packet);
  assert.equal(scanForbiddenKeys(payload), null);
  assert.equal(scanForbiddenValues(payload), null);
  const serialized = canonicalJson(payload);
  for (const forbidden of ["rcr_", "team_001", "rec-alpha", "proj-alpha", "src-", "ref_map", "server_diagnostics", "@", "drive_file_id"]) {
    assert.ok(!serialized.includes(forbidden), "payload không được chứa " + forbidden);
  }
  assert.ok(payload.evidence.length <= 120);
  for (const dimension of payload.drivers) assert.ok(dimension.entries.length <= 20);
  assert.equal(payload.payload_hash, canonicalHash(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "payload_hash"))));
  assert.equal(payload.prompt_version, PROMPT.prompt_version);
  assert.equal(payload.output_contract_version, "business-analysis/0.1");
  assert.equal(payload.provider_composition_allowed, true);
  assert.equal(payload.filter_context.conditional_scope, false);
});

test("G4-B2: provider filter active ⇒ KHÔNG gửi project_provider_mix và tắt provider-composition", async () => {
  const packet = providerFilteredPacket();
  const payload = payloadFor(packet);
  assert.equal(payload.filter_context.provider_active, 1);
  assert.equal(payload.filter_context.conditional_scope, true);
  assert.equal(payload.project_provider_mix, null);
  assert.equal(payload.provider_composition_allowed, false);

  // Model cố kết luận cơ cấu tổng thể ⇒ guard chặn.
  const { result } = await runScripted(packet, "valid");
  const bad = JSON.parse(JSON.stringify(result.structured));
  bad.findings.push({
    finding_id: "f_09",
    category: "provider_mix",
    subject_ref: "scope",
    headline: "Cơ cấu HRP/Vendor toàn scope",
    analysis: "Tỷ lệ Vendor chiếm phần lớn trong toàn scope.",
    evidence_refs: [payload.evidence[0].evidence_id],
    confidence: "medium",
    limitations: [],
    recommended_action: null,
  });
  const guard = validateGeneratedAnalysis(bad, packet);
  assert.equal(guard.ok, false);
  assert.equal(guard.code, "PROVIDER_COMPOSITION_CLAIM_WHILE_FILTERED");
});

// ---------------------------------------------------------------------------
// C. Scenarios: driver / comparison / baseline
// ---------------------------------------------------------------------------

test("G4-C: total tăng do một driver và total giảm nhưng một subject tăng", async () => {
  const up = await runScripted(teamFactsPacket(), "valid_up_driver");
  assert.ok(up.guard.ok);
  assert.ok(up.guard.value.findings.some((finding) => finding.category === "trend"));
  assert.ok(up.guard.value.findings.some((finding) => finding.category === "driver"));

  const down = await runScripted(downPacket(), "valid_down_one_up");
  assert.ok(down.guard.ok, down.guard.ok ? "" : down.guard.code);
  const driverFinding = down.guard.value.findings.find((finding) => finding.category === "driver");
  assert.ok(driverFinding, "phải có finding driver dù tổng giảm");
});

function teamFactsPacket() {
  return w03Packet({ request: { period: WEEK41 }, facts: teamFacts });
}
function downPacket() {
  return w03Packet({
    request: { period: WEEK41 },
    facts: [
      F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
      F("2026-09-28", "proj-beta", "rec-bravo", "hrp", "chính thức", 5),
      F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 8),
      F("2026-10-06", "proj-beta", "rec-bravo", "hrp", "chính thức", 0),
    ],
  });
}

test("G4-C2: comparison unavailable ⇒ không finding trend/delta + bắt buộc limitation", async () => {
  const packet = comparisonUnavailablePacket();
  const { result, guard } = await runScripted(packet, "comparison_unavailable");
  assert.equal(packet.totals.comparable, null);
  assert.ok(result.ok);
  assert.ok(guard.ok, guard.ok ? "" : guard.code + " " + guard.message);
  assert.equal(guard.value.findings.some((finding) => finding.category === "trend"), false);
  assert.ok(guard.value.overall_limitations.join(" ").match(/chưa đủ dữ liệu để so sánh/i));

  const injected = JSON.parse(JSON.stringify(result.structured));
  injected.findings.push({
    finding_id: "f_09",
    category: "trend",
    subject_ref: "scope",
    headline: "Tổng tăng so với kỳ trước",
    analysis: "Kỳ này cao hơn kỳ trước.",
    evidence_refs: [payloadFor(packet).evidence[0].evidence_id],
    confidence: "low",
    limitations: [],
    recommended_action: null,
  });
  const blocked = validateGeneratedAnalysis(injected, packet);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "COMPARISON_UNAVAILABLE_FINDING");
});

test("G4-C3: baseline thiếu ⇒ confidence không high; team partial ⇒ limitation", async () => {
  const packet = teamPartialPacket();
  const { guard } = await runScripted(packet, "valid");
  assert.ok(guard.ok, guard.ok ? "" : guard.code + " " + guard.message);
  assert.ok(guard.value.findings.every((finding) => finding.confidence !== "high"));
  const teamFinding = guard.value.findings.find((finding) => finding.subject_ref.startsWith("team_"));
  if (teamFinding) {
    assert.ok(teamFinding.limitations.length > 0);
    assert.notEqual(teamFinding.confidence, "high");
  }
  assert.equal(guard.flags.requires_review, true);
  assert.equal(guard.flags.auto_approved, false);
});

test("G4-D: source degraded ⇒ bắt buộc limitation dữ liệu; unknown/invalid overlap không quy trách nhiệm", async () => {
  const degraded = degradedSourcePacket();
  const { guard } = await runScripted(degraded, "source_degraded");
  assert.ok(guard.ok, guard.ok ? "" : guard.code + " " + guard.message);
  assert.ok(guard.value.overall_limitations.join(" ").match(/chất lượng dữ liệu/i));

  const withoutLimitation = JSON.parse(JSON.stringify(guard.value));
  withoutLimitation.overall_limitations = ["Báo cáo chỉ dùng dữ liệu reporting hiện có."];
  for (const finding of withoutLimitation.findings) finding.limitations = [];
  const blocked = validateGeneratedAnalysis(withoutLimitation, degraded);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "DATA_QUALITY_LIMITATION_REQUIRED");

  const overlap = unknownInvalidPacket();
  const overlapRun = await runScripted(overlap, "unknown_invalid_overlap");
  assert.ok(overlapRun.guard.ok, overlapRun.guard.ok ? "" : overlapRun.guard.code);
  assert.ok(overlap.data_quality.unknown_count > 0 && overlap.data_quality.invalid_count > 0);
});

// ---------------------------------------------------------------------------
// E. Output guard matrix
// ---------------------------------------------------------------------------

test("G4-E: output xấu bị chặn đúng mã (evidence/số/date/PII/secret/HR/schema)", async () => {
  const packet = teamFactsPacket();
  const cases = [
    ["fabricated_evidence", ["DANGLING_EVIDENCE_REF", "AI_VALIDATION_FAILED"]],
    ["fabricated_number", ["UNGROUNDED_NUMERIC_CLAIM"]],
    ["fabricated_date", ["UNGROUNDED_DATE_CLAIM"]],
    ["prompt_injection", ["PROMPT_INJECTION_OVERRIDE", "PROMPT_INJECTION_SYSTEM", "UNGROUNDED_NUMERIC_CLAIM", "UNGROUNDED_DATE_CLAIM"]],
    ["candidate_pii", ["PII_EMAIL", "UNGROUNDED_NUMERIC_CLAIM"]],
    ["secret_like", ["SECRET_NAMED_KEY", "UNGROUNDED_NUMERIC_CLAIM"]],
    ["prohibited_hr", ["PROHIBITED_DISCIPLINARY_ACTION", "UNGROUNDED_NUMERIC_CLAIM"]],
    ["unknown_field", ["AI_VALIDATION_FAILED"]],
  ];
  for (const [scenario, expectedCodes] of cases) {
    const { guard } = await runScripted(packet, scenario);
    assert.equal(guard.ok, false, scenario + " phải bị chặn");
    assert.ok(
      expectedCodes.includes(guard.code),
      scenario + " code=" + guard.code + " phải thuộc " + expectedCodes.join("|")
    );
  }
});

test("G4-E2: raw identifier trong output bị chặn riêng", async () => {
  const packet = teamFactsPacket();
  const { result } = await runScripted(packet, "valid");
  const injected = JSON.parse(JSON.stringify(result.structured));
  injected.executive_analysis = "Tổng 8 người, xem recruiter rcr_001 để biết chi tiết.";
  const guard = validateGeneratedAnalysis(injected, packet);
  assert.equal(guard.ok, false);
  assert.equal(guard.code, "RAW_IDENTIFIER_IN_OUTPUT");
});

// ---------------------------------------------------------------------------
// F. Job pipeline: idempotency / cache / identity
// ---------------------------------------------------------------------------

test("G4-F: enqueue trùng (double-click/concurrent) ⇒ đúng MỘT logical job", async () => {
  const packet = teamFactsPacket();
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const { service } = makeService({ queue, audit, packet, scenario: "valid" });
  const args = {
    input: REQUEST,
    actor_ref: "pilot-admin",
    access_scope_hash: canonicalHash({ pilot: "pilot-admin" }),
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: Date.parse("2026-10-12T00:00:00Z"),
  };
  const [a, b] = await Promise.all([service.enqueueReport(args), service.enqueueReport(args)]);
  assert.ok(a.ok && b.ok);
  assert.equal(a.job_id, b.job_id);
  assert.ok(a.reused || b.reused);
  assert.equal(queue.store.jobs.size, 1);
});

test("G4-F2: hoàn tất ⇒ cache hit (không gọi provider lại) và không duplicate revision", async () => {
  const packet = teamFactsPacket();
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const { service, clock } = makeService({ queue, audit, packet, scenario: "valid" });
  const first = await enqueueAndRun({ packet, scenario: "valid", service, clock, queue });
  assert.equal(first.last.kind, "completed");
  assert.equal(queue.store.revisions.size, 1);

  const second = await service.enqueueReport({
    input: REQUEST,
    actor_ref: "pilot-admin",
    access_scope_hash: canonicalHash({ pilot: "pilot-admin" }),
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: clock.nowMs(),
  });
  assert.ok(second.ok);
  assert.equal(second.cache_hit, true);
  assert.equal(second.revision_id, first.last.revision_id);
  const worker = await service.runWorker({ worker_ref: "w1", limit: 1, now_ms: clock.nowMs() });
  assert.equal(worker.results[0].kind, "idle");
});

test("G4-F3: snapshot đổi hoặc prompt/model version đổi ⇒ identity mới", async () => {
  const base = { identity_hash: "", components: null };
  const identityFor = (packet, overrides = {}) =>
    buildJobIdentity({
      period: {
        period_ref: packet.period.period_ref,
        type: packet.period.type,
        start: packet.period.start,
        end: packet.period.end,
        status: packet.period.status,
        elapsed_days: packet.period.elapsed_days,
      },
      scope: { dimensions: packet.scope.dimensions, filters: {}, focus: null },
      comparison_mode: packet.totals.comparable === null ? "unavailable" : "previous_period",
      access_scope_hash: "2".repeat(64),
      snapshot_hash: overrides.snapshot_hash ?? packet.snapshot.hash,
      packet_contract_version: packet.contract_version,
      output_contract_version: "business-analysis/0.1",
      prompt_version: overrides.prompt_version ?? PROMPT.prompt_version,
      provider_key: overrides.provider_key ?? "scripted",
      model_key: overrides.model_key ?? "scripted-deterministic-v1",
      adapter_version: overrides.adapter_version ?? SCRIPTED_ADAPTER_VERSION,
    });

  const packetA = teamFactsPacket();
  const packetB = downPacket();
  const a = identityFor(packetA);
  assert.ok(a.ok);
  base.identity_hash = a.identity_hash;
  assert.equal(identityFor(packetA).identity_hash, base.identity_hash);
  assert.notEqual(identityFor(packetB).identity_hash, base.identity_hash);
  assert.notEqual(identityFor(packetA, { snapshot_hash: "9".repeat(64) }).identity_hash, base.identity_hash);
  assert.notEqual(identityFor(packetA, { prompt_version: "business-analysis-prompt/2.0" }).identity_hash, base.identity_hash);
  assert.notEqual(identityFor(packetA, { model_key: "other-model" }).identity_hash, base.identity_hash);
  assert.equal(buildJobIdentity({ period: {}, scope: {} }).ok, false);
});

// ---------------------------------------------------------------------------
// G. Failure taxonomy + retry
// ---------------------------------------------------------------------------

test("G4-G: timeout/429/5xx retry bounded; 401/malformed/oversized không retry", async () => {
  const expectations = [
    ["timeout", "failed_provider_transient", "retry_scheduled"],
    ["rate_limited", "failed_provider_transient", "retry_scheduled"],
    ["transient_5xx", "failed_provider_transient", "retry_scheduled"],
    ["permanent_401", "failed_provider_permanent", "failed"],
    ["malformed_json", "failed_validation", "failed"],
    ["oversized", "failed_validation", "failed"],
  ];
  for (const [scenario, terminalStatus, firstKind] of expectations) {
    const packet = teamFactsPacket();
    const queue = createMemoryQueue();
    const audit = createMemoryAudit();
    const { service, clock } = makeService({ queue, audit, packet, scenario });
    const run = await enqueueAndRun({ packet, scenario, service, clock, queue, attempts: 6 });
    assert.equal(run.runs[0].kind, firstKind, scenario + " lần chạy đầu");
    const job = [...queue.store.jobs.values()][0];
    assert.equal(job.status, terminalStatus, scenario + " trạng thái cuối");
    assert.ok(job.attempts >= 1 && job.attempts <= DEFAULT_POLICY.max_attempts, scenario + " attempts bounded");
  }
});

test("G4-G2: retry không duplicate logical usage/revision; backoff bounded + deterministic", async () => {
  const packet = teamFactsPacket();
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const { service, clock } = makeService({ queue, audit, packet, scenario: "timeout" });
  await enqueueAndRun({ packet, scenario: "timeout", service, clock, queue, attempts: 6 });
  const job = [...queue.store.jobs.values()][0];
  assert.equal(job.status, "failed_provider_transient");
  assert.equal(queue.store.usage.size, job.attempts);
  assert.equal(queue.store.revisions.size, 0);
  assert.equal(new Set([...queue.store.usage.keys()]).size, queue.store.usage.size);

  const backoff1 = computeBackoffMs(1, "job-1");
  const backoff2 = computeBackoffMs(1, "job-1");
  assert.equal(backoff1, backoff2);
  assert.ok(backoff1 >= 2000 && backoff1 <= 2400);
  assert.ok(computeBackoffMs(9, "job-1") <= 60000 * 1.2 + 1);
  const decision = decideAfterFailure({ error_code: "AI_PROVIDER_PERMANENT", attempts: 1, max_attempts: 3, now_ms: 0, seed: "x" });
  assert.equal(decision.next_status, "failed_provider_permanent");
  assert.equal(decision.exhausted, true);
  const retry = decideAfterFailure({ error_code: "AI_PROVIDER_TIMEOUT", attempts: 3, max_attempts: 3, now_ms: 0, seed: "x" });
  assert.equal(retry.next_status, "failed_provider_transient");
});

// ---------------------------------------------------------------------------
// H. Leases / fencing / lost response
// ---------------------------------------------------------------------------

test("G4-H: mất response sau commit ⇒ không duplicate revision/usage", async () => {
  const packet = teamFactsPacket();
  const queue = createMemoryQueue({ hooks: { completeAfterCommit: true } });
  const audit = createMemoryAudit();
  const { service, clock } = makeService({ queue, audit, packet, scenario: "valid" });
  const first = await enqueueAndRun({ packet, scenario: "valid", service, clock, queue, attempts: 1 });
  assert.equal(queue.store.revisions.size, 1, "commit đã xảy ra trong DB");
  assert.ok(first.runs[0].kind === "retry_scheduled" || first.runs[0].kind === "failed");

  // Lần chạy sau: complete idempotent trả lại revision cũ, KHÔNG tạo revision mới.
  const again = await service.runWorker({ worker_ref: "w2", limit: 1, now_ms: clock.nowMs() });
  assert.equal(queue.store.revisions.size, 1);
  assert.equal(queue.store.usage.size, 1);
  assert.ok(["completed", "idle"].includes(again.results[0].kind), "kind=" + again.results[0].kind);
});

test("G4-H2: stale worker complete bị từ chối (fencing) và lease hết hạn được thu hồi", async () => {
  const packet = teamFactsPacket();
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const { service, clock } = makeService({ queue, audit, packet, scenario: "valid" });
  await service.enqueueReport({
    input: REQUEST,
    actor_ref: "pilot-admin",
    access_scope_hash: canonicalHash({ pilot: "pilot-admin" }),
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: clock.nowMs(),
  });
  const staleClaim = await queue.claim({ worker_ref: "stale", lease_seconds: 1, now_ms: clock.nowMs() });
  assert.ok(staleClaim);
  clock.advance(5000);
  const freshRun = await service.runWorker({ worker_ref: "fresh", limit: 1, now_ms: clock.nowMs() });
  assert.equal(freshRun.results[0].kind, "completed");
  const staleComplete = await queue.complete({
    job_id: staleClaim.job.job_id,
    lease_token: staleClaim.lease_token,
    analysis: { contract_version: "business-analysis/0.1" },
    usage: { job_id: staleClaim.job.job_id, logical_call_id: "stale:1" },
    now_ms: clock.nowMs(),
  });
  assert.equal(staleComplete.ok, true);
  assert.equal(staleComplete.already_completed, true);
  assert.equal(queue.store.revisions.size, 1);
});

// ---------------------------------------------------------------------------
// I. Policy guards
// ---------------------------------------------------------------------------

test("G4-I: policy fail-closed (rate/concurrency/budget/policy required) — không gọi provider", async () => {
  const packet = teamFactsPacket();

  const rateQueue = createMemoryQueue();
  const rateAudit = createMemoryAudit();
  const rateService = makeService({ queue: rateQueue, audit: rateAudit, packet, scenario: "valid", policy: { ...DEFAULT_POLICY, max_requests_per_window: 1 } });
  const first = await rateService.service.enqueueReport({
    input: REQUEST, actor_ref: "pilot-admin", access_scope_hash: canonicalHash({ pilot: "pilot-admin" }),
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: rateService.clock.nowMs(),
  });
  assert.ok(first.ok);
  const second = await rateService.service.enqueueReport({
    input: { period: { type: "month", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider", "employment"] } },
    actor_ref: "pilot-admin", access_scope_hash: canonicalHash({ pilot: "pilot-admin" }),
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: rateService.clock.nowMs(),
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, "AI_RATE_LIMITED");

  const concurrencyQueue = createMemoryQueue();
  const concurrencyService = makeService({ queue: concurrencyQueue, audit: createMemoryAudit(), packet, scenario: "valid", policy: { ...DEFAULT_POLICY, max_concurrent_jobs: 1 } });
  await concurrencyService.service.enqueueReport({
    input: REQUEST, actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: concurrencyService.clock.nowMs(),
  });
  const blocked = await concurrencyService.service.enqueueReport({
    input: { period: { type: "month", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider", "employment"] } },
    actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: concurrencyService.clock.nowMs(),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "AI_CONCURRENCY_LIMITED");

  const budgetQueue = createMemoryQueue();
  const budgetService = makeService({ queue: budgetQueue, audit: createMemoryAudit(), packet, scenario: "valid", policy: { ...DEFAULT_POLICY, daily_token_ceiling: 1 } });
  await budgetService.service.enqueueReport({
    input: REQUEST, actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: budgetService.clock.nowMs(),
  });
  await budgetService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: budgetService.clock.nowMs() });
  const budgetBlocked = await budgetService.service.enqueueReport({
    input: { period: { type: "month", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider", "employment"] } },
    actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: budgetService.clock.nowMs(),
  });
  assert.equal(budgetBlocked.ok, false);
  assert.equal(budgetBlocked.code, "AI_BUDGET_LIMITED");
});

test("G4-I2: input không hợp lệ (period/scope/focus) bị chặn trước DB", async () => {
  const packet = teamFactsPacket();
  const queue = createMemoryQueue();
  const { service } = makeService({ queue, audit: createMemoryAudit(), packet, scenario: "valid" });
  const bad = await service.enqueueReport({
    input: { period: { type: "day", as_of_date: "2026-10-11" } },
    actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: 0,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "AI_INPUT_INVALID");
  assert.equal(queue.store.jobs.size, 0);

  const injection = await service.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project"] }, focus: "{{ system }}" },
    actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: 0,
  });
  assert.equal(injection.ok, false);
  assert.equal(injection.code, "AI_INPUT_INVALID");
});

test("G4-G3: identity capability — recruiter/team chưa có catalog authority ⇒ AI_IDENTITY_CATALOG_REQUIRED", async () => {
  const packet = teamFactsPacket();
  const queue = createMemoryQueue();
  const { service } = makeService({ queue, audit: createMemoryAudit(), packet, scenario: "valid" });
  const blocked = await service.enqueueReport({
    input: IDENTITY_REQUEST,
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "AI_IDENTITY_CATALOG_REQUIRED");
  assert.equal(queue.store.jobs.size, 0, "không được enqueue khi thiếu identity capability");

  const recruiterOnly = await service.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project", "recruiter"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.equal(recruiterOnly.code, "AI_IDENTITY_CATALOG_REQUIRED");

  const recruiterFilter = await service.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project"], filters: { recruiter_keys: ["rec-bravo"] } } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.equal(recruiterFilter.code, "AI_IDENTITY_CATALOG_REQUIRED");
});

test("G4-J: state machine + regenerate cần reason", async () => {
  assert.equal(canTransition("queued", "computing"), true);
  assert.equal(canTransition("draft", "queued"), false);
  assert.equal(canTransition("computing", "draft"), false);

  const packet = teamFactsPacket();
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const { service, clock } = makeService({ queue, audit, packet, scenario: "valid" });
  const run = await enqueueAndRun({ packet, scenario: "valid", service, clock, queue });
  assert.equal(run.last.kind, "completed");
  const jobId = run.enqueued.job_id;

  const noReason = await service.enqueueReport({
    input: { period: WEEK41, scope: {}, regenerate_of: jobId, reason: "" },
    actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: clock.nowMs(),
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, "AI_INPUT_INVALID");

  const regenerated = await service.enqueueReport({
    input: { period: WEEK41, scope: {}, regenerate_of: jobId, reason: "Dữ liệu nguồn đã cập nhật" },
    actor_ref: "pilot-admin", access_scope_hash: "h",
    provider_key: "scripted", model_key: "m", adapter_version: SCRIPTED_ADAPTER_VERSION, now_ms: clock.nowMs(),
  });
  assert.ok(regenerated.ok, regenerated.ok ? "" : regenerated.code);
  assert.notEqual(regenerated.job_id, jobId);
  // Audit regenerate do tầng DB (RPC) ghi — mô phỏng bằng audit trail của queue.
  assert.ok(queue.store.audit.some((event) => event.event_type === "job_regenerated" && event.reason.length >= 3));
  assert.equal(queue.store.jobs.size, 2);
});

test("G4-K: mọi scenario scripted đều có trong danh sách cho phép và deterministic", async () => {
  assert.equal(SCRIPTED_SCENARIOS.length, 24);
  const packet = teamFactsPacket();
  const a = await runScripted(packet, "valid");
  const b = await runScripted(packet, "valid");
  assert.equal(a.result.raw_text, b.result.raw_text, "scripted provider phải deterministic");
  assert.equal(a.payload.payload_hash, b.payload.payload_hash);
});
