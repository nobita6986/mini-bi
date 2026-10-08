"use client";

import { ProjectOperations } from "@/components/direct-entry/project-operations";

const projectId = "DEMO-001";
const recruiterId = "22222222-2222-4222-8222-222222222222";

type Project = { project_id: string; display_name: string; active: boolean; version: number };
type Assignment = {
  assignment_id: string;
  project_id: string;
  project_version: number;
  manager_recruiter_id: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  version: number;
  revoked_at: string | null;
  created_at: string;
};
type Call = { url: string; method: string; body: Record<string, unknown> | null };

const projects: Project[] = [
  { project_id: projectId, display_name: "Dự án thử nghiệm", active: true, version: 1 },
  { project_id: "DEMO-OFF", display_name: "Dự án đã ngừng", active: false, version: 4 },
  ...Array.from({ length: 11 }, (_, index) => ({
    project_id: `DEMO-${String(index + 2).padStart(3, "0")}`,
    display_name: `Dự án phụ ${index + 1}`,
    active: index % 2 === 0,
    version: 1,
  })),
];

const assignments: Assignment[] = [
  { assignment_id: "ASSIGN-CURRENT", project_id: projectId, project_version: 1,
    manager_recruiter_id: recruiterId, valid_from: "2026-01-01", valid_to: null,
    effective: true, version: 4, revoked_at: null, created_at: "2026-01-01T00:00:00Z" },
  { assignment_id: "ASSIGN-FUTURE", project_id: projectId, project_version: 1,
    manager_recruiter_id: "33333333-3333-4333-8333-333333333333", valid_from: "2030-01-01",
    valid_to: null, effective: false, version: 5, revoked_at: null,
    created_at: "2026-01-02T00:00:00Z" },
  { assignment_id: "ASSIGN-REVOKED", project_id: projectId, project_version: 1,
    manager_recruiter_id: "44444444-4444-4444-8444-444444444444", valid_from: "2025-01-01",
    valid_to: "2025-06-01", effective: false, version: 6, revoked_at: "2025-06-01T00:00:00Z",
    created_at: "2025-01-01T00:00:00Z" },
];

