import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI } from "./vendor-finance-contract.ts";
import {
  MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES,
  MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES,
  handleGetDownloadVendorFinanceEvidence,
  handleGetVendorFinanceEntries,
  handleGetVendorFinanceSingleEntry,
  handleGetVendorFinanceVendorDetail,
  handleGetVendorFinanceVendors,
  handleGetVendorReconciliations,
  handlePostApplyOpeningBatch,
  handlePostFinalizeVendorFinanceEvidence,
  handlePostPreviewOpeningBatch,
  handlePostReserveVendorFinanceEvidence,
  handlePostReverseVendorFinanceEntry,
  handlePostVendorFinanceEntry,
  handlePostVendorReconciliation,
} from "./vendor-finance-api.ts";
import { createVendorFinanceRepository } from "./vendor-finance-repository.ts";

const HOST = "bi.local";
const ORIGIN = `https://${HOST}`;
const SAME_ORIGIN_POST_HEADERS = Object.freeze({
  host: HOST,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
});

const AUTH_ID = "10000000-0000-4000-8000-000000000001";
const APP_ID = "20000000-0000-4000-8000-000000000001";
const ENTRY_ID = "30000000-0000-4000-8000-000000000001";
const REV_ENTRY_ID = "30000000-0000-4000-8000-000000000002";
const REC_ID = "40000000-0000-4000-8000-000000000001";
const BATCH_ID = "50000000-0000-4000-8000-000000000001";
const EV_ID_1 = "60000000-0000-4000-8000-000000000001";
const EV_ID_2 = "60000000-0000-4000-8000-000000000002";
const IDEM_1 = "70000000-0000-4000-8000-000000000001";
const IDEM_2 = "70000000-0000-4000-8000-000000000002";
const IDEM_3 = "70000000-0000-4000-8000-000000000003";

const VALID_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const VALID_PNG_SHA = createHash("sha256").update(VALID_PNG).digest("hex");

const EXPECTED_ROUTE_METHODS = Object.freeze({
  "src/app/api/vendor-finance/vendors/route.ts": {
    GET: "handleGetVendorFinanceVendors",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/route.ts": {
    GET: "handleGetVendorFinanceVendorDetail",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/entries/route.ts": {
    GET: "handleGetVendorFinanceEntries",
    POST: "handlePostVendorFinanceEntry",
  },
  "src/app/api/vendor-finance/vendors/[vendorId]/reconciliations/route.ts": {
    GET: "handleGetVendorReconciliations",
    POST: "handlePostVendorReconciliation",
  },
  "src/app/api/vendor-finance/entries/[entryId]/route.ts": {
    GET: "handleGetVendorFinanceSingleEntry",
  },
  "src/app/api/vendor-finance/entries/[entryId]/reverse/route.ts": {
    POST: "handlePostReverseVendorFinanceEntry",
  },
  "src/app/api/vendor-finance/opening-batches/preview/route.ts": {
    POST: "handlePostPreviewOpeningBatch",
  },
  "src/app/api/vendor-finance/opening-batches/apply/route.ts": {
    POST: "handlePostApplyOpeningBatch",
  },
  "src/app/api/vendor-finance/evidence/reserve/route.ts": {
    POST: "handlePostReserveVendorFinanceEvidence",
  },
  "src/app/api/vendor-finance/evidence/[evidenceId]/finalize/route.ts": {
    POST: "handlePostFinalizeVendorFinanceEvidence",
  },
  "src/app/api/vendor-finance/evidence/[evidenceId]/download/route.ts": {
    GET: "handleGetDownloadVendorFinanceEvidence",
  },
});

const FULL_ADMIN_CAPS = [
  "personnel_master_manage",
  "team_master_manage",
  "team_membership_manage",
  "team_leader_manage",
  "account_access_manage",
];

function makeSession({
  unauthenticated = false,
  enabled = true,
  capabilities = FULL_ADMIN_CAPS,
  scopes = [{ kind: "all" }],
} = {}) {
  if (unauthenticated) {
    return {
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    };
  }
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH_ID,
        app_user_id: APP_ID,
        enabled,
        capabilities,
        scopes,
      },
    },
  };
}

function sampleEntry(overrides = {}) {
  return {
    entry_id: ENTRY_ID,
    vendor_id: "VND_ALPHA",
    vendor_display_name_snapshot: "Công ty TNHH Alpha",
    vendor_active: true,
    vendor_sequence: 1,
    document_no: "VFIN-2026-000001",
    document_kind: "DEBT_ADJUSTMENT_VOUCHER",
    document_title_vi: "Phiếu ghi nhận phát sinh tăng công nợ",
    entry_type: "DEBT_RECORDED",
    amount_minor: "15000000",
    balance_before_minor: "0",
    balance_delta_minor: "15000000",
    balance_after_minor: "15000000",
    effective_date: "2026-10-24",
    reason: "Phí cung ứng tuần 3",
    opening_batch_id: null,
    reverses_entry_id: null,
    reverses_document_no: null,
    reversed_by_entry_id: null,
    reversed_by_document_no: null,
    can_reverse: true,
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán",
    created_at: "2026-10-24T02:00:00.000Z",
    internal_disclaimer: VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
    ...overrides,
  };
}

function sampleReconciliation(overrides = {}) {
  return {
    reconciliation_id: REC_ID,
    vendor_id: "VND_ALPHA",
    as_of_date: "2026-10-24",
    system_balance_minor: "15000000",
    confirmed_balance_minor: "14500000",
    difference_minor: "-500000",
    ledger_sequence_at_reconciliation: 1,
    reason: "Đối soát biên bản tháng 10",
    can_attach_evidence: true,
    evidence: null,
    created_by_display_name: "Trần Thị Kế Toán",
    created_at: "2026-10-24T02:05:00.000Z",
    ...overrides,
  };
}

