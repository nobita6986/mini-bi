"use client";

import { useEffect, useState } from "react";

import { WorkerOperations } from "@/components/direct-entry/worker-operations";

/**
 * P2.5-HF-R5A browser fixture: mount the PRODUCTION WorkerOperations component with a
 * synthetic fetch so the acceptance run exercises real interaction, not source strings.
 */

const RECRUITER_ID = "00000002-0000-4000-8000-000000000002";
const TEAM_ID = "00000003-0000-4000-8000-000000000003";
const AUTHORIZATION_DATE = "2026-10-08";
const CURSOR_ALL = "20261008:c1000000-0000-4000-8000-000000000025";
const CURSOR_MANAGED = "20261008:c1000000-0000-4000-8000-000000000031";

type Row = Record<string, unknown>;
type Call = {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
};

const calls: Call[] = [];
let denyScope: string | null = null;
let failLoadMore = false;
let catalogDenied = false;
let catalogMode = "ready";
let conflictNext = false;

function row(index: number, name?: string): Row {
  return {
    entry_id: "c1000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    entry_version: 3,
    submission_state: "SUBMITTED",
    employee_code: "hrp-2026-" + String(index).padStart(6, "0"),
    display_name: name ?? "Người lao động " + String(index).padStart(2, "0"),
    project_id: "DEMO-ALPHA",
    project_display: "Dự án Alpha",
    first_work_date: "2026-02-01",
    labor_type: "TEMPORARY",
    employment_status: "ON",
    recruiter_id: RECRUITER_ID,
    recruiter_display: "Nguyễn An · AN-01",
    payment: null,
    pending_request: null,
    last_decision: null,
    is_project_manager: true,
    allowed_actions: {
      view: true, view_pii: true, view_payment: true,
      propose_change: true, propose_change_code: null,
    },
  };
}

const allRows = Array.from({ length: 30 }, (_, index) => row(index + 1));
const managedRows = [row(31, "Người lao động quản lý 01"), row(32, "Người lao động quản lý 02")];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

function workerPage(scope: string, cursor: string | null): Response {
  if (denyScope === scope) return json({ ok: false, code: "WORKER_SCOPE_DENIED" }, 403);
  if (cursor !== null && failLoadMore) {
    failLoadMore = false;
    return json({ ok: false, code: "WORKER_UNAVAILABLE" }, 500);
  }
  const rows = scope === "all" ? allRows : scope === "managed" ? managedRows : [];
  let items = rows;
  let has_more = false;
  let next_cursor: string | null = null;
  if (scope === "all") {
    items = cursor === null ? rows.slice(0, 25) : rows.slice(25);
    has_more = cursor === null;
    next_cursor = cursor === null ? CURSOR_ALL : null;
  } else if (scope === "managed") {
    items = cursor === null ? rows.slice(0, 1) : rows.slice(1);
    has_more = cursor === null;
    next_cursor = cursor === null ? CURSOR_MANAGED : null;
  }
  return json({ ok: true, items, scope, page_size: 25, has_more, next_cursor,
    authorization_date: AUTHORIZATION_DATE });
}

function catalogBody(effectiveDate: string): unknown {
  return {
    ok: true,
    catalog: {
      effective_date: effectiveDate,
      projects: [{ project_id: "DEMO-ALPHA", display_name: "Dự án Alpha" }],
      recruiters: [{ recruiter_id: RECRUITER_ID, display_name: "Nguyễn An", label: "Nguyễn An · AN-01",
        personnel_code: "AN-01", personnel_position: "Nhân viên", provider_type: "hrp",
        vendor_id: null, team_id: TEAM_ID, team_display_name: "TEAM1" }],
      banks: [{ bank_id: "VCB", display_name: "Vietcombank" }],
    },
  };
}

