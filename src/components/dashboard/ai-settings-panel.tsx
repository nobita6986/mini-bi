"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Panel/drawer cấu hình provider AI cho Owner (pilot).
 *
 * Client-only: chỉ gọi 5 endpoint /api/ai/settings* bằng fetch same-origin.
 * State của panel CHỈ giữ bản projection đã sanitize do server trả về
 * (provider_profile, sanitized_host, model, key_fingerprint, version, status, mốc thời gian).
 * API key thô chỉ sống trong state nhập liệu và bị xoá ngay sau khi Lưu/Xoay thành công.
 */

const SETTINGS_PATH = "/api/ai/settings";
const TEST_PATH = "/api/ai/settings/test";
const ROTATE_PATH = "/api/ai/settings/rotate";
const ACTIVATE_PATH = "/api/ai/settings/activate";
const DISABLE_PATH = "/api/ai/settings/disable";

const DEFAULT_PROVIDER_PROFILE = "openai-compatible";

const VERSION_CONFLICT_CODE = "AI_VERSION_CONFLICT";
const VERSION_CONFLICT_NOTICE = "Cấu hình đã thay đổi ở phiên khác, đang tải lại…";

/** Thông điệp ĐÓNG theo mã lỗi của server (không echo nội dung thô từ provider). */
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

/** Nhãn tiếng Việt cho vòng đời cấu hình. */
const STATUS_TEXT: Record<string, string> = {
  draft: "Bản nháp",
  test_failed: "Kiểm tra kết nối thất bại",
  verified: "Đã xác minh kết nối",
  active: "Đang hoạt động",
  disabled: "Đã tắt",
  rotation_required: "Cần xoay API key",
};

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

const secondaryButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

const primaryButtonClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

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
  | { ok: true; config: AiConfigView | null; status: string | null; verified: boolean | null }
  | { ok: false; httpStatus: number; code: string; message: string };

type SuccessPayload = { config: AiConfigView | null; status: string | null; verified: boolean | null };

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Chỉ nhận các field đã sanitize; mọi field lạ (kể cả secret) bị bỏ tại biên này. */
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

/** Rút gọn vân tay khoá: 8 ký tự đầu + dấu ba chấm. */
function shortFingerprint(value: string): string {
  if (value.length === 0) return "—";
  return value.slice(0, 8) + "…";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 40);
  return parsed.toLocaleString("vi-VN");
}

function statusLabel(status: string): string {
  if (status.length === 0) return "—";
  return STATUS_TEXT[status] ?? status;
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
      headers: hasBody
        ? { accept: "application/json", "content-type": "application/json" }
        : { accept: "application/json" },
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
    return {
      ok: true,
      config: toConfigView(record.config),
      status: typeof record.status === "string" ? record.status : null,
      // Một số phiên bản route trả "verified" dạng boolean thay cho status.
      verified: typeof record.verified === "boolean" ? record.verified : null,
    };
  } catch {
    return { ok: false, httpStatus, code: "AI_INTERNAL", message: "Không kết nối được tới server." };
  }
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1 last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