const calls: Call[] = [];
let conflictNextMutation = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function detailFor(id: string) {
  const project = projects.find((item) => item.project_id === id);
  if (!project) return null;
  const rows = id === projectId ? assignments : [];
  return {
    ok: true,
    detail: {
      master: { project_id: project.project_id, display_name: project.display_name,
        version: project.version },
      assignments: { project_id: project.project_id, project_version: project.version,
        project_active: project.active, authorization_date: "2026-10-08",
        active_assignment_count: rows.filter((row) => row.valid_to === null && row.effective).length,
        include_history: true,
        assignments: rows.map((row) => ({ ...row, project_version: project.version })) },
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
    calls.push({ url: url.pathname + url.search, method, body });

    if (url.pathname === "/api/direct-entry/manager-candidates") {
      return json({ ok: true, candidates: [{ recruiter_id: recruiterId,
        display_name: "Nguyễn An", personnel_code: "AN-01", personnel_position: "Quản lý" }] });
    }
    if (url.pathname === "/api/direct-entry/projects" && method === "GET") {
      return json({ ok: true, list: { projects: projects.map((project) => ({ ...project })) } });
    }
    if (url.pathname === "/api/direct-entry/projects" && method === "POST") {
      if (conflictNextMutation) {
        conflictNextMutation = false;
        return json({ ok: false, code: "PROJECT_CONFLICT" }, 409);
      }
      if (!body) return json({ ok: false, code: "INVALID" }, 400);
      projects.push({ project_id: String(body.project_id), display_name: String(body.display_name),
        active: true, version: 1 });
      return json({ ok: true });
    }

    const projectRoute = url.pathname.match(/^\/api\/direct-entry\/projects\/([^/]+)(.*)$/);
    if (projectRoute) {
      const id = decodeURIComponent(projectRoute[1]);
      const suffix = projectRoute[2];
      const project = projects.find((item) => item.project_id === id);
      if (!project) return json({ ok: false, code: "NOT_FOUND" }, 404);
      if (method === "GET" && suffix === "") return json(detailFor(id));
      if (method !== "POST" && method !== "PATCH") return json({ ok: false, code: "NOT_FOUND" }, 404);
      if (conflictNextMutation) {
        conflictNextMutation = false;
        return json({ ok: false, code: "PROJECT_CONFLICT" }, 409);
      }
      if (!body) return json({ ok: false, code: "INVALID" }, 400);
      if (suffix === "" && method === "PATCH") {
        project.display_name = String(body.display_name);
        project.version += 1;
        return json({ ok: true });
      }
      if (suffix === "/active") {
        project.active = body.active === true;
        project.version += 1;
        return json({ ok: true });
      }
      if (suffix === "/managers" && method === "POST") {
        const nextVersion = project.version + 1;
        assignments.push({ assignment_id: "ASSIGN-NEW", project_id: id,
          project_version: nextVersion, manager_recruiter_id: String(body.manager_recruiter_id),
          valid_from: String(body.valid_from), valid_to: null, effective: false, version: 1,
          revoked_at: null, created_at: "2026-10-08T00:00:00Z" });
        project.version = nextVersion;
        return json({ ok: true, project: { project_version: nextVersion } });
      }
      const revokeRoute = suffix.match(/^\/managers\/([^/]+)$/);
      if (revokeRoute && method === "POST") {
        const row = assignments.find((item) => item.assignment_id === decodeURIComponent(revokeRoute[1]));
        if (!row) return json({ ok: false, code: "NOT_FOUND" }, 404);
        row.valid_to = "2026-10-08";
        row.revoked_at = "2026-10-08T00:00:00Z";
        row.version += 1;
        project.version += 1;
        return json({ ok: true, project: { project_version: project.version } });
      }
    }
    return json({ ok: false, code: "NOT_FOUND" }, 404);
  };

  (window as unknown as { __p25r4: Record<string, unknown> }).__p25r4 = {
    calls: () => calls.map((call) => ({ ...call })),
    clearCalls: () => { calls.length = 0; },
    conflictNext: () => { conflictNextMutation = true; },
    clickProject: (id: string, label: string) => {
      const row = Array.from(document.querySelectorAll("tr"))
        .find((item) => item.innerText.includes(id));
      const button = Array.from(row?.querySelectorAll("button") ?? [])
        .find((item) => item.innerText.trim() === label);
      if (!button) return false;
      button.focus();
      button.click();
      return true;
    },
    clickDialogButton: (label: string) => {
      const dialog = document.querySelector('[role="dialog"]');
      const button = Array.from(dialog?.querySelectorAll("button") ?? [])
        .find((item) => item.innerText.trim() === label);
      if (!button) return false;
      button.click();
      return true;
    },
    clickPageButton: (label: string) => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>("main > header button"))
        .find((item) => item.innerText.trim() === label);
      if (!button) return false;
      button.click();
      return true;
    },
    clickGlobalButton: (label: string) => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((item) => item.innerText.trim() === label);
      if (!button) return false;
      button.click();
      return true;
    },
    clickNextPage: () => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Phân trang danh sách dự án"] button:last-child');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    clickGroupButton: (heading: string, label: string) => {
      const group = Array.from(document.querySelectorAll("section"))
        .find((item) => item.querySelector("h3")?.innerText.trim().startsWith(heading));
      const button = Array.from(group?.querySelectorAll("button") ?? [])
        .find((item) => item.innerText.trim() === label);
      if (!button) return false;
      button.click();
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
      const label = Array.from(document.querySelectorAll("label"))
        .find((item) => item.innerText.trim() === "Lý do");
      return label?.htmlFor ? (window as unknown as { __p25r4: { fill: (selector: string, value: string) => boolean } })
        .__p25r4.fill("#" + CSS.escape(label.htmlFor), value) : false;
    },
    clickDialog: () => document.querySelector('[role="dialog"]') !== null,
    bodyText: () => document.body.innerText,
    dialogMetrics: () => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const rect = dialog?.getBoundingClientRect();
      const name = dialog?.querySelector<HTMLInputElement>("#rename-name");
      return { exists: !!dialog, left: rect?.left ?? null, right: rect?.right ?? null,
        top: rect?.top ?? null, bottom: rect?.bottom ?? null,
        width: rect?.width ?? null, scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth, focusId: document.activeElement?.id ?? null,
        nameLabelled: !!name && name.labels?.length === 1,
        alertCount: dialog?.querySelectorAll('[role="alert"]').length ?? 0 };
    },
    formSemantics: () => Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement |
      HTMLSelectElement>('[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] select'))
      .map((field) => ({
      id: field.id,
      labelled: field.labels?.length === 1,
      required: field.required,
      describedBy: field.getAttribute("aria-describedby"),
    })),
    listMetrics: () => ({ rows: document.querySelectorAll("tbody tr").length,
      projects: Array.from(document.querySelectorAll<HTMLTableRowElement>("tbody tr"), (row) => row.innerText),
      text: document.body.innerText }),
    focus: () => document.activeElement?.id ?? null,
    focusText: () => document.activeElement?.textContent?.trim() ?? null,
    valid: (selector: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
      ?.checkValidity() ?? false,
    managerOption: () => document.querySelector<HTMLElement>('[role="option"]')?.innerText ?? null,
  };
}

export default function ProjectOperationsBrowserFixture() {
  return <ProjectOperations />;
}