function entryBaseline(id: string): unknown {
  return {
    ok: true,
    entry: {
      entry_id: id,
      version: 3,
      project_id: "DEMO-ALPHA",
      first_work_date: "2026-02-01",
      employee_code: "hrp-2026-000001",
      recruiter_id: RECRUITER_ID,
      labor_type: "TEMPORARY",
      provider_type: "hrp",
      employment_status: { status: "ON", effective_date: "2026-01-05" },
      payment: { state: "provided", account_number: "0123456789", bank_id: "VCB",
        bank_name: "Vietcombank", account_holder_name: "NGUYEN VAN A", version: 2 },
      worker_details: {
        display_name: "Nguyễn Văn A",
        gender: { state: "provided", value: "MALE" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
    },
  };
}

if (typeof window !== "undefined") {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      window.location.href);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = null; }
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    calls.push({ url: url.pathname + url.search, method, body, headers });

    if (url.pathname === "/api/direct-entry/workers") {
      return workerPage(url.searchParams.get("scope") ?? "", url.searchParams.get("cursor"));
    }
    if (url.pathname === "/api/direct-entry/submissions") {
      return json({ ok: true,
        items: [{ submission_id: "b1000000-0000-4000-8000-000000000001", state: "SUBMITTED",
          version: 2, entry_count: 3, created_at: "2026-10-04T09:00:00.000000Z",
          updated_at: "2026-10-04T09:05:00.000000Z", submitted_at: "2026-10-04T09:06:00.000000Z",
          allowed_transitions: [], project_scoped: false }],
        page_size: 25, has_more: false, next_cursor: null });
    }
    if (url.pathname === "/api/direct-entry/change-requests" && method === "GET") {
      return json({ ok: true,
        requests: [{ request_id: "d1000000-0000-4000-8000-000000000001", state: "PENDING",
          version: 2, created_at: "2026-10-03T10:00:00.000000Z", item_count: 1,
          entry_ids: ["c1000000-0000-4000-8000-000000000001"],
          can_withdraw: true, can_decide: true }],
        page_size: 20, has_more: false, next_cursor: null });
    }
    if (url.pathname === "/api/direct-entry/catalog") {
      const effectiveDate = url.searchParams.get("effective_date") ?? "";
      if (catalogDenied) return json({ ok: false, code: "ACTOR_NOT_AVAILABLE" }, 403);
      if (catalogMode === "error") return json({ ok: false, code: "CATALOG_UNAVAILABLE" }, 500);
      return json(catalogBody(effectiveDate));
    }
    if (url.pathname.startsWith("/api/direct-entry/entries/")
        && url.pathname.endsWith("/privileged-edit") && method === "POST") {
      if (conflictNext) { conflictNext = false; return json({ ok: false, code: "ENTRY_CONFLICT" }, 409); }
      return json({ ok: true });
    }
    if (url.pathname.startsWith("/api/direct-entry/entries/") && method === "GET") {
      return json(entryBaseline(decodeURIComponent(url.pathname.split("/").pop() ?? "")));
    }
    if (url.pathname === "/api/direct-entry/change-requests" && method === "POST") {
      if (conflictNext) { conflictNext = false; return json({ ok: false, code: "ENTRY_CONFLICT" }, 409); }
      return json({ ok: true }, 201);
    }
    return json({ ok: false, code: "NOT_FOUND" }, 404);
  };

  const api = {
    calls: () => calls.map((call) => ({ ...call })),
    clearCalls: () => { calls.length = 0; },
    denyScope: (scope: string | null) => { denyScope = scope; },
    failNextLoadMore: () => { failLoadMore = true; },
    setCatalogDenied: (value: boolean) => { catalogDenied = value; },
    setCatalogError: (value: boolean) => { catalogMode = value ? "error" : "ready"; },
    conflictNext: () => { conflictNext = true; },
    bodyText: () => document.body.innerText,
    tabLabels: () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'),
      (tab) => tab.innerText.trim()),
    clickTab: (label: string) => {
      const target = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((tab) => tab.innerText.trim() === label);
      if (!target) return false;
      target.focus();
      target.click();
      return true;
    },
    listRowTexts: () => Array.from(document.querySelectorAll<HTMLElement>("tbody tr"),
      (row) => row.innerText),
    clickRowButton: (rowText: string, label: string) => {
      const target = Array.from(document.querySelectorAll<HTMLTableRowElement>("tbody tr"))
        .find((row) => row.innerText.includes(rowText));
      const control = Array.from(target?.querySelectorAll("button") ?? [])
        .find((item) => item.innerText.trim() === label);
      if (!control) return false;
      control.focus();
      control.click();
      return true;
    },
    clickButton: (label: string) => {
      const control = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((item) => item.innerText.trim() === label);
      if (!control) return false;
      control.click();
      return true;
    },
    clickDialogButton: (label: string) => {
      const dialog = document.querySelector('[role="dialog"]');
      const control = Array.from(dialog?.querySelectorAll("button") ?? [])
        .find((item) => item.innerText.trim() === label);
      if (!control) return false;
      control.click();
      return true;
    },
    fill: (selector: string, value: string) => {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
      if (!field) return false;
      field.focus();
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    fillReason: (value: string) => {
      const area = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea');
      if (!area) return false;
      return api.fill("#" + CSS.escape(area.id), value);
    },
    dialogOpen: () => document.querySelector('[role="dialog"]') !== null,
    dialogTitle: () => document.querySelector('[role="dialog"] h2')?.textContent?.trim() ?? null,
    dialogFieldIds: () => Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"] input, [role="dialog"] select, [role="dialog"] textarea'),
      (field) => field.id),
    dialogDisabledFieldIds: () => Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[role="dialog"] input, [role="dialog"] select'))
      .filter((field) => field.disabled).map((field) => field.id),
    dialogMetrics: () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const rect = dialog?.getBoundingClientRect();
      return { exists: !!dialog, left: rect?.left ?? null, right: rect?.right ?? null,
        top: rect?.top ?? null, bottom: rect?.bottom ?? null,
        scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
        focusInside: !!dialog && dialog.contains(document.activeElement),
        focusId: document.activeElement?.id ?? null,
        rowsVisible: dialog?.querySelectorAll("label").length ?? 0 };
    },
    alertClassNames: () => Array.from(document.querySelectorAll('[role="alert"]'),
      (alert) => alert.className),
    statusClassNames: () => Array.from(document.querySelectorAll('[role="status"]'),
      (status) => status.className),
    errorText: () => Array.from(document.querySelectorAll('[role="alert"]'),
      (alert) => alert.textContent ?? ""),
    focusText: () => document.activeElement?.textContent?.trim() ?? null,
    focusedId: () => document.activeElement?.id ?? null,
    queueBeforeList: () => {
      const heading = document.getElementById("direct-entry-change-requests-heading");
      const queue = heading?.closest("section") ?? null;
      const nodes = Array.from(document.querySelectorAll("main > *"));
      return {
        present: queue !== null,
        queueIndex: queue === null ? -1 : nodes.indexOf(queue),
        panelIndex: nodes.findIndex((node) => node.getAttribute("role") === "tabpanel"),
        queueCount: document.querySelectorAll("#direct-entry-change-requests-heading").length,
      };
    },
    tabpanelSelectCount: () =>
      document.querySelectorAll('[role="tabpanel"] select').length,
    fillStatusFilter: (value: string) => {
      const label = Array.from(document.querySelectorAll("label"))
        .find((item) => item.innerText.trim() === "Trạng thái làm việc");
      return label?.htmlFor ? api.fill("#" + CSS.escape(label.htmlFor), value) : false;
    },
    setPrivileged: (value: boolean) => {
      (window as unknown as { __p25r5aPrivileged?: (flag: boolean) => void })
        .__p25r5aPrivileged?.(value);
    },
    remount: () => {
      (window as unknown as { __p25r5aRemount?: () => void }).__p25r5aRemount?.();
    },
  };
  (window as unknown as { __p25r5a: typeof api }).__p25r5a = api;
}

export default function WorkerOperationsBrowserFixture() {
  const [mountKey, setMountKey] = useState(0);
  const [privileged, setPrivileged] = useState(true);
  useEffect(() => {
    const holder = window as unknown as { __p25r5aRemount?: () => void;
      __p25r5aPrivileged?: (value: boolean) => void };
    holder.__p25r5aRemount = () => setMountKey((value) => value + 1);
    holder.__p25r5aPrivileged = (value: boolean) => setPrivileged(value);
  }, []);
  return (
    <WorkerOperations
      key={mountKey}
      canSeeAllWorkers={true}
      canReview={true}
      canPrivilegedEditWorkers={privileged}
      actor={{ capabilities: ["entry_admin", "change_review"], scopes: [{ kind: "all" }] }}
    />
  );
}
