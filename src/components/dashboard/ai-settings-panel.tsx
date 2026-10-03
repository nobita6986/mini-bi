"use client";

import { useCallback, useEffect, useState } from "react";
import * as AlertDialog from "radix-ui/alert-dialog";
import * as Dialog from "radix-ui/dialog";
import * as Select from "radix-ui/select";
import { Check, ChevronDown, Eye, EyeOff, KeyRound, RefreshCw } from "lucide-react";

import { decideDismiss, flowStepOf, type FlowState } from "./ai-settings-panel-logic";

/**
 * P1.5-W04A-S04 — Panel cấu hình provider AI cho Owner (pilot), Radix Dialog/Sheet + AlertDialog.
 *
 * - Overlay/focus/Escape/focus-return do Radix quản lý (không còn focus trap thủ công).
 * - API key thô chỉ sống trong state nhập liệu, bị xoá sau Lưu/Xoay/Bỏ/Đóng thành công.
 * - Luồng Owner-ready: Lưu → Kiểm tra kết nối → Kích hoạt.
 */

const SETTINGS_PATH = "/api/ai/settings";
const TEST_PATH = "/api/ai/settings/test";
const ROTATE_PATH = "/api/ai/settings/rotate";
const ACTIVATE_PATH = "/api/ai/settings/activate";
const DISABLE_PATH = "/api/ai/settings/disable";

const DEFAULT_PROVIDER_PROFILE = "openai-compatible";
const VERSION_CONFLICT_CODE = "AI_VERSION_CONFLICT";
const VERSION_CONFLICT_NOTICE = "Cấu hình đã thay đổi ở phiên khác, đang tải lại…";

const ERROR_TEXT: Record<string, string> = {
  AI_VERSION_CONFLICT: VERSION_CONFLICT_NOTICE,
  AI_CONFIG_REQUIRED: "Chưa có cấu hình AI, hãy lưu cấu hình trước.",
  AI_INPUT_INVALID: "Dữ liệu nhập không hợp lệ.",
  AI_CONFIG_NOT_VERIFIED: "Cấu hình chưa được kiểm tra kết nối thành công.",
  AI_TEST_FAILED: "Kiểm tra kết nối tới provider thất bại.",
  AI_RATE_LIMITED: "Quá nhiều yêu cầu, vui lòng thử lại sau.",
  AI_SETTINGS_DISABLED: "Bảng cấu hình AI đang tắt.",
  AI_DECRYPT_FAILED: "Không giải mã được khoá đã lưu, cần xoay API key.",
  AI_INTERNAL: "Lỗi hệ thống phía server, vui lòng thử lại.",
};

const STATUS_TEXT: Record<string, string> = {
  draft: "Đã lưu, chưa kiểm tra",
  test_failed: "Kiểm tra kết nối thất bại",
  verified: "Đã xác minh kết nối",
  active: "Đang hoạt động",
  disabled: "Đã tắt",
  rotation_required: "Cần xoay API key",
};

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";
const inputErrorClass = " border-red-500 dark:border-red-600";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";
const dangerButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-500 bg-surface px-3 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

type ProviderProfileOption = { id: string; label: string };

type AiConfigView = {
  config_id: string;
  provider_profile: string;
  model: string;
  version: number;
  status: string;
  verified_at: string | null;
  last_tested_at: string | null;
  updated_at: string | null;
  sanitized_host: string;
  key_fingerprint: string;
  optimistic_version: number;
};

type CallResult =
  | { ok: true; config: AiConfigView | null; active: boolean | null; profiles: ProviderProfileOption[] }
  | { ok: false; httpStatus: number; code: string; message: string };

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function asTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Chỉ nhận field đã sanitize; field lạ (kể cả secret) bị bỏ tại biên này. */
function toConfigView(raw: unknown): AiConfigView | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const configId = asText(record.config_id);
  if (configId.length === 0) return null;
  return {
    config_id: configId,
    provider_profile: asText(record.provider_profile),
    model: asText(record.model),
    version: asNumber(record.version),
    status: asText(record.status),
    verified_at: asTextOrNull(record.verified_at),
    last_tested_at: asTextOrNull(record.last_tested_at),
    updated_at: asTextOrNull(record.updated_at),
    sanitized_host: asText(record.sanitized_host),
    key_fingerprint: asText(record.key_fingerprint),
    optimistic_version: asNumber(record.optimistic_version),
  };
}