export function AiSettingsPanel() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<AiConfigView | null>(null);
  const [statusText, setStatusText] = useState("");
  const [noticeText, setNoticeText] = useState("");
  const [errorText, setErrorText] = useState("");

  const [apiUrl, setApiUrl] = useState("");
  const [model, setModel] = useState("");
  const [providerProfile, setProviderProfile] = useState(DEFAULT_PROVIDER_PROFILE);
  const [apiKey, setApiKey] = useState("");

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const apiUrlRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  /** Reset form về ĐÚNG trạng thái server đã tải (nguồn an toàn duy nhất). */
  const resetFormToServerState = useCallback((next: AiConfigView | null) => {
    setProviderProfile(next?.provider_profile || DEFAULT_PROVIDER_PROFILE);
    setModel(next?.model ?? "");
    setApiUrl("");
    setApiKey("");
  }, []);

  /**
   * R1 (A) — dirty state theo dõi URL/model/profile/API key: đóng khi dirty phải hỏi xác nhận.
   */
  const dirty =
    apiKey.length > 0 ||
    apiUrl.trim().length > 0 ||
    model.trim() !== (config?.model ?? "") ||
    (providerProfile.trim() || DEFAULT_PROVIDER_PROFILE) !== (config?.provider_profile || DEFAULT_PROVIDER_PROFILE);

  const performClose = useCallback(() => {
    setConfirmDiscard(false);
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  /**
   * MỌI đường dismiss (Escape, overlay, nút Đóng, toggle trigger) đi qua đây:
   * - busy ⇒ KHÔNG đóng panel;
   * - dirty ⇒ hiện xác nhận bỏ thay đổi trước.
   */
  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    performClose();
  }, [busy, dirty, performClose]);

  /** Owner xác nhận bỏ: xoá API key NGAY và reset form về server state an toàn rồi mới đóng. */
  const discardChanges = useCallback(() => {
    setApiKey("");
    resetFormToServerState(config);
    setErrorText("");
    setNoticeText("");
    setStatusText("Đã bỏ thay đổi chưa lưu.");
    performClose();
  }, [config, performClose, resetFormToServerState]);

  const loadSettings = useCallback(async () => {
    setBusy(true);
    setErrorText("");
    setStatusText("Đang tải cấu hình AI…");
    const result = await callJson(SETTINGS_PATH, "GET");
    if (result.ok) {
      setConfig(result.config);
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
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Hoãn một nhịp: KHÔNG setState đồng bộ trong effect (tránh cascading render),
    // và panel chỉ gọi API khi Owner mở — không tự gọi provider lúc render.
    const timer = setTimeout(() => {
      void loadSettings();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, loadSettings]);

  useEffect(() => {
    if (!open) return;
    const target = apiUrlRef.current ?? drawerRef.current;
    target?.focus();
  }, [open]);

  /**
   * R1 (A) — Focus trap THẬT cho drawer aria-modal: Tab/Shift+Tab quay vòng trong panel,
   * focus không thoát ra nền; Escape chỉ đóng khi không busy.
   */
  useEffect(() => {
    if (!open) return;
    const FOCUSABLE_SELECTOR =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const focusables = () => {
      const nodes = drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      return nodes ? Array.from(nodes).filter((node) => node.getAttribute("aria-hidden") !== "true") : [];
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const inside = drawerRef.current?.contains(document.activeElement as Node | null) ?? false;
      if (items.length === 0) {
        event.preventDefault();
        drawerRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey) {
        if (!inside || document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const node = event.target as Node | null;
      if (!drawerRef.current || !node) return;
      if (drawerRef.current.contains(node)) return;
      const items = focusables();
      if (items.length > 0) items[0].focus();
      else drawerRef.current.focus();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [open, requestClose]);

  const applyConfig = useCallback((next: AiConfigView | null) => {
    setConfig(next);
    setConfirmDiscard(false);
    // Sau mutation thành công: form trở về server state và API key đã được xoá.
    resetFormToServerState(next);
  }, [resetFormToServerState]);

  const runRequest = useCallback(
    async (
      path: string,
      body: Record<string, unknown> | undefined,
      pendingText: string,
      onSuccess: (payload: SuccessPayload) => void,
    ) => {
      setBusy(true);
      setErrorText("");
      setNoticeText("");
      setStatusText(pendingText);
      const result = await callJson(path, "POST", body);
      setBusy(false);
      if (result.ok) {
        onSuccess({ config: result.config, status: result.status, verified: result.verified });
        return;
      }
      if (result.httpStatus === 409 || result.code === VERSION_CONFLICT_CODE) {
        setNoticeText(VERSION_CONFLICT_NOTICE);
        await loadSettings();
        return;
      }
      setErrorText(result.message);
      setStatusText("Yêu cầu không thành công.");
    },
    [loadSettings],
  );

  function handleSave() {
    if (busy) return;
    const url = apiUrl.trim();
    const modelName = model.trim();
    if (url.length === 0 || modelName.length === 0 || apiKey.length === 0) {
      setStatusText("Thiếu dữ liệu bắt buộc.");
      setErrorText("Vui lòng nhập API URL, model và API key trước khi lưu.");
      return;
    }
    void runRequest(
      SETTINGS_PATH,
      {
        provider_profile: providerProfile.trim() || DEFAULT_PROVIDER_PROFILE,
        api_url: url,
        model: modelName,
        api_key: apiKey,
        expected_version: config?.version ?? null,
      },
      "Đang lưu cấu hình AI…",
      (payload) => {
        setApiKey("");
        applyConfig(payload.config);
        setStatusText("Đã lưu cấu hình AI.");
      },
    );
  }

  function handleTest() {
    if (busy) return;
    const body: Record<string, unknown> = {};
    if (config) {
      body.config_id = config.config_id;
      body.version = config.version;
    }
    void runRequest(TEST_PATH, body, "Đang kiểm tra kết nối tới provider…", (payload) => {
      applyConfig(payload.config);
      const verified = payload.status === "verified" || payload.verified === true;
      setStatusText(
        verified
          ? "Kết nối provider đã được xác minh."
          : "Kiểm tra kết nối thất bại, cấu hình chưa được xác minh.",
      );
    });
  }

  function handleRotate() {
    if (busy || !config) return;
    if (apiKey.length === 0) {
      setStatusText("Thiếu API key mới.");
      setErrorText("Vui lòng nhập API key mới trước khi xoay khoá.");
      return;
    }
    void runRequest(
      ROTATE_PATH,
      {
        config_id: config.config_id,
        api_key: apiKey,
        expected_version: config?.version ?? null,
      },
      "Đang xoay API key…",
      (payload) => {
        setApiKey("");
        applyConfig(payload.config);
        setStatusText("Đã xoay API key, cần kiểm tra kết nối lại.");
      },
    );
  }

  function handleActivate() {
    if (busy || !config) return;
    void runRequest(
      ACTIVATE_PATH,
      { config_id: config.config_id, version: config.version },
      "Đang kích hoạt cấu hình AI…",
      (payload) => {
        applyConfig(payload.config);
        setStatusText("Đã kích hoạt cấu hình AI.");
      },
    );
  }

  function handleDisable() {
    if (busy || !config) return;
    void runRequest(
      DISABLE_PATH,
      { config_id: config.config_id, version: config.version },
      "Đang tắt cấu hình AI…",
      (payload) => {
        applyConfig(payload.config);
        setStatusText("Đã tắt cấu hình AI.");
      },
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="ai-settings-drawer"
        onClick={() => {
          if (open) {
            requestClose();
            return;
          }
          setOpen(true);
        }}
        className={secondaryButtonClass}
      >
        Cấu hình AI
      </button>

      {open ? (
        <>
          <div aria-hidden onClick={requestClose} className="fixed inset-0 z-40 bg-black/40" />

          <aside
            ref={drawerRef}
            id="ai-settings-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-settings-title"
            tabIndex={-1}
            className="fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto border border-border bg-surface p-4 text-foreground shadow-xl sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[26rem] sm:rounded-l-2xl sm:p-5"
          >
            <header className="flex items-start justify-between gap-3">
              <div>
                <h2 id="ai-settings-title" className="text-base font-semibold text-foreground">
                  Cấu hình AI
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Dành cho Owner (pilot): khai báo provider, model và API key cho trợ lý AI.
                </p>
              </div>
              <button type="button" onClick={requestClose} disabled={busy} className={secondaryButtonClass}>
                Đóng
              </button>
            </header>

            <p role="status" aria-live="polite" className="rounded-2xl border border-border bg-surface p-3 text-sm text-muted">
              <span>{statusText}</span>
              {noticeText ? <span className="mt-1 block font-medium text-foreground">{noticeText}</span> : null}
              {errorText ? <span className="mt-1 block font-medium text-foreground">{errorText}</span> : null}
            </p>

            {confirmDiscard ? (
              <div
                role="alertdialog"
                aria-labelledby="ai-discard-title"
                aria-describedby="ai-discard-detail"
                className="rounded-2xl border border-border bg-surface p-3"
              >
                <p id="ai-discard-title" className="text-sm font-semibold text-foreground">
                  Bỏ thay đổi chưa lưu?
                </p>
                <p id="ai-discard-detail" className="mt-1 text-xs text-muted">
                  API key đang nhập sẽ bị xoá khỏi bộ nhớ trình duyệt và form trở về trạng thái đã lưu trên server.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={discardChanges} className={primaryButtonClass}>
                    Bỏ thay đổi
                  </button>
                  <button type="button" onClick={() => setConfirmDiscard(false)} className={secondaryButtonClass}>
                    Ở lại
                  </button>
                </div>
              </div>
            ) : null}

            <section className="rounded-2xl border border-border bg-surface p-3">
              <h3 className="text-sm font-semibold text-foreground">Cấu hình hiện tại</h3>
              {config ? (
                <dl className="mt-2 text-sm">
                  <DetailRow label="Provider profile" value={config.provider_profile || "—"} />
                  <DetailRow label="Host đã làm sạch" value={config.sanitized_host || "—"} />
                  <DetailRow label="Model" value={config.model || "—"} />
                  <DetailRow label="Vân tay khoá" value={shortFingerprint(config.key_fingerprint)} />
                  <DetailRow label="Phiên bản" value={String(config.version)} />
                  <DetailRow label="Trạng thái" value={statusLabel(config.status)} />
                  <DetailRow label="Xác minh lúc" value={formatTimestamp(config.verified_at)} />
                  <DetailRow label="Kiểm tra gần nhất" value={formatTimestamp(config.last_tested_at)} />
                  <DetailRow label="Cập nhật lúc" value={formatTimestamp(config.updated_at)} />
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
              <div className="flex flex-col gap-1">
                <label htmlFor="ai-provider-profile" className="text-sm font-medium text-foreground">
                  Provider profile
                </label>
                <input
                  id="ai-provider-profile"
                  name="provider_profile"
                  type="text"
                  value={providerProfile}
                  onChange={(event) => setProviderProfile(event.target.value)}
                  disabled={busy}
                  className={inputClass}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="ai-api-url" className="text-sm font-medium text-foreground">
                  API URL
                </label>
                <input
                  id="ai-api-url"
                  name="api_url"
                  ref={apiUrlRef}
                  type="url"
                  inputMode="url"
                  placeholder="https://api.provider.example/v1"
                  value={apiUrl}
                  onChange={(event) => setApiUrl(event.target.value)}
                  disabled={busy}
                  aria-describedby="ai-api-url-hint"
                  className={inputClass}
                />
                <p id="ai-api-url-hint" className="text-xs text-muted">
                  Server chỉ trả về host đã làm sạch, nên hãy nhập lại API URL khi lưu thay đổi.
                </p>
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="ai-model" className="text-sm font-medium text-foreground">
                  Model
                </label>
                <input
                  id="ai-model"
                  name="model"
                  type="text"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={busy}
                  className={inputClass}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="ai-api-key" className="text-sm font-medium text-foreground">
                  API key
                </label>
                <input
                  id="ai-api-key"
                  name="api_key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  aria-describedby="ai-api-key-hint"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={busy}
                  className={inputClass}
                />
                <p id="ai-api-key-hint" className="text-xs text-muted">
                  Khoá chỉ được mã hoá ở server, không hiển thị lại
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className={primaryButtonClass}>
                  Lưu cấu hình
                </button>
                <button type="button" disabled={busy} onClick={handleTest} className={secondaryButtonClass}>
                  Kiểm tra kết nối
                </button>
                <button type="button" disabled={busy || !config} onClick={handleRotate} className={secondaryButtonClass}>
                  Xoay API key
                </button>
                <button type="button" disabled={busy || !config} onClick={handleActivate} className={secondaryButtonClass}>
                  Kích hoạt
                </button>
                <button type="button" disabled={busy || !config} onClick={handleDisable} className={secondaryButtonClass}>
                  Tắt cấu hình
                </button>
              </div>
            </form>
          </aside>
        </>
      ) : null}
    </div>
  );
}