function makeMockRepository({
  actorAccess = {
    authorization_date: "2026-10-24",
    can_view: true,
    can_record: true,
    authority_source: "accounting_department",
  },
} = {}) {
  const calls = [];
  return {
    calls,
    repository: {
      async getActorAccess(input) {
        calls.push(["getActorAccess", input]);
        return { ok: true, data: actorAccess };
      },
      async listVendors(input) {
        calls.push(["listVendors", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: { can_view: true, can_record: actorAccess.can_record },
            summary: {
              total_payable_minor: "15000000",
              total_advance_minor: "0",
              net_balance_minor: "15000000",
              vendors_with_payable_count: 1,
              vendors_with_advance_count: 0,
              vendors_with_nonzero_balance_count: 1,
              total_vendor_count: 1,
              uninitialized_vendor_count: 0,
            },
            filters: { search: null, active: "all", balance_filter: "all" },
            page: 1,
            page_size: 25,
            total: 1,
            has_more: false,
            vendors: [
              {
                vendor_id: "VND_ALPHA",
                display_name: "Công ty TNHH Alpha",
                active: true,
                current_balance_minor: "15000000",
                balance_direction: "PAYABLE",
                entry_count: 1,
                has_opening_entry: false,
                eligible_for_opening: false,
                last_effective_date: "2026-10-24",
                last_entry_at: "2026-10-24T02:00:00.000Z",
                last_reconciled_as_of_date: null,
              },
            ],
          },
        };
      },
      async getVendor(input) {
        calls.push(["getVendor", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: {
              can_view: true,
              can_record: actorAccess.can_record,
              can_reconcile: actorAccess.can_record,
              allowed_entry_types: ["DEBT_RECORDED", "PAYROLL_RECORDED", "PAYMENT_RECORDED", "ADVANCE_RECORDED", "ADJUSTMENT_INCREASE", "ADJUSTMENT_DECREASE"],
            },
            vendor: {
              vendor_id: input.vendor_id,
              display_name: "Công ty TNHH Alpha",
              active: true,
              current_balance_minor: "15000000",
              balance_direction: "PAYABLE",
              latest_sequence: 1,
              entry_count: 1,
              has_opening_entry: false,
              eligible_for_opening: false,
              totals: {
                opening_payable_minor: "0",
                opening_advance_minor: "0",
                debt_recorded_minor: "15000000",
                payroll_recorded_minor: "0",
                payment_recorded_minor: "0",
                advance_recorded_minor: "0",
                adjustment_increase_minor: "0",
                adjustment_decrease_minor: "0",
                reversed_entry_count: 0,
              },
              latest_reconciliation: null,
              recent_reconciliations: [],
            },
          },
        };
      },
      async listVendorEntries(input) {
        calls.push(["listVendorEntries", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            vendor_id: input.vendor_id,
            page_size: 25,
            has_more: false,
            next_cursor: null,
            entries: [sampleEntry()],
          },
        };
      },
      async getEntry(input) {
        calls.push(["getEntry", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            allowed_actions: { can_view: true, can_record: actorAccess.can_record },
            entry: sampleEntry({ entry_id: input.entry_id }),
          },
        };
      },
      async listVendorReconciliations(input) {
        calls.push(["listVendorReconciliations", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            vendor_id: input.vendor_id,
            page: 1,
            page_size: 25,
            total: 1,
            has_more: false,
            reconciliations: [sampleReconciliation({ vendor_id: input.vendor_id })],
          },
        };
      },
      async recordEntry(input) {
        calls.push(["recordEntry", input]);
        return {
          ok: true,
          data: { entry: sampleEntry(), replayed: false },
        };
      },
      async reverseEntry(input) {
        calls.push(["reverseEntry", input]);
        return {
          ok: true,
          data: {
            reversal_entry: sampleEntry({
              entry_id: REV_ENTRY_ID,
              vendor_sequence: 2,
              document_no: "VFIN-2026-000002",
              entry_type: "REVERSAL",
              balance_before_minor: "15000000",
              balance_delta_minor: "-15000000",
              balance_after_minor: "0",
              reverses_entry_id: ENTRY_ID,
              reverses_document_no: "VFIN-2026-000001",
              can_reverse: false,
            }),
            reversed_entry: sampleEntry({
              reversed_by_entry_id: REV_ENTRY_ID,
              reversed_by_document_no: "VFIN-2026-000002",
              can_reverse: false,
            }),
            replayed: false,
          },
        };
      },
      async previewOpeningBatch(input) {
        calls.push(["previewOpeningBatch", input]);
        return {
          ok: true,
          data: {
            authorization_date: "2026-10-24",
            cutoff_date: input.cutoff_date,
            vendor_count: 1,
            skipped_zero_count: 0,
            total_payable_minor: "15000000",
            total_advance_minor: "0",
            net_balance_minor: "15000000",
            items: [
              {
                vendor_id: "VND_ALPHA",
                display_name: "Công ty TNHH Alpha",
                active: true,
                entry_type: "OPENING_PAYABLE",
                amount_minor: "15000000",
                balance_delta_minor: "15000000",
              },
            ],
          },
        };
      },
      async applyOpeningBatch(input) {
        calls.push(["applyOpeningBatch", input]);
        return {
          ok: true,
          data: {
            batch: {
              batch_id: BATCH_ID,
              cutoff_date: input.cutoff_date,
              vendor_count: 1,
              skipped_zero_count: 0,
              total_payable_minor: "15000000",
              total_advance_minor: "0",
              net_balance_minor: "15000000",
              reason: input.reason,
              created_by_display_name: "Trần Thị Kế Toán",
              created_at: "2026-10-24T02:00:00.000Z",
            },
            entries: [
              sampleEntry({
                entry_type: "OPENING_PAYABLE",
                document_kind: "OPENING_BALANCE_VOUCHER",
                opening_batch_id: BATCH_ID,
              }),
            ],
            replayed: false,
          },
        };
      },
      async createReconciliation(input) {
        calls.push(["createReconciliation", input]);
        return {
          ok: true,
          data: {
            reconciliation: sampleReconciliation({ vendor_id: input.vendor_id }),
            replayed: false,
          },
        };
      },
      async reserveEvidence(input) {
        calls.push(["reserveEvidence", input]);
        return {
          ok: true,
          data: {
            reservation: {
              evidence_id: EV_ID_1,
              target_kind: input.target_kind,
              target_id: input.target_id,
              status: "RESERVED",
              storage_key: `vfin-01/entry/${input.target_id}/${EV_ID_1}`,
              mime_type: input.mime_type,
              size_bytes: input.size_bytes,
              checksum_sha256: input.checksum_sha256,
              reserved_at: "2026-10-24T02:00:00.000Z",
              expires_at: "2026-10-24T02:05:00.000Z",
            },
            superseded_storage_keys: [],
            replayed: false,
          },
        };
      },
      async getEvidenceReservationInfo(input) {
        calls.push(["getEvidenceReservationInfo", input]);
        return {
          ok: true,
          data: {
            evidence_id: input.evidence_id,
            target_kind: "ENTRY",
            target_id: ENTRY_ID,
            status: "RESERVED",
            storage_key: `vfin-01/entry/${ENTRY_ID}/${input.evidence_id}`,
            mime_type: "image/png",
            size_bytes: VALID_PNG.byteLength,
            checksum_sha256: VALID_PNG_SHA,
            expires_at: "2026-10-24T02:05:00.000Z",
            finalized_at: null,
            is_expired: false,
          },
        };
      },
      async finalizeEvidenceReady(input) {
        calls.push(["finalizeEvidenceReady", input]);
        return {
          ok: true,
          data: {
            evidence: {
              evidence_id: input.evidence_id,
              target_kind: "ENTRY",
              target_id: ENTRY_ID,
              status: "READY",
              mime_type: "image/png",
              size_bytes: VALID_PNG.byteLength,
              checksum_sha256: VALID_PNG_SHA,
              finalized_at: "2026-10-24T02:01:00.000Z",
            },
            replayed: false,
          },
        };
      },
      async failEvidenceReservation(input) {
        calls.push(["failEvidenceReservation", input]);
        return {
          ok: true,
          data: { evidence_id: input.evidence_id, status: "FAILED" },
        };
      },
      async expireEvidenceReservation(input) {
        calls.push(["expireEvidenceReservation", input]);
        return {
          ok: true,
          data: { evidence_id: input.evidence_id, status: "EXPIRED" },
        };
      },
      async getEvidenceDownload(input) {
        calls.push(["getEvidenceDownload", input]);
        return {
          ok: true,
          data: {
            evidence_id: input.evidence_id,
            target_kind: "ENTRY",
            target_id: ENTRY_ID,
            storage_key: `vfin-01/entry/${ENTRY_ID}/${input.evidence_id}`,
            mime_type: "image/png",
            size_bytes: VALID_PNG.byteLength,
            checksum_sha256: VALID_PNG_SHA,
            finalized_at: "2026-10-24T02:01:00.000Z",
          },
        };
      },
      async markEvidenceCleaned(input) {
        calls.push(["markEvidenceCleaned", input]);
        return {
          ok: true,
          data: { evidence_id: input.evidence_id, cleaned: true },
        };
      },
    },
  };
}