function shortFingerprint(value: string): string {
  return value.length === 0 ? "—" : value.slice(0, 8) + "…";
}
function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 40);
  return parsed.toLocaleString("vi-VN");
}
function statusLabel(status: string): string {
  return status.length === 0 ? "—" : STATUS_TEXT[status] ?? status;
}
function isHttpsUrl(value: string): boolean {
  if (value.length === 0) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function failureText(code: string, serverMessage: string | null): string {
  const mapped = ERROR_TEXT[code];
  if (mapped) return mapped;
  if (serverMessage && serverMessage.trim().length > 0) return serverMessage.trim().slice(0, 240);
  return ERROR_TEXT.AI_INTERNAL;
}

async function callJson(path: string, method: string, body?: Record<string, unknown>): Promise<CallResult> {
  const hasBody = typeof body !== "undefined";
  let httpStatus = 0;
  try {
    const response = await fetch(path, {
      method,
      body: hasBody ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      headers: hasBody ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
    });
    httpStatus = response.status;
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    if (!response.ok || record.ok !== true) {
      const code = typeof record.code === "string" ? record.code : "AI_INTERNAL";
      const serverMessage = typeof record.message === "string" ? record.message : null;
      return { ok: false, httpStatus, code, message: failureText(code, serverMessage) };
    }
    const profilesRaw = Array.isArray(record.provider_profiles) ? record.provider_profiles : [];
    const profiles = profilesRaw
      .map((p) => (p && typeof p === "object" ? { id: asText((p as Record<string, unknown>).id), label: asText((p as Record<string, unknown>).label) } : null))
      .filter((p): p is ProviderProfileOption => p !== null && p.id.length > 0);
    const activeRaw = record.active;
    const activeId = activeRaw && typeof activeRaw === "object" ? asText((activeRaw as Record<string, unknown>).config_id) : "";
    return {
      ok: true,
      config: toConfigView(record.config),
      active: activeId.length > 0 ? activeId === (toConfigView(record.config)?.config_id ?? "") : null,
      profiles,
    };
  } catch {
    return { ok: false, httpStatus, code: "AI_INTERNAL", message: "Không kết nối được tới server." };
  }
}

type BadgeTone = "success" | "warning" | "muted" | "error";
const BADGE_CLASSES: Record<BadgeTone, string> = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  warning: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  muted: "border-border bg-muted/40 text-muted",
  error: "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
};

function Badge({ tone, children }: { tone: BadgeTone; children: string }) {
  return <span className={"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium " + BADGE_CLASSES[tone]}>{children}</span>;
}

function badgeToneFor(status: string, active: boolean | null): { tone: BadgeTone; text: string } {
  if (active === true && status === "active") return { tone: "success", text: "Đã kích hoạt" };
  if (status === "active") return { tone: "success", text: statusLabel(status) };
  if (status === "verified") return { tone: "success", text: "Đã xác minh" };
  if (status === "draft") return { tone: "warning", text: "Đã lưu, chưa kiểm tra" };
  if (status === "disabled") return { tone: "muted", text: "Đã tắt" };
  if (status === "test_failed") return { tone: "error", text: "Kiểm tra thất bại" };
  if (status === "rotation_required") return { tone: "warning", text: "Cần xoay khoá" };
  return { tone: "muted", text: statusLabel(status) };
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-foreground">{children}</dd>
    </div>
  );
}

const STEP_LABELS = ["Lưu cấu hình", "Kiểm tra kết nối", "Kích hoạt"];

