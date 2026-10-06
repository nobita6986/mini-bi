"use client";

/**
 * P1.6-I04C3-R3B - Fixture cho interactive browser component acceptance.
 *
 * File nay duoc driver COPY vao src/app/__r3b-harness/page.tsx, chay bang next dev that, roi bi xoa.
 * No KHONG nam trong production bundle cua bat ky route that nao.
 *
 * No mount CHINH component production (DirectEntryLive + dialog "Dan ho so tu Excel") va chan HTTP
 * bang mot router trong bo nho (synthetic). Khong co backdoor/env seam nao trong production code:
 * dialog goi `fetch` toan cuc, nen viec thay `window.fetch` tu harness la du.
 *
 * Toan bo du lieu la GIA (synthetic).
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { DirectEntryLive } from "@/components/direct-entry/direct-entry-live";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";

type BatchPlan = {
  mode: "success" | "malformed" | "status" | "network";
  status?: number;
  code?: string;
};

type Call = { url: string; method: string; idempotencyKey: string | null; body: string | null };

type Harness = {
  capabilities: string[];
  banks: Array<{ bank_id: string; display_name: string }>;
  drafts: unknown[];
  batch: BatchPlan;
  calls: Call[];
  entrySeq: number;
};

const DEFAULT_CAPABILITIES = ["entry_own", "entry_create", "submission_create", "payment_view",
  "payment_edit", "employment_status.apply", "document_upload", "document_view", "payment_view"];

const PROJECTS = [
  { project_id: "11111111-1111-4111-8111-111111111111", display_name: "Dự án Giả Bắc" },
  { project_id: "11111111-1111-4111-8111-111111111112", display_name: "Dự án Giả Nam" },
];
const RECRUITERS = [
  { recruiter_id: "22222222-2222-4222-8222-222222222222", display_name: "Tuyển Dụng Giả 1",
    personnel_code: null, provider_type: "hrp" as const, vendor_id: null,
    team_id: "77777777-7777-4777-8777-777777777777",
    team_display_name: "Team Giả", label: "Tuyển Dụng Giả 1 · — · Team Giả" },
];
const BANKS = [
  { bank_id: "33333333-3333-4333-8333-333333333333", display_name: "Ngân hàng Giả" },
];
const TEAM_ID = "77777777-7777-4777-8777-777777777777";

const harness: Harness = {
  capabilities: [...DEFAULT_CAPABILITIES],
  banks: [...BANKS],
  drafts: [],
  batch: { mode: "success" },
  calls: [],
  entrySeq: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function draftFromRow(row: Record<string, unknown>, entryId: string, submissionId: string) {
  const project = PROJECTS.find((item) => item.project_id === row.project_id);
  const recruiter = RECRUITERS.find((item) => item.recruiter_id === row.recruiter_id);
  const worker = (row.worker ?? {}) as Record<string, { state?: string; value?: string }>;
  return {
    entry_id: entryId,
    submission_id: submissionId,
    entry_version: 1,
    submission_version: 1,
    employee_code: row.employee_code,
    first_work_date: row.first_work_date,
    worker_display_name: row.display_name,
    project_id: row.project_id,
    project_display_name: project?.display_name ?? "",
    recruiter_id: row.recruiter_id,
    recruiter_display_name: recruiter?.display_name ?? "",
    provider_type: recruiter?.provider_type ?? "hrp",
    team_id: TEAM_ID,
    team_display_name: recruiter?.team_display_name ?? "",
    labor_type: row.labor_type,
    employment_status: "UNCONFIRMED",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    worker_national_id: worker.national_id?.value ?? null,
  };
}

if (typeof window !== "undefined") {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    harness.calls.push({
      url,
      method,
      idempotencyKey: headers["Idempotency-Key"] ?? null,
      body: typeof init?.body === "string" ? init.body : null,
    });

    if (url.startsWith("/api/direct-entry/session")) {
      return jsonResponse({ ok: true, actor: { capabilities: harness.capabilities } });
    }
    if (url.startsWith("/api/direct-entry/submissions")) {
      return jsonResponse({ ok: true, items: [], page_size: 50, has_more: false,
        next_cursor: null });
    }
    if (url.startsWith("/api/direct-entry/change-requests")) {
      return jsonResponse({ ok: true, requests: [], page_size: 50, has_more: false,
        next_cursor: null });
    }
    if (url.startsWith("/api/direct-entry/drafts")) {
      return jsonResponse({ ok: true, drafts: harness.drafts });
    }
    if (url.startsWith("/api/direct-entry/catalog")) {
      const date = new URL(url, "http://127.0.0.1").searchParams.get("effective_date") ?? "";
      const catalog: DraftCatalog = {
        effective_date: date,
        projects: PROJECTS,
        recruiters: RECRUITERS,
        banks: harness.banks,
      };
      return jsonResponse({ ok: true, catalog });
    }
    if (url.startsWith("/api/direct-entry/batches/full-profile")) {
      const plan = harness.batch;
      if (plan.mode === "network") throw new TypeError("Failed to fetch");
      if (plan.mode === "malformed") return jsonResponse({ ok: true, submission_id: "x" }, 201);
      if (plan.mode === "status") {
        return jsonResponse({ ok: false, code: plan.code ?? "BATCH_INVALID" }, plan.status ?? 400);
      }
      const parsed = JSON.parse(String(init?.body)) as { rows: Array<Record<string, unknown>> };
      const submissionId = crypto.randomUUID();
      const entryIds = parsed.rows.map(() => crypto.randomUUID());
      parsed.rows.forEach((row, index) => {
        harness.drafts.push(draftFromRow(row, entryIds[index], submissionId));
      });
      return jsonResponse({ ok: true, submission_id: submissionId, state: "DRAFT", version: 1,
        entry_ids: entryIds }, 201);
    }
    return original(input as RequestInfo, init);
  };

  (window as unknown as { __r3b: unknown }).__r3b = {
    reset: () => {
      harness.capabilities = [...DEFAULT_CAPABILITIES];
      harness.banks = [...BANKS];
      harness.drafts = [];
      harness.batch = { mode: "success" };
      harness.calls = [];
    },
    setCapabilities: (list: string[]) => { harness.capabilities = list; },
    setBanks: (banks: Array<{ bank_id: string; display_name: string }>) => {
      harness.banks = banks;
    },
    setBatch: (plan: BatchPlan) => { harness.batch = plan; },
    calls: () => harness.calls,
    drafts: () => harness.drafts,
    /** Xoa draft gia lap (giu nguyen capabilities/banks/batch plan). */
    resetDrafts: () => { harness.drafts = []; },
    setText: (value: string) => {
      const area = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="profile-paste-textarea"]');
      if (!area) return false;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(area, value);
      area.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    text: () => document.querySelector<HTMLTextAreaElement>(
      '[data-testid="profile-paste-textarea"]')?.value ?? null,
    click: (testId: string) => {
      const node = document.querySelector<HTMLElement>('[data-testid="' + testId + '"]');
      if (!node) return false;
      node.click();
      return true;
    },
    openDialog: () => {
      const node = document.querySelector<HTMLElement>('[data-testid="profile-paste-open"]');
      if (!node) return false;
      node.focus();
      node.click();
      return true;
    },
    // CSS module bi hash ten class => dung data-testid thay vi class.
    dialogOpen: () => document.querySelector('[data-testid="profile-paste-dialog"]') !== null,
    submitDisabled: () => document.querySelector<HTMLButtonElement>(
      '[data-testid="profile-submit"]')?.disabled ?? null,
    submitLabel: () => document.querySelector('[data-testid="profile-submit"]')?.textContent ?? null,
    blockers: () => Array.from(document.querySelectorAll('[data-testid="profile-blockers"] li'))
      .map((node) => node.textContent),
    summary: () => document.querySelector('[data-testid="profile-summary"]')?.textContent ?? null,
    message: () => document.querySelector('[data-testid="profile-submit-message"]')
      ?.textContent ?? null,
    saved: () => document.querySelector('[data-testid="profile-saved"]')?.textContent ?? null,
    notice: () => document.querySelector('[data-testid="profile-paste-status"]')?.textContent ?? null,
    atomicity: () => document.querySelector('[data-testid="profile-atomicity"]')?.textContent ?? null,
    activeTestId: () => document.activeElement?.getAttribute?.("data-testid") ?? null,
    rowCount: () => document.querySelectorAll('[data-testid^="profile-row-"]').length,
    cccdButtons: () => Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid^="cccd-manage-"]'))
      .map((node) => ({ id: node.getAttribute("data-testid"), disabled: node.disabled })),
    cccdLabels: () => Array.from(document.querySelectorAll('[data-testid^="cccd-status-"]'))
      .map((node) => node.textContent),
    gridRowCount: () => document.querySelectorAll('[data-testid^="cccd-manage-"]').length,
    bodyText: () => document.body.innerText,
    storageKeys: () => Object.keys(window.localStorage).length +
      Object.keys(window.sessionStorage).length,
    rect: (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { width: box.width, left: box.left, height: box.height };
    },
    viewport: () => ({ scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth }),
  };
}

export default function R3bHarnessPage() {
  const [sessionKey, setSessionKey] = useState(0);
  const remount = useCallback(() => setSessionKey((current) => current + 1), []);

  useEffect(() => {
    const api = (window as unknown as { __r3b?: Record<string, unknown> }).__r3b;
    if (api) api.remount = remount;
  }, [remount]);

  const grid = useMemo(() => <DirectEntryLive key={sessionKey} />, [sessionKey]);

  return (
    <main data-testid="r3b-harness">
      <h1>R3B harness (synthetic)</h1>
      {grid}
    </main>
  );
}