async function discoverRouteFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await discoverRouteFiles(full)));
    } else if (entry.isFile() && entry.name === "route.ts") {
      results.push(full);
    }
  }
  return results.sort();
}

function extractExportedFunctionBlock(source, verb) {
  const matcher = new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`);
  const match = matcher.exec(source);
  if (!match) return null;
  const openParen = source.indexOf("(", match.index);
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = i;
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", paramsEnd);
  let braceDepth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") braceDepth += 1;
    else if (source[i] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return source.slice(match.index, i + 1);
      }
    }
  }
  return null;
}

test("dynamic route discovery & DIRECT_ENTRY_API_ENABLED hidden 404 gate across all 11 routes (13 handlers) before params, session, repository, storage, or body reads", async () => {
  const rootDir = process.cwd();
  const routeFiles = await discoverRouteFiles(path.join(rootDir, "src/app/api/vendor-finance"));
  const relativeRoutes = routeFiles.map((f) => path.relative(rootDir, f).replaceAll("\\", "/"));

  assert.deepEqual(relativeRoutes.sort(), Object.keys(EXPECTED_ROUTE_METHODS).sort());

  for (const relPath of relativeRoutes) {
    const source = await readFile(path.join(rootDir, relPath), "utf8");
    assert.match(source, /export\s+const\s+dynamic\s*=\s*"force-dynamic"/);

    const expectedMap = EXPECTED_ROUTE_METHODS[relPath];
    for (const verb of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const fnBlock = extractExportedFunctionBlock(source, verb);
      if (!(verb in expectedMap)) {
        assert.equal(fnBlock, null, `${relPath} must not export ${verb}`);
        continue;
      }
      assert.ok(fnBlock, `${relPath} missing exported ${verb}`);
      const gateIdx = fnBlock.indexOf('if (process.env.DIRECT_ENTRY_API_ENABLED !== "true")');
      const handlerIdx = fnBlock.indexOf(expectedMap[verb]);
      assert.ok(gateIdx !== -1, `${relPath} ${verb} must guard DIRECT_ENTRY_API_ENABLED`);
      assert.ok(handlerIdx > gateIdx, `${relPath} ${verb} must guard before calling ${expectedMap[verb]}`);
      if (fnBlock.includes("context.params")) {
        const paramsIdx = fnBlock.indexOf("context.params");
        assert.ok(gateIdx < paramsIdx, `${relPath} ${verb} must guard before awaiting context.params`);
      }
      if (fnBlock.includes("createR2VendorFinanceEvidenceStorage")) {
        const storageIdx = fnBlock.indexOf("createR2VendorFinanceEvidenceStorage");
        assert.ok(gateIdx < storageIdx, `${relPath} ${verb} must guard before creating R2 storage`);
      }
    }
  }

  for (const disabledFlag of [undefined, "", "false", "0", "TRUE", " true "]) {
    let sideEffects = 0;
    const bombDeps = {
      resolveSession: async () => {
        sideEffects += 1;
        throw new Error("resolveSession must not run when gated off");
      },
      repository: new Proxy(
        {},
        {
          get() {
            return async () => {
              sideEffects += 1;
              throw new Error("repository must not run when gated off");
            };
          },
        },
      ),
      storage: {
        available() {
          sideEffects += 1;
          throw new Error("storage must not run when gated off");
        },
      },
    };
    const untouchedBody = () =>
      new ReadableStream(
        {
          pull() {
            sideEffects += 1;
            throw new Error("body must not be read when gated off");
          },
        },
        { highWaterMark: 0 },
      );

    const responses = await Promise.all([
      handleGetVendorFinanceVendors(new Request(`${ORIGIN}/api/vendor-finance/vendors`), disabledFlag, bombDeps),
      handleGetVendorFinanceVendorDetail(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA`), "VND_ALPHA", disabledFlag, bombDeps),
      handleGetVendorFinanceEntries(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostVendorFinanceEntry(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handleGetVendorReconciliations(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`), "VND_ALPHA", disabledFlag, bombDeps),
      handlePostVendorReconciliation(new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`, { method: "POST", body: untouchedBody(), duplex: "half" }), "VND_ALPHA", disabledFlag, bombDeps),
      handleGetVendorFinanceSingleEntry(new Request(`${ORIGIN}/api/vendor-finance/entries/${ENTRY_ID}`), ENTRY_ID, disabledFlag, bombDeps),
      handlePostReverseVendorFinanceEntry(new Request(`${ORIGIN}/api/vendor-finance/entries/${ENTRY_ID}/reverse`, { method: "POST", body: untouchedBody(), duplex: "half" }), ENTRY_ID, disabledFlag, bombDeps),
      handlePostPreviewOpeningBatch(new Request(`${ORIGIN}/api/vendor-finance/opening-batches/preview`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handlePostApplyOpeningBatch(new Request(`${ORIGIN}/api/vendor-finance/opening-batches/apply`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handlePostReserveVendorFinanceEvidence(new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, { method: "POST", body: untouchedBody(), duplex: "half" }), disabledFlag, bombDeps),
      handlePostFinalizeVendorFinanceEvidence(new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/finalize`, { method: "POST", body: untouchedBody(), duplex: "half" }), EV_ID_1, disabledFlag, bombDeps),
      handleGetDownloadVendorFinanceEvidence(new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/download`), EV_ID_1, disabledFlag, bombDeps),
    ]);

    assert.equal(responses.length, 13);
    for (const res of responses) {
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
    }
    assert.equal(sideEffects, 0);
  }
});