function StepIndicator({ flow }: { flow: FlowState }) {
  return (
    <ol className="flex items-center gap-1 text-xs text-muted" aria-label="Luồng cấu hình">
      {STEP_LABELS.map((label, index) => {
        const stepNumber = index + 1;
        const done = flow.doneStep >= stepNumber;
        const current = flow.currentStep === stepNumber;
        return (
          <li key={label} className="flex items-center gap-1">
            <span
              className={
                "inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold " +
                (done ? "border-emerald-500 bg-emerald-500 text-white" : current ? "border-primary bg-primary text-on-primary" : "border-border text-muted")
              }
            >
              {done ? <Check className="h-3.5 w-3.5" /> : stepNumber}
            </span>
            <span className={current ? "font-medium text-foreground" : ""}>{label}</span>
            {stepNumber < STEP_LABELS.length ? <span className="mx-1 text-muted">›</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function AiSettingsPanel() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<ProviderProfileOption[]>([]);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");

  const [apiUrl, setApiUrl] = useState("");
  const [model, setModel] = useState("");
  const [providerProfile, setProviderProfile] = useState(DEFAULT_PROVIDER_PROFILE);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);

  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const [urlTouched, setUrlTouched] = useState(false);

  const resetFormToServerState = useCallback((next: AiConfigView | null) => {
    setProviderProfile(next?.provider_profile || DEFAULT_PROVIDER_PROFILE);
    setModel(next?.model ?? "");
    setApiUrl("");
    setApiKey("");
    setShowKey(false);
    setUrlTouched(false);
  }, []);

  const dirty =
    apiKey.length > 0 ||
    apiUrl.trim().length > 0 ||
    model.trim() !== (config?.model ?? "") ||
    (providerProfile.trim() || DEFAULT_PROVIDER_PROFILE) !== (config?.provider_profile || DEFAULT_PROVIDER_PROFILE);

  const urlValid = isHttpsUrl(apiUrl.trim());
  const canSave = !busy && apiUrl.trim().length > 0 && urlValid && model.trim().length > 0 && apiKey.length > 0;
  const canTest = !busy && config !== null && config.status !== "active";
  const canActivate = !busy && config !== null && (config.status === "verified" || config.status === "active") && active !== true;
  const canRotate = !busy && config !== null && apiKey.length > 0;
  const canDisable = !busy && config !== null && config.status === "active";

  const flow = flowStepOf(config?.status ?? null);

  const performClose = useCallback(() => {
    setConfirmDiscard(false);
    setOpen(false);
  }, []);

  const requestClose = useCallback(() => {
    const decision = decideDismiss({ busy, dirty, confirmDiscard });
    if (decision === "blocked" || decision === "stay") return;
    if (decision === "confirm") {
      setConfirmDiscard(true);
      return;
    }
    performClose();
  }, [busy, confirmDiscard, dirty, performClose]);

  const discardChanges = useCallback(() => {
    setApiKey("");
    resetFormToServerState(config);
    setErrorText("");
    setStatusText("Đã bỏ thay đổi chưa lưu.");
    setConfirmDiscard(false);
    performClose();
  }, [config, performClose, resetFormToServerState]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorText("");
    setStatusText("Đang tải cấu hình AI…");
    const result = await callJson(SETTINGS_PATH, "GET");
    setLoading(false);
    if (result.ok) {
      setConfig(result.config);
      setActive(result.active);
      setProfiles(result.profiles);
      if (result.config) {
        setProviderProfile(result.config.provider_profile || DEFAULT_PROVIDER_PROFILE);
        setModel(result.config.model);
        setApiUrl("");
        setStatusText("Đã tải cấu hình AI hiện tại.");
      } else {
        setStatusText("Chưa có cấu hình AI nào được lưu.");
      }
    } else {
      setErrorText(result.message);
      setStatusText("Không tải được cấu hình AI.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, loadSettings]);

  const applyConfig = useCallback(
    (next: AiConfigView | null) => {
      setConfig(next);
      setConfirmDiscard(false);
      resetFormToServerState(next);
    },
    [resetFormToServerState],
  );

  const runRequest = useCallback(
    async (path: string, body: Record<string, unknown> | undefined, pendingText: string, onSuccess: (payload: { config: AiConfigView | null }) => void) => {
      setBusy(true);
      setErrorText("");
      setStatusText(pendingText);
      const result = await callJson(path, "POST", body);
      setBusy(false);
      if (result.ok) {
        onSuccess({ config: result.config });
        return;
      }
      if (result.httpStatus === 409 || result.code === VERSION_CONFLICT_CODE) {
        setStatusText(VERSION_CONFLICT_NOTICE);
        await loadSettings();
        return;
      }
      setErrorText(result.message);
      setStatusText("Yêu cầu không thành công.");
    },
    [loadSettings],
  );

  function handleSave() {
    if (!canSave) return;
    void runRequest(
      SETTINGS_PATH,
      { provider_profile: providerProfile.trim() || DEFAULT_PROVIDER_PROFILE, api_url: apiUrl.trim(), model: model.trim(), api_key: apiKey, expected_version: config?.version ?? null },
      "Đang lưu cấu hình AI…",
      (payload) => {
        setApiKey("");
        setShowKey(false);
        applyConfig(payload.config);
        setStatusText("Đã lưu cấu hình AI. Bước tiếp theo: Kiểm tra kết nối.");
      },
    );
  }

  function handleTest() {
    if (!canTest) return;
    const body: Record<string, unknown> = {};
    if (config) {
      body.config_id = config.config_id;
      body.version = config.version;
    }
    void runRequest(TEST_PATH, body, "Đang kiểm tra kết nối tới provider…", (payload) => {
      applyConfig(payload.config);
      const verified = payload.config?.status === "verified";
      setStatusText(verified ? "Kết nối provider đã được xác minh." : "Kiểm tra kết nối thất bại, cấu hình chưa được xác minh.");
    });
  }

  function handleRotate() {
    if (!canRotate || !config) return;
    void runRequest(
      ROTATE_PATH,
      { config_id: config.config_id, api_key: apiKey, expected_version: config?.version ?? null },
      "Đang xoay API key…",
      (payload) => {
        setApiKey("");
        setShowKey(false);
        setRotateOpen(false);
        applyConfig(payload.config);
        setStatusText("Đã xoay API key, cần kiểm tra kết nối lại.");
      },
    );
  }

  function handleActivate() {
    if (!canActivate || !config) return;
    void runRequest(ACTIVATE_PATH, { config_id: config.config_id, version: config.version }, "Đang kích hoạt cấu hình AI…", (payload) => {
      applyConfig(payload.config);
      setStatusText("Đã kích hoạt cấu hình AI.");
    });
  }

  function handleDisable() {
    if (!canDisable || !config) return;
    setConfirmDisable(false);
    void runRequest(DISABLE_PATH, { config_id: config.config_id, version: config.version }, "Đang tắt cấu hình AI…", (payload) => {
      applyConfig(payload.config);
      setStatusText("Đã tắt cấu hình AI. Báo cáo AI sẽ fail-closed.");
    });
  }

  const summaryBadge = config ? badgeToneFor(config.status, active) : { tone: "muted" as BadgeTone, text: "Chưa lưu" };

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else requestClose();
        }}
      >
        <Dialog.Trigger asChild>
          <button type="button" className={secondaryButtonClass}>
            Cấu hình AI
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 motion-safe:data-[state=open]:animate-in" />
          <Dialog.Content
            aria-describedby="ai-settings-desc"
            className="fixed inset-0 z-50 flex flex-col bg-surface text-foreground shadow-xl outline-none sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[30rem] sm:border-l sm:border-border"
          >
            <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
              <div>
                <Dialog.Title className="text-base font-semibold text-foreground">Cấu hình AI</Dialog.Title>
                <Dialog.Description id="ai-settings-desc" className="mt-0.5 text-sm text-muted">
                  Khai báo provider, model và API key cho trợ lý AI.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" disabled={busy} className={secondaryButtonClass} aria-label="Đóng">
                  Đóng
                </button>
              </Dialog.Close>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {loading ? (
                <div className="flex flex-col gap-3">
                  <div className="h-20 animate-pulse rounded-2xl bg-muted/40" />
                  <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
                  <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <StepIndicator flow={flow} />

                  <p role="status" aria-live="polite" className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-muted">
                    {statusText}
                  </p>

                  {errorText ? (
                    <p role="alert" className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                      {errorText}
                    </p>
                  ) : null}

                  <section className="rounded-2xl border border-border bg-surface p-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground">Cấu hình hiện tại</h3>
                      <Badge tone={summaryBadge.tone}>{summaryBadge.text}</Badge>
                    </div>
                    {config ? (
                      <dl className="mt-2 text-sm">
                        <DetailRow label="Provider profile">{config.provider_profile || "—"}</DetailRow>
                        <DetailRow label="Host">{config.sanitized_host || "—"}</DetailRow>
                        <DetailRow label="Model">{config.model || "—"}</DetailRow>
                        <DetailRow label="Vân tay khoá">{shortFingerprint(config.key_fingerprint)}</DetailRow>
                        <DetailRow label="Phiên bản">{String(config.version)}</DetailRow>
                        <DetailRow label="Trạng thái">{statusLabel(config.status)}</DetailRow>
                        <DetailRow label="Xác minh lúc">{formatTimestamp(config.verified_at)}</DetailRow>
                        <DetailRow label="Kiểm tra gần nhất">{formatTimestamp(config.last_tested_at)}</DetailRow>
                        <DetailRow label="Cập nhật lúc">{formatTimestamp(config.updated_at)}</DetailRow>
                      </dl>
                    ) : (
                      <p className="mt-2 text-sm text-muted">Chưa có cấu hình AI nào được lưu.</p>
                    )}
                  </section>

                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      handleSave();
                    }}
                    className="flex flex-col gap-3"
                  >
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="ai-provider-profile" className="text-sm font-medium text-foreground">
                        Provider profile
                      </label>
                      <Select.Root value={providerProfile} onValueChange={setProviderProfile} disabled={busy}>
                        <Select.Trigger id="ai-provider-profile" className={inputClass + " flex items-center justify-between data-[placeholder]:text-muted"} aria-label="Provider profile">
                          <Select.Value placeholder="Chọn provider" />
                          <Select.Icon>
                            <ChevronDown className="h-4 w-4 text-muted" />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content position="popper" className="z-50 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface p-1 text-sm text-foreground shadow-xl">
                            <Select.Viewport>
                              {(profiles.length > 0 ? profiles : [{ id: DEFAULT_PROVIDER_PROFILE, label: "OpenAI-compatible" }]).map((profile) => (
                                <Select.Item key={profile.id} value={profile.id} className="flex cursor-pointer select-none items-center justify-between rounded-md px-3 py-2 outline-none data-[highlighted]:bg-muted/15">
                                  <Select.ItemText>{profile.label}</Select.ItemText>
                                  <Select.ItemIndicator>
                                    <Check className="h-4 w-4" />
                                  </Select.ItemIndicator>
                                </Select.Item>
                              ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>
                      <p className="text-xs text-muted">Giao thức OpenAI-compatible (server chỉ hỗ trợ profile này).</p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="ai-api-url" className="text-sm font-medium text-foreground">
                        API URL
                      </label>
                      <input
                        id="ai-api-url"
                        name="api_url"
                        type="url"
                        inputMode="url"
                        placeholder="https://api.provider.example/v1"
                        value={apiUrl}
                        onChange={(event) => {
                          setApiUrl(event.target.value);
                          setUrlTouched(true);
                        }}
                        disabled={busy}
                        aria-describedby="ai-api-url-hint"
                        aria-invalid={urlTouched && !urlValid}
                        className={inputClass + (urlTouched && !urlValid ? inputErrorClass : "")}
                      />
                      <p id="ai-api-url-hint" className="text-xs text-muted">
                        Bắt buộc HTTPS. Server chỉ trả về host đã làm sạch, hãy nhập lại URL khi lưu thay đổi.
                      </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="ai-model" className="text-sm font-medium text-foreground">
                        Model
                      </label>
                      <input
                        id="ai-model"
                        name="model"
                        type="text"
                        value={model}
                        onChange={(event) => {
                          setModel(event.target.value);
                        }}
                        disabled={busy}
                        className={inputClass}
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="ai-api-key" className="text-sm font-medium text-foreground">
                        API key
                      </label>
                      <div className="relative">
                        <input
                          id="ai-api-key"
                          name="api_key"
                          type={showKey ? "text" : "password"}
                          autoComplete="new-password"
                          spellCheck={false}
                          data-1p-ignore
                          aria-describedby="ai-api-key-hint"
                          value={apiKey}
                          onChange={(event) => {
                            setApiKey(event.target.value);
                          }}
                          disabled={busy}
                          className={inputClass + " pr-11"}
                        />
                        <button
                          type="button"
                          onClick={() => setShowKey((prev) => !prev)}
                          disabled={busy}
                          aria-label={showKey ? "Ẩn API key" : "Hiện API key"}
                          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted hover:text-foreground"
                        >
                          {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <p id="ai-api-key-hint" className="text-xs text-muted">
                        API key được mã hóa phía máy chủ và không hiển thị lại sau khi lưu.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button type="submit" disabled={!canSave} className={primaryButtonClass}>
                        Lưu cấu hình
                      </button>
                      <button type="button" disabled={!canTest} onClick={handleTest} className={secondaryButtonClass}>
                        Kiểm tra kết nối
                      </button>
                      <button type="button" disabled={!canActivate} onClick={handleActivate} className={secondaryButtonClass}>
                        Kích hoạt
                      </button>
                      <button type="button" disabled={!canDisable} onClick={() => setConfirmDisable(true)} className={dangerButtonClass}>
                        Tắt cấu hình
                      </button>
                    </div>
                  </form>

                  <section className="rounded-2xl border border-border bg-surface p-4">
                    <button type="button" onClick={() => setRotateOpen((prev) => !prev)} aria-expanded={rotateOpen} className="flex min-h-11 w-full items-center justify-between gap-2 text-sm font-medium text-foreground">
                      <span className="inline-flex items-center gap-2">
                        <KeyRound className="h-4 w-4 text-muted" />
                        Xoay API key
                      </span>
                      <ChevronDown className={"h-4 w-4 text-muted transition-transform " + (rotateOpen ? "rotate-180" : "")} />
                    </button>
                    {rotateOpen ? (
                      <div className="mt-2 flex flex-col gap-1.5">
                        <label htmlFor="ai-rotate-key" className="text-sm font-medium text-foreground">
                          API key mới
                        </label>
                        <input
                          id="ai-rotate-key"
                          name="rotate_key"
                          type={showKey ? "text" : "password"}
                          autoComplete="new-password"
                          spellCheck={false}
                          data-1p-ignore
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          disabled={busy}
                          className={inputClass}
                        />
                        <p className="text-xs text-muted">Phiên bản mới sẽ cần kiểm tra kết nối lại trước khi kích hoạt.</p>
                        <button type="button" disabled={!canRotate} onClick={handleRotate} className={secondaryButtonClass}>
                          <RefreshCw className="h-4 w-4" />
                          Xoay khoá
                        </button>
                      </div>
                    ) : null}
                  </section>
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-foreground">Bỏ thay đổi chưa lưu?</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-xs text-muted">
              API key đang nhập sẽ bị xoá khỏi bộ nhớ trình duyệt và form trở về trạng thái đã lưu trên server.
            </AlertDialog.Description>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className={secondaryButtonClass}>
                  Ở lại
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button type="button" onClick={discardChanges} className={primaryButtonClass}>
                  Bỏ thay đổi
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={confirmDisable} onOpenChange={setConfirmDisable}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[70] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-foreground">Tắt cấu hình AI?</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-xs text-muted">
              Báo cáo AI sẽ fail-closed (không thể tạo báo cáo mới). Lịch sử và bản nháp đã lưu vẫn được giữ nguyên.
            </AlertDialog.Description>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className={secondaryButtonClass}>
                  Giữ hoạt động
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button type="button" onClick={handleDisable} className={dangerButtonClass}>
                  Tắt cấu hình
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