test("CSRF, authority headers, invalid JSON, and oversized body (413) are rejected cleanly", async () => {
  const { repository, calls } = makeMockRepository();
  const deps = {
    resolveSession: async () => makeSession(),
    repository,
  };

  // Cross-origin POST -> 403 CSRF_ORIGIN_DENIED
  const csrfRes = await handlePostVendorFinanceEntry(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    "VND_ALPHA",
    "true",
    deps,
  );
  assert.equal(csrfRes.status, 403);
  assert.deepEqual(await csrfRes.json(), { ok: false, code: "CSRF_ORIGIN_DENIED" });
  assert.equal(calls.length, 0);

  // Disallowed authority header -> 400 CLIENT_AUTHORITY_FIELD_FORBIDDEN
  const headerRes = await handleGetVendorFinanceVendors(
    new Request(`${ORIGIN}/api/vendor-finance/vendors`, {
      headers: { "x-authority-source": "full_admin" },
    }),
    "true",
    deps,
  );
  assert.equal(headerRes.status, 400);
  assert.deepEqual(await headerRes.json(), { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" });

  // Chunked stream exceeding MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES -> 413 REQUEST_BODY_TOO_LARGE
  const chunk = new TextEncoder().encode("x".repeat(4096));
  let pullCount = 0;
  const oversizedStream = new ReadableStream(
    {
      pull(controller) {
        pullCount += 1;
        controller.enqueue(chunk);
        if (pullCount >= 5) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const oversizedRes = await handlePostVendorFinanceEntry(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: oversizedStream,
      duplex: "half",
    }),
    "VND_ALPHA",
    "true",
    deps,
  );
  assert.equal(oversizedRes.status, 413);
  assert.deepEqual(await oversizedRes.json(), { ok: false, code: "REQUEST_BODY_TOO_LARGE" });
  assert.ok(pullCount * 4096 > MAX_VENDOR_FINANCE_MUTATION_JSON_BYTES);

  // Declared Content-Length exceeding MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES -> 413
  const oversizedBatchRes = await handlePostPreviewOpeningBatch(
    new Request(`${ORIGIN}/api/vendor-finance/opening-batches/preview`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-length": String(MAX_VENDOR_FINANCE_OPENING_BATCH_JSON_BYTES + 1),
      },
      body: "{}",
    }),
    "true",
    deps,
  );
  assert.equal(oversizedBatchRes.status, 413);
});

test("HTTP authorization matrix: Full Admin, active Accounting member, BoD view-only, Catalog operator, Team Leader/PM/Staff, and retired payment tokens", async () => {
  // 1. Unauthenticated -> 401
  const unauthRes = await handleGetVendorFinanceVendors(
    new Request(`${ORIGIN}/api/vendor-finance/vendors`),
    "true",
    {
      resolveSession: async () => makeSession({ unauthenticated: true }),
      repository: makeMockRepository().repository,
    },
  );
  assert.equal(unauthRes.status, 401);

  // 2. Active ACCOUNTING department member (zero direct capabilities/scopes in session!) -> 200 GET & 201 POST
  const acctRepo = makeMockRepository({
    actorAccess: {
      authorization_date: "2026-10-24",
      can_view: true,
      can_record: true,
      authority_source: "accounting_department",
    },
  });
  const acctDeps = {
    resolveSession: async () => makeSession({ capabilities: [], scopes: [] }),
    repository: acctRepo.repository,
  };
  const acctGet = await handleGetVendorFinanceVendors(
    new Request(`${ORIGIN}/api/vendor-finance/vendors`),
    "true",
    acctDeps,
  );
  assert.equal(acctGet.status, 200);

  const acctPost = await handlePostVendorFinanceEntry(
    new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: JSON.stringify({
        entry_type: "DEBT_RECORDED",
        amount_minor: "15000000",
        effective_date: "2026-10-24",
        reason: "Phí dịch vụ",
        idempotency_key: IDEM_1,
      }),
    }),
    "VND_ALPHA",
    "true",
    acctDeps,
  );
  assert.equal(acctPost.status, 201);

  // 3. BoD view-only (`vendor_finance_view @ all`) -> 200 GET, 403 VENDOR_FINANCE_RECORD_DENIED on all POSTs
  const bodRepo = makeMockRepository({
    actorAccess: {
      authorization_date: "2026-10-24",
      can_view: true,
      can_record: false,
      authority_source: "direct_grant_view",
    },
  });
  let storageCalledForBod = false;
  const bodDeps = {
    resolveSession: async () =>
      makeSession({
        capabilities: ["vendor_finance_view", "report_analytics_view"],
        scopes: [{ kind: "all" }],
      }),
    repository: bodRepo.repository,
    storage: {
      available() {
        storageCalledForBod = true;
        return true;
      },
    },
  };

  assert.equal(
    (await handleGetVendorFinanceVendorDetail(
      new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA`),
      "VND_ALPHA",
      "true",
      bodDeps,
    )).status,
    200,
  );
  assert.equal(
    (await handleGetVendorFinanceSingleEntry(
      new Request(`${ORIGIN}/api/vendor-finance/entries/${ENTRY_ID}`),
      ENTRY_ID,
      "true",
      bodDeps,
    )).status,
    200,
  );
  assert.equal(
    (await handleGetVendorFinanceEntries(
      new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`),
      "VND_ALPHA",
      "true",
      bodDeps,
    )).status,
    200,
  );
  assert.equal(
    (await handleGetVendorReconciliations(
      new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`),
      "VND_ALPHA",
      "true",
      bodDeps,
    )).status,
    200,
  );

  for (const postCall of [
    () =>
      handlePostVendorFinanceEntry(
        new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "VND_ALPHA",
        "true",
        bodDeps,
      ),
    () =>
      handlePostReverseVendorFinanceEntry(
        new Request(`${ORIGIN}/api/vendor-finance/entries/${ENTRY_ID}/reverse`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        ENTRY_ID,
        "true",
        bodDeps,
      ),
    () =>
      handlePostPreviewOpeningBatch(
        new Request(`${ORIGIN}/api/vendor-finance/opening-batches/preview`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "true",
        bodDeps,
      ),
    () =>
      handlePostApplyOpeningBatch(
        new Request(`${ORIGIN}/api/vendor-finance/opening-batches/apply`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "true",
        bodDeps,
      ),
    () =>
      handlePostVendorReconciliation(
        new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/reconciliations`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "VND_ALPHA",
        "true",
        bodDeps,
      ),
    () =>
      handlePostReserveVendorFinanceEvidence(
        new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        "true",
        bodDeps,
      ),
    () =>
      handlePostFinalizeVendorFinanceEvidence(
        new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/finalize`, {
          method: "POST",
          headers: SAME_ORIGIN_POST_HEADERS,
          body: "{}",
        }),
        EV_ID_1,
        "true",
        bodDeps,
      ),
  ]) {
    const res = await postCall();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { ok: false, code: "VENDOR_FINANCE_RECORD_DENIED" });
  }
  assert.equal(storageCalledForBod, false, "BoD view-only must never touch R2 storage on mutations");

  // 4. Catalog operator (`catalog_master_manage @ all`), Team Leader, Staff, retired `payment_view`/`payment_edit` -> 403 VENDOR_FINANCE_ACCESS_DENIED
  for (const deniedPersona of [
    { capabilities: ["catalog_master_manage"], scopes: [{ kind: "all" }] },
    { capabilities: ["entry_read", "entry_review"], scopes: [{ kind: "team", id: ENTRY_ID }] },
    { capabilities: ["payment_view", "payment_edit"], scopes: [{ kind: "all" }] },
  ]) {
    const deniedRepo = makeMockRepository({
      actorAccess: {
        authorization_date: "2026-10-24",
        can_view: false,
        can_record: false,
        authority_source: "none",
      },
    });
    const deniedDeps = {
      resolveSession: async () => makeSession(deniedPersona),
      repository: deniedRepo.repository,
    };
    const getRes = await handleGetVendorFinanceVendors(
      new Request(`${ORIGIN}/api/vendor-finance/vendors`),
      "true",
      deniedDeps,
    );
    assert.equal(getRes.status, 403);
    assert.deepEqual(await getRes.json(), { ok: false, code: "VENDOR_FINANCE_ACCESS_DENIED" });
  }
});

test("evidence lifecycle: invalid upload does NOT roll back money entry, cleans staged object, allows clean retry without new money entry, and never leaks storage_key or signed URLs to logs", async () => {
  const stagedObjects = new Map();
  const finalObjects = new Map();
  const deletedStagedKeys = [];
  const reservations = new Map();
  let ledgerEntriesCount = 0;
  let failNextDbFinalize = false;

  const loggedMessages = [];
  const origError = console.error;
  console.error = (...args) => {
    loggedMessages.push(args.map(String).join(" "));
  };

  try {
    const baseMock = makeMockRepository();
    const repository = {
      ...baseMock.repository,
      async recordEntry(input) {
        ledgerEntriesCount += 1;
        return baseMock.repository.recordEntry(input);
      },
      async reserveEvidence(input) {
        const evId = reservations.size === 0 ? EV_ID_1 : EV_ID_2;
        const storageKey = `vfin-01/entry/${input.target_id}/${evId}`;
        const superseded = [];
        for (const prev of reservations.values()) {
          if (prev.status === "RESERVED") {
            prev.status = "EXPIRED";
            superseded.push(prev.storage_key);
          }
        }
        const record = {
          evidence_id: evId,
          target_kind: input.target_kind,
          target_id: input.target_id,
          status: "RESERVED",
          storage_key: storageKey,
          mime_type: input.mime_type,
          size_bytes: input.size_bytes,
          checksum_sha256: input.checksum_sha256,
          reserved_at: "2026-10-24T02:00:00.000Z",
          expires_at: "2026-10-24T02:05:00.000Z",
          finalized_at: null,
          is_expired: false,
          cleaned: false,
        };
        reservations.set(evId, record);
        return {
          ok: true,
          data: {
            reservation: record,
            superseded_storage_keys: superseded,
            replayed: false,
          },
        };
      },
      async getEvidenceReservationInfo(input) {
        const rec = reservations.get(input.evidence_id);
        return { ok: true, data: { ...rec } };
      },
      async failEvidenceReservation(input) {
        const rec = reservations.get(input.evidence_id);
        rec.status = "FAILED";
        return { ok: true, data: { evidence_id: rec.evidence_id, status: "FAILED" } };
      },
      async expireEvidenceReservation(input) {
        const rec = reservations.get(input.evidence_id);
        rec.status = "EXPIRED";
        return { ok: true, data: { evidence_id: rec.evidence_id, status: "EXPIRED" } };
      },
      async markEvidenceCleaned(input) {
        const rec = reservations.get(input.evidence_id);
        rec.cleaned = true;
        return { ok: true, data: { evidence_id: rec.evidence_id, cleaned: true } };
      },
      async finalizeEvidenceReady(input) {
        if (failNextDbFinalize) {
          failNextDbFinalize = false;
          return { ok: false, code: "VENDOR_FINANCE_UNAVAILABLE" };
        }
        const rec = reservations.get(input.evidence_id);
        const replayed = rec.status === "READY";
        rec.status = "READY";
        rec.finalized_at = "2026-10-24T02:02:00.000Z";
        return {
          ok: true,
          data: {
            evidence: {
              evidence_id: rec.evidence_id,
              target_kind: rec.target_kind,
              target_id: rec.target_id,
              status: "READY",
              mime_type: rec.mime_type,
              size_bytes: rec.size_bytes,
              checksum_sha256: rec.checksum_sha256,
              finalized_at: rec.finalized_at,
            },
            replayed,
          },
        };
      },
      async getEvidenceDownload(input) {
        const rec = reservations.get(input.evidence_id);
        return {
          ok: true,
          data: {
            evidence_id: rec.evidence_id,
            target_kind: rec.target_kind,
            target_id: rec.target_id,
            storage_key: rec.storage_key,
            mime_type: rec.mime_type,
            size_bytes: rec.size_bytes,
            checksum_sha256: rec.checksum_sha256,
            finalized_at: rec.finalized_at,
          },
        };
      },
    };

    const storage = {
      available: () => true,
      async createUploadUrl(input) {
        return {
          url: `https://r2-presign.internal/upload/${encodeURIComponent(input.storage_key)}?sig=SECRET_PUT_TOKEN`,
          expires_at: "2026-10-24T02:05:00.000Z",
          headers: { "Content-Type": input.mime_type },
        };
      },
      async readStagedBounded(storageKey) {
        if (!stagedObjects.has(storageKey)) return { kind: "missing" };
        return { kind: "found", bytes: stagedObjects.get(storageKey) };
      },
      async promoteStagedToFinal(input) {
        // Mirrors real R2 storage: CopyObject ONLY; staged object stays until DB confirms READY.
        finalObjects.set(input.storage_key, stagedObjects.get(input.storage_key));
      },
      async deleteStaged(storageKey) {
        stagedObjects.delete(storageKey);
        deletedStagedKeys.push(storageKey);
      },
      async deleteFinal(storageKey) {
        finalObjects.delete(storageKey);
      },
      async createDownloadUrl(input) {
        return {
          url: `https://r2-presign.internal/download/${encodeURIComponent(input.storage_key)}?sig=SECRET_GET_TOKEN`,
          expires_at: "2026-10-24T02:04:00.000Z",
        };
      },
    };

    const deps = {
      resolveSession: async () => makeSession(),
      repository,
      storage,
    };

    // Step 1: Record money entry -> 201
    const entryRes = await handlePostVendorFinanceEntry(
      new Request(`${ORIGIN}/api/vendor-finance/vendors/VND_ALPHA/entries`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          entry_type: "PAYMENT_RECORDED",
          amount_minor: "5000000",
          effective_date: "2026-10-24",
          reason: "Chi trả đợt 1",
          idempotency_key: IDEM_1,
        }),
      }),
      "VND_ALPHA",
      "true",
      deps,
    );
    assert.equal(entryRes.status, 201);
    assert.equal(ledgerEntriesCount, 1);

    // Step 2: Reserve evidence #1 -> 201, no storage_key leaked
    const res1 = await handlePostReserveVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          target_kind: "ENTRY",
          target_id: ENTRY_ID,
          mime_type: "image/png",
          size_bytes: VALID_PNG.byteLength,
          checksum_sha256: VALID_PNG_SHA,
          idempotency_key: IDEM_2,
        }),
      }),
      "true",
      deps,
    );
    assert.equal(res1.status, 201);
    const res1Body = await res1.json();
    assert.equal("storage_key" in res1Body.data, false);

    // Put corrupted bytes of matching length into staging
    const key1 = reservations.get(EV_ID_1).storage_key;
    stagedObjects.set(key1, new Uint8Array(VALID_PNG.byteLength).fill(0x41));

    // Step 3: Finalize #1 fails with 422, deletes staged object, marks FAILED + cleaned, money entry stays 1!
    const fin1 = await handlePostFinalizeVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_1}/finalize`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: "{}",
      }),
      EV_ID_1,
      "true",
      deps,
    );
    assert.equal(fin1.status, 422);
    assert.deepEqual(await fin1.json(), {
      ok: false,
      code: "VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID",
    });
    assert.equal(stagedObjects.has(key1), false);
    assert.equal(reservations.get(EV_ID_1).status, "FAILED");
    assert.equal(reservations.get(EV_ID_1).cleaned, true);
    assert.equal(ledgerEntriesCount, 1, "failed evidence upload must never alter or duplicate ledger entry");

    // Step 4: Retry reserve #2 + upload valid PNG + finalize #2 -> 200 READY without creating a 2nd money entry
    const res2 = await handlePostReserveVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/reserve`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: JSON.stringify({
          target_kind: "ENTRY",
          target_id: ENTRY_ID,
          mime_type: "image/png",
          size_bytes: VALID_PNG.byteLength,
          checksum_sha256: VALID_PNG_SHA,
          idempotency_key: IDEM_3,
        }),
      }),
      "true",
      deps,
    );
    assert.equal(res2.status, 201);
    const key2 = reservations.get(EV_ID_2).storage_key;
    stagedObjects.set(key2, VALID_PNG);

    // Step 4a (Blocker 1 regression): Simulate transient DB error AFTER promoteStagedToFinal copies staged -> final.
    // Staged object MUST remain intact and metadata MUST stay RESERVED so retry succeeds!
    failNextDbFinalize = true;
    const fin2TransientErr = await handlePostFinalizeVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_2}/finalize`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: "{}",
      }),
      EV_ID_2,
      "true",
      deps,
    );
    assert.equal(fin2TransientErr.status, 503);
    assert.deepEqual(await fin2TransientErr.json(), {
      ok: false,
      code: "VENDOR_FINANCE_UNAVAILABLE",
    });
    assert.equal(reservations.get(EV_ID_2).status, "RESERVED");
    assert.equal(finalObjects.has(key2), true, "final copy occurred before DB step");
    assert.equal(stagedObjects.has(key2), true, "staged object MUST be preserved until DB confirms READY");

    // Step 4b: Retry finalize #2 -> reads preserved staged object, commits READY, THEN deletes staged!
    const fin2 = await handlePostFinalizeVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_2}/finalize`, {
        method: "POST",
        headers: SAME_ORIGIN_POST_HEADERS,
        body: "{}",
      }),
      EV_ID_2,
      "true",
      deps,
    );
    assert.equal(fin2.status, 200);
    const fin2Body = await fin2.json();
    assert.equal(fin2Body.data.evidence.status, "READY");
    assert.equal(fin2Body.data.replayed, false);
    assert.equal(finalObjects.has(key2), true);
    assert.equal(stagedObjects.has(key2), false, "staged object deleted ONLY after DB confirmed READY");
    assert.equal(ledgerEntriesCount, 1);

    // Step 5: Download signed URL -> 200, omits storage_key
    const dlRes = await handleGetDownloadVendorFinanceEvidence(
      new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_ID_2}/download`),
      EV_ID_2,
      "true",
      deps,
    );
    assert.equal(dlRes.status, 200);
    const dlBody = await dlRes.json();
    assert.equal("storage_key" in dlBody.data, false);
    assert.match(dlBody.data.download.url, /^https:\/\/r2-presign\.internal\/download\//);

    // Verify zero signed URLs or storage keys appeared in logs
    for (const line of loggedMessages) {
      assert.doesNotMatch(line, /SECRET_PUT_TOKEN|SECRET_GET_TOKEN|vfin-01\/entry/);
    }
  } finally {
    console.error = origError;
  }
});

test("evidence expiry lifecycle (Blocker 2 regression): expired reservation transitions to EXPIRED without rollback, cleans staged & final R2 objects, and marks cleaned", async () => {
  const stagedObjects = new Map();
  const finalObjects = new Map();
  const EV_EXP_1 = "60000000-0000-4000-8000-000000000011";
  const EV_EXP_2 = "60000000-0000-4000-8000-000000000012";
  const keyExp1 = `vfin-01/entry/${ENTRY_ID}/${EV_EXP_1}`;
  const keyExp2 = `vfin-01/entry/${ENTRY_ID}/${EV_EXP_2}`;

  const state = new Map([
    [
      EV_EXP_1,
      {
        evidence_id: EV_EXP_1,
        target_kind: "ENTRY",
        target_id: ENTRY_ID,
        status: "RESERVED",
        storage_key: keyExp1,
        mime_type: "image/png",
        size_bytes: VALID_PNG.byteLength,
        checksum_sha256: VALID_PNG_SHA,
        expires_at: "2026-10-24T01:59:00.000Z",
        finalized_at: null,
        is_expired: true,
        cleaned: false,
      },
    ],
    [
      EV_EXP_2,
      {
        evidence_id: EV_EXP_2,
        target_kind: "ENTRY",
        target_id: ENTRY_ID,
        status: "RESERVED",
        storage_key: keyExp2,
        mime_type: "image/png",
        size_bytes: VALID_PNG.byteLength,
        checksum_sha256: VALID_PNG_SHA,
        expires_at: "2026-10-24T02:05:00.000Z",
        finalized_at: null,
        is_expired: false,
        cleaned: false,
      },
    ],
  ]);

  stagedObjects.set(keyExp1, VALID_PNG);
  finalObjects.set(keyExp1, VALID_PNG); // leftover final copy from an earlier aborted attempt
  stagedObjects.set(keyExp2, VALID_PNG);

  // Wire EV_EXP_2 through real `createVendorFinanceRepository` to verify committable `{ expired: true, status: "EXPIRED" }`
  // RPC payload mapping alongside `expireEvidenceReservation` and `markEvidenceCleaned`.
  const rpcRepo = createVendorFinanceRepository(async (fnName, params) => {
    if (fnName === "vendor_finance_get_actor_access") {
      return {
        data: {
          authorization_date: "2026-10-24",
          can_view: true,
          can_record: true,
          authority_source: "accounting_department",
        },
        error: null,
      };
    }
    const rec = state.get(params.p_evidence_id);
    if (fnName === "vendor_finance_complete_evidence") {
      if (params.p_outcome === "INFO") {
        if (rec.is_expired && rec.status === "RESERVED") {
          rec.status = "EXPIRED";
        }
        return {
          data: {
            evidence_id: rec.evidence_id,
            target_kind: rec.target_kind,
            target_id: rec.target_id,
            status: rec.status,
            storage_key: rec.storage_key,
            mime_type: rec.mime_type,
            size_bytes: rec.size_bytes,
            checksum_sha256: rec.checksum_sha256,
            expires_at: rec.expires_at,
            finalized_at: rec.finalized_at,
            is_expired: rec.status === "EXPIRED",
          },
          error: null,
        };
      }
      if (params.p_outcome === "READY") {
        // Simulate TTL expiring right before READY step: SQL commits EXPIRED and returns structured JSON (no exception!)
        rec.status = "EXPIRED";
        return {
          data: {
            expired: true,
            evidence_id: rec.evidence_id,
            status: "EXPIRED",
            failure_code: "RESERVATION_TTL_EXPIRED",
          },
          error: null,
        };
      }
      if (params.p_outcome === "EXPIRED") {
        rec.status = "EXPIRED";
        return {
          data: {
            evidence_id: rec.evidence_id,
            status: "EXPIRED",
            failure_code: params.p_failure_code ?? "RESERVATION_TTL_EXPIRED",
          },
          error: null,
        };
      }
    }
    if (fnName === "vendor_finance_mark_evidence_cleaned") {
      assert.equal(rec.status, "EXPIRED", "mark_evidence_cleaned requires committed EXPIRED/FAILED status");
      rec.cleaned = true;
      return {
        data: { evidence_id: rec.evidence_id, cleaned: true },
        error: null,
      };
    }
    throw new Error(`Unexpected RPC: ${fnName}`);
  });

  const storage = {
    available: () => true,
    async createUploadUrl() {
      throw new Error("unexpected");
    },
    async readStagedBounded(storageKey) {
      if (!stagedObjects.has(storageKey)) return { kind: "missing" };
      return { kind: "found", bytes: stagedObjects.get(storageKey) };
    },
    async promoteStagedToFinal(input) {
      finalObjects.set(input.storage_key, stagedObjects.get(input.storage_key));
    },
    async deleteStaged(storageKey) {
      stagedObjects.delete(storageKey);
    },
    async deleteFinal(storageKey) {
      finalObjects.delete(storageKey);
    },
    async createDownloadUrl() {
      throw new Error("unexpected");
    },
  };

  const deps = {
    resolveSession: async () => makeSession(),
    repository: rpcRepo,
    storage,
  };

  // Case A: Expired before INFO check -> commits EXPIRED, deletes staged & final, marks cleaned -> 409
  const resExp1 = await handlePostFinalizeVendorFinanceEvidence(
    new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_EXP_1}/finalize`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    EV_EXP_1,
    "true",
    deps,
  );
  assert.equal(resExp1.status, 409);
  assert.deepEqual(await resExp1.json(), {
    ok: false,
    code: "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED",
  });
  assert.equal(state.get(EV_EXP_1).status, "EXPIRED");
  assert.equal(state.get(EV_EXP_1).cleaned, true);
  assert.equal(stagedObjects.has(keyExp1), false);
  assert.equal(finalObjects.has(keyExp1), false);

  // Case B: Expires right at READY step after promoteStagedToFinal copied final -> commits EXPIRED, deletes BOTH final & staged, marks cleaned -> 409
  const resExp2 = await handlePostFinalizeVendorFinanceEvidence(
    new Request(`${ORIGIN}/api/vendor-finance/evidence/${EV_EXP_2}/finalize`, {
      method: "POST",
      headers: SAME_ORIGIN_POST_HEADERS,
      body: "{}",
    }),
    EV_EXP_2,
    "true",
    deps,
  );
  assert.equal(resExp2.status, 409);
  assert.deepEqual(await resExp2.json(), {
    ok: false,
    code: "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED",
  });
  assert.equal(state.get(EV_EXP_2).status, "EXPIRED");
  assert.equal(state.get(EV_EXP_2).cleaned, true);
  assert.equal(stagedObjects.has(keyExp2), false);
  assert.equal(finalObjects.has(keyExp2), false);
});

test("createVendorFinanceRepository maps known SQL tokens & fails closed on non-canonical RPC projections", async () => {
  const repoConflict = createVendorFinanceRepository(async () => ({
    data: null,
    error: { code: "23514", message: "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN" },
  }));
  const conflictRes = await repoConflict.recordEntry({
    auth_subject: AUTH_ID,
    app_user_id: APP_ID,
    vendor_id: "VND_INACTIVE",
    entry_type: "DEBT_RECORDED",
    amount_minor: "1000",
    effective_date: "2026-10-24",
    reason: "Test",
    idempotency_key: IDEM_1,
    request_fingerprint: "a".repeat(64),
  });
  assert.deepEqual(conflictRes, {
    ok: false,
    code: "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN",
  });

  const origError = console.error;
  console.error = () => {};
  try {
    const repoMalformed = createVendorFinanceRepository(async () => ({
      data: { authorization_date: "2026-10-24", can_view: true, can_record: true, authority_source: "full_admin", leaked_app_user_id: APP_ID },
      error: null,
    }));
    const malformedRes = await repoMalformed.getActorAccess({
      auth_subject: AUTH_ID,
      app_user_id: APP_ID,
    });
    assert.deepEqual(malformedRes, {
      ok: false,
      code: "VENDOR_FINANCE_UNAVAILABLE",
    });
  } finally {
    console.error = origError;
  }
});
