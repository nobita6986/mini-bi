import type { ActorResolution } from "../auth/direct-entry-v2.ts";
import {
  decideSessionPageAccess,
  type SessionPageDecision,
} from "../auth/session-page-access.ts";
import {
  SALARY_ADVANCE_EVIDENCE_MAX_BYTES,
  SALARY_ADVANCE_PAYMENT_METHODS,
  isSelfOwnedBankAccountNameMatch,
  type SalaryAdvanceActorContext,
  type SalaryAdvanceActorRole,
  type SalaryAdvanceAllowedActions,
  type SalaryAdvanceBankIneligibleReason,
  type SalaryAdvanceErrorCode,
  type SalaryAdvanceEventItem,
  type SalaryAdvanceEventType,
  type SalaryAdvanceEvidenceKind,
  type SalaryAdvanceEvidenceMimeType,
  type SalaryAdvanceEvidenceReserveResponse,
  type SalaryAdvanceEvidenceReviewDecision,
  type SalaryAdvanceEvidenceReviewState,
  type SalaryAdvanceEvidenceVersionItem,
  type SalaryAdvanceMutationDetailResponse,
  type SalaryAdvancePaymentDestinationSnapshot,
  type SalaryAdvancePaymentMethod,
  type SalaryAdvanceQueue,
  type SalaryAdvanceRequestDetail,
  type SalaryAdvanceRequestListResponse,
  type SalaryAdvanceRequestState,
  type SalaryAdvanceRequestSummary,
  type SalaryAdvanceTransitionAction,
  type SalaryAdvanceWorkerEligibilitySummary,
  type SalaryAdvanceWorkerEmploymentStatus,
  type SalaryAdvanceWorkerIneligibleReason,
  type SalaryAdvanceWorkerOption,
} from "./salary-advance-contract.ts";

export type SalaryAdvancePageAccessDecision =
  | "NOT_FOUND"
  | SessionPageDecision
  | "ACCESS_DENIED";

export type SalaryAdvanceWorkspaceTabId = "pm" | "accountant" | "supervisory";

export type SalaryAdvanceWorkspaceTab = {
  id: SalaryAdvanceWorkspaceTabId;
  label: string;
  description: string;
  queue: Extract<SalaryAdvanceQueue, "PM" | "ACCOUNTANT" | "SUPERVISORY">;
  badgeCount: number;
};

export type SalaryAdvanceBadgeTone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";

export type SalaryAdvanceRequestStateMeta = {
  state: SalaryAdvanceRequestState;
  label: string;
  shortLabel: string;
  tone: SalaryAdvanceBadgeTone;
  isTerminal: boolean;
};

export type SalaryAdvanceEvidenceReviewStateMeta = {
  state: SalaryAdvanceEvidenceReviewState;
  label: string;
  shortLabel: string;
  tone: SalaryAdvanceBadgeTone;
};

export type SalaryAdvancePaymentMethodMeta = {
  method: SalaryAdvancePaymentMethod;
  label: string;
  shortLabel: string;
  evidenceKind: SalaryAdvanceEvidenceKind;
  evidenceTitle: string;
  evidenceShortTitle: string;
  tone: SalaryAdvanceBadgeTone;
};

export type SalaryAdvanceWorkerEligibilityView = {
  employmentStatus: SalaryAdvanceWorkerEmploymentStatus;
  activeOnProjectCount: number;
  hasDuplicateCccd: boolean;
  isEligible: boolean;
  statusLabel: string;
  tone: SalaryAdvanceBadgeTone;
  reasonCodes: SalaryAdvanceWorkerIneligibleReason[];
  reasonLabels: string[];
  blockingMessage: string | null;
};

export type SalaryAdvanceWorkerBankTransferView = {
  canUseBankTransfer: boolean;
  hasBankAccount: boolean;
  isSelfOwned: boolean;
  statusLabel: string;
  tone: SalaryAdvanceBadgeTone;
  reasonCode: SalaryAdvanceBankIneligibleReason | null;
  blockingMessage: string | null;
  bankId: string | null;
  institutionName: string | null;
  accountNumber: string | null;
  accountNumberMasked: string | null;
  accountHolderName: string | null;
};

export type SalaryAdvanceAvailableActionsView = {
  canPostMessage: boolean;
  canProvideInfo: boolean;
  canWithdraw: boolean;
  canUploadEvidence: boolean;
  canRequestInfo: boolean;
  canApprove: boolean;
  canReject: boolean;
  canMarkHandledExternally: boolean;
  canReviewEvidence: boolean;
  hasAnyPmMutation: boolean;
  hasAnyAccountantDecision: boolean;
  hasAnyMutation: boolean;
};

export type SalaryAdvanceAttentionIndicator = {
  needsAttention: boolean;
  label: string | null;
  tone: SalaryAdvanceBadgeTone;
};

export type SalaryAdvanceComparisonPanelModel = {
  requestId: string;
  paymentMethod: SalaryAdvancePaymentMethod;
  evidenceKind: SalaryAdvanceEvidenceKind;
  requiresWorkerPortraitComparison: boolean;
  paymentDestinationSnapshot: SalaryAdvancePaymentDestinationSnapshot | null;
  workerEntryId: string;
  workerEmployeeCode: string;
  workerDisplayName: string;
  hasWorkerPortrait: boolean;
  workerPortrait: {
    documentId: string;
    version: number;
    mimeType: string;
    sizeBytes: number;
    previewUrl: string;
    sourceLabel: string;
  } | null;
  missingPortraitWarning: string | null;
  hasEvidencePhoto: boolean;
  selectedEvidence: {
    eventId: string;
    evidenceVersion: number;
    evidenceKind: SalaryAdvanceEvidenceKind;
    mimeType: SalaryAdvanceEvidenceMimeType;
    sizeBytes: number;
    captionNote: string | null;
    uploadedByUserId: string;
    uploadedByDisplayName: string | null;
    uploadedAt: string;
    reviewState: SalaryAdvanceEvidenceReviewState;
    reviewedByUserId: string | null;
    reviewedByDisplayName: string | null;
    reviewedAt: string | null;
    reviewNote: string | null;
    workerPortraitDocumentId: string | null;
    workerPortraitVersion: number | null;
    isCurrent: boolean;
    previewUrl: string;
    sourceLabel: string;
  } | null;
  evidenceVersions: Array<{
    evidenceVersion: number;
    evidenceKind: SalaryAdvanceEvidenceKind;
    isCurrent: boolean;
    reviewState: SalaryAdvanceEvidenceReviewState;
    uploadedAt: string;
    uploadedByDisplayName: string | null;
  }>;
  canUploadEvidence: boolean;
  canReviewEvidence: boolean;
  canConfirmReviewed: boolean;
  canRequestRetake: boolean;
  confirmReviewedLockReason: string | null;
};

export type CreateSalaryAdvanceDraftInput = {
  projectId: string;
  hasActiveAccountant?: boolean;
  workerEntryId: string;
  requestedAmountRaw: string;
  paymentMethod?: string | null;
  selectedWorker?: SalaryAdvanceWorkerOption | null;
  initialContent: string;
};

export type CreateSalaryAdvanceValidationResult =
  | {
      ok: true;
      payload: {
        project_id: string;
        worker_entry_id: string;
        requested_amount_vnd: string;
        payment_method: SalaryAdvancePaymentMethod;
        initial_content: string;
      };
    }
  | {
      ok: false;
      message: string;
      fieldErrors: Partial<
        Record<
          | "projectId"
          | "workerEntryId"
          | "requestedAmountRaw"
          | "paymentMethod"
          | "initialContent",
          string
        >
      >;
    };

export const SALARY_ADVANCE_NON_ACCOUNTING_NOTICE =
  "Phân hệ Ứng lương chỉ phục vụ trao đổi, phê duyệt nội bộ và đối chiếu ảnh nhận tiền mặt giữa QLDA và Kế toán dự án; không tự động tạo bút toán hay lệnh chi trong BI.";

export const SALARY_ADVANCE_MISSING_PORTRAIT_WARNING =
  "Hồ sơ người lao động hiện chưa có ảnh chân dung chuẩn trong hệ thống. Không thể xác nhận «Đã đối chiếu» cho đến khi ảnh hồ sơ NLĐ được cập nhật, nhưng yêu cầu và ảnh nhận tiền mặt đã tải lên vẫn được giữ nguyên.";

const REQUEST_STATE_META: Record<
  SalaryAdvanceRequestState,
  SalaryAdvanceRequestStateMeta
> = {
  OPEN: {
    state: "OPEN",
    label: "Đang chờ Kế toán xử lý",
    shortLabel: "Đang mở",
    tone: "warning",
    isTerminal: false,
  },
  NEEDS_INFO: {
    state: "NEEDS_INFO",
    label: "Cần QLDA bổ sung thông tin",
    shortLabel: "Cần bổ sung",
    tone: "info",
    isTerminal: false,
  },
  APPROVED: {
    state: "APPROVED",
    label: "Đã chấp thuận ứng lương",
    shortLabel: "Đã chấp thuận",
    tone: "success",
    isTerminal: true,
  },
  REJECTED: {
    state: "REJECTED",
    label: "Đã từ chối",
    shortLabel: "Đã từ chối",
    tone: "danger",
    isTerminal: true,
  },
  WITHDRAWN: {
    state: "WITHDRAWN",
    label: "QLDA đã rút yêu cầu",
    shortLabel: "Đã rút",
    tone: "neutral",
    isTerminal: true,
  },
  HANDLED_EXTERNALLY: {
    state: "HANDLED_EXTERNALLY",
    label: "Đã xử lý ngoài BI",
    shortLabel: "Xử lý ngoài BI",
    tone: "primary",
    isTerminal: true,
  },
};

const EVIDENCE_REVIEW_STATE_META: Record<
  SalaryAdvanceEvidenceReviewState,
  SalaryAdvanceEvidenceReviewStateMeta
> = {
  NOT_UPLOADED: {
    state: "NOT_UPLOADED",
    label: "Chưa tải ảnh nhận tiền",
    shortLabel: "Chưa có ảnh",
    tone: "neutral",
  },
  PENDING_REVIEW: {
    state: "PENDING_REVIEW",
    label: "Chờ Kế toán đối chiếu ảnh",
    shortLabel: "Chờ đối chiếu",
    tone: "warning",
  },
  REVIEWED: {
    state: "REVIEWED",
    label: "Đã đối chiếu ảnh nhận tiền",
    shortLabel: "Đã đối chiếu",
    tone: "success",
  },
  RETAKE_REQUIRED: {
    state: "RETAKE_REQUIRED",
    label: "Yêu cầu chụp/gửi lại ảnh",
    shortLabel: "Cần gửi lại ảnh",
    tone: "danger",
  },
};

const EVENT_TYPE_LABELS: Record<SalaryAdvanceEventType, string> = {
  REQUEST_CREATED: "Tạo yêu cầu ứng lương",
  MESSAGE_POSTED: "Gửi tin nhắn trao đổi",
  INFO_REQUESTED: "Yêu cầu bổ sung thông tin",
  INFO_PROVIDED: "Đã bổ sung thông tin",
  REQUEST_APPROVED: "Chấp thuận yêu cầu",
  REQUEST_REJECTED: "Từ chối yêu cầu",
  REQUEST_WITHDRAWN: "Rút yêu cầu ứng lương",
  HANDLED_EXTERNALLY_MARKED: "Đánh dấu đã xử lý ngoài BI",
  EVIDENCE_UPLOADED: "Tải lên ảnh NLĐ nhận tiền mặt",
  EVIDENCE_REVIEWED: "Xác nhận đã đối chiếu ảnh nhận tiền",
  EVIDENCE_RETAKE_REQUESTED: "Yêu cầu chụp/gửi lại ảnh nhận tiền",
};

const ACTOR_ROLE_LABELS: Record<SalaryAdvanceActorRole, string> = {
  PROJECT_MANAGER: "Quản lý dự án (QLDA)",
  PROJECT_ACCOUNTANT: "Kế toán dự án",
};

const CONFLICT_ERROR_CODES = new Set<string>([
  "SALARY_ADVANCE_VERSION_CONFLICT",
  "SALARY_ADVANCE_STATE_CONFLICT",
  "SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT",
  "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT",
  "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT",
]);

export function decideSalaryAdvancePageAccess(params: {
  enabledFlag: string | undefined;
  actor: ActorResolution | null;
  contextErrorCode?: string | null;
}): SalaryAdvancePageAccessDecision {
  if (params.enabledFlag !== "true") {
    return "NOT_FOUND";
  }

  const sessionDecision = decideSessionPageAccess(params.actor);
  if (sessionDecision !== "ALLOW") {
    return sessionDecision;
  }

  if (params.contextErrorCode === "SALARY_ADVANCE_ACCESS_DENIED") {
    return "ACCESS_DENIED";
  }

  return "ALLOW";
}

export function canAccessSalaryAdvanceContext(
  context: Pick<
    SalaryAdvanceActorContext,
    "is_project_manager" | "is_project_accountant" | "is_supervisory_viewer"
  > | null
): boolean {
  if (!context) return false;
  return Boolean(
    context.is_project_manager ||
      context.is_project_accountant ||
      context.is_supervisory_viewer
  );
}

export function resolveVisibleSalaryAdvanceTabs(
  context: Pick<
    SalaryAdvanceActorContext,
    "is_project_manager" | "is_project_accountant" | "is_supervisory_viewer"
  >,
  badgeCounts?: Partial<Record<SalaryAdvanceWorkspaceTabId, number>>
): SalaryAdvanceWorkspaceTab[] {
  const tabs: SalaryAdvanceWorkspaceTab[] = [];

  if (context.is_project_manager) {
    tabs.push({
      id: "pm",
      label: "Yêu cầu tôi tạo",
      description:
        "Tạo yêu cầu ứng lương cho NLĐ thuộc dự án quản lý, phản hồi thông tin và tải ảnh NLĐ nhận tiền mặt.",
      queue: "PM",
      badgeCount: Math.max(0, Math.trunc(badgeCounts?.pm ?? 0)),
    });
  }

  if (context.is_project_accountant) {
    tabs.push({
      id: "accountant",
      label: "Cần xử lý",
      description:
        "Hàng đợi Kế toán dự án tiếp nhận, trao đổi, phê duyệt/từ chối và đối chiếu ảnh nhận tiền mặt.",
      queue: "ACCOUNTANT",
      badgeCount: Math.max(0, Math.trunc(badgeCounts?.accountant ?? 0)),
    });
  }

  if (context.is_supervisory_viewer) {
    tabs.push({
      id: "supervisory",
      label: "Giám sát toàn miền",
      description:
        "Tra cứu chỉ đọc toàn bộ yêu cầu ứng lương và lịch sử đối chiếu ảnh trên hệ thống.",
      queue: "SUPERVISORY",
      badgeCount: Math.max(0, Math.trunc(badgeCounts?.supervisory ?? 0)),
    });
  }

  return tabs;
}

const PAYMENT_METHOD_META: Record<
  SalaryAdvancePaymentMethod,
  SalaryAdvancePaymentMethodMeta
> = {
  CASH: {
    method: "CASH",
    label: "Nhận tiền mặt",
    shortLabel: "Tiền mặt",
    evidenceKind: "CASH_HANDOVER_PHOTO",
    evidenceTitle: "Ảnh NLĐ nhận tiền mặt",
    evidenceShortTitle: "Ảnh nhận tiền mặt",
    tone: "info",
  },
  BANK_TRANSFER: {
    method: "BANK_TRANSFER",
    label: "Chuyển khoản ngân hàng",
    shortLabel: "Chuyển khoản",
    evidenceKind: "BANK_TRANSFER_RECEIPT",
    evidenceTitle: "Chứng từ chuyển khoản",
    evidenceShortTitle: "Bill chuyển khoản",
    tone: "primary",
  },
};

const WORKER_INELIGIBLE_REASON_LABELS: Record<
  SalaryAdvanceWorkerIneligibleReason,
  string
> = {
  WORKER_STATUS_OFF: "NLĐ đã nghỉ việc (OFF)",
  WORKER_STATUS_UNCONFIRMED: "Trạng thái làm việc chưa xác nhận (UNCONFIRMED)",
  WORKER_MULTI_PROJECT_ON: "NLĐ đang ON tại từ 2 dự án trở lên",
  WORKER_DUPLICATE_CCCD: "Hồ sơ thuộc nhóm trùng CCCD cần rà soát",
};

const BANK_INELIGIBLE_REASON_LABELS: Record<
  SalaryAdvanceBankIneligibleReason,
  string
> = {
  BANK_ACCOUNT_MISSING:
    "Hồ sơ NLĐ chưa có đầy đủ thông tin tài khoản ngân hàng",
  BANK_ACCOUNT_NOT_SELF_OWNED:
    "Tên chủ tài khoản ngân hàng không trùng khớp với họ tên NLĐ (không chính chủ)",
};

export function getPaymentMethodMeta(
  method: SalaryAdvancePaymentMethod | string | null | undefined
): SalaryAdvancePaymentMethodMeta {
  if (method === "BANK_TRANSFER") {
    return PAYMENT_METHOD_META.BANK_TRANSFER;
  }
  return PAYMENT_METHOD_META.CASH;
}

export function getEvidenceKindLabel(
  kind: SalaryAdvanceEvidenceKind | string | null | undefined
): string {
  if (kind === "BANK_TRANSFER_RECEIPT") {
    return "Chứng từ chuyển khoản";
  }
  return "Ảnh NLĐ nhận tiền mặt";
}

export function getWorkerIneligibleReasonLabel(
  reason: SalaryAdvanceWorkerIneligibleReason | string
): string {
  return (
    WORKER_INELIGIBLE_REASON_LABELS[
      reason as SalaryAdvanceWorkerIneligibleReason
    ] ?? reason
  );
}

export function getBankIneligibleReasonLabel(
  reason: SalaryAdvanceBankIneligibleReason | string
): string {
  return (
    BANK_INELIGIBLE_REASON_LABELS[
      reason as SalaryAdvanceBankIneligibleReason
    ] ?? reason
  );
}

export function describeWorkerEligibility(
  worker:
    | Pick<
        SalaryAdvanceWorkerOption,
        | "employment_status"
        | "active_on_project_count"
        | "has_duplicate_cccd"
        | "is_eligible"
        | "ineligible_reasons"
      >
    | SalaryAdvanceWorkerEligibilitySummary
    | null
    | undefined
): SalaryAdvanceWorkerEligibilityView {
  const employmentStatus: SalaryAdvanceWorkerEmploymentStatus =
    worker?.employment_status === "OFF" ||
    worker?.employment_status === "UNCONFIRMED"
      ? worker.employment_status
      : "ON";
  const activeOnProjectCount =
    typeof worker?.active_on_project_count === "number" &&
    Number.isFinite(worker.active_on_project_count)
      ? Math.max(0, Math.trunc(worker.active_on_project_count))
      : employmentStatus === "ON"
        ? 1
        : 0;
  const hasDuplicateCccd = Boolean(worker?.has_duplicate_cccd);

  const derivedReasons: SalaryAdvanceWorkerIneligibleReason[] = [];
  if (Array.isArray(worker?.ineligible_reasons)) {
    for (const r of worker.ineligible_reasons) {
      if (!derivedReasons.includes(r)) {
        derivedReasons.push(r);
      }
    }
  }
  if (
    employmentStatus === "OFF" &&
    !derivedReasons.includes("WORKER_STATUS_OFF")
  ) {
    derivedReasons.push("WORKER_STATUS_OFF");
  }
  if (
    employmentStatus === "UNCONFIRMED" &&
    !derivedReasons.includes("WORKER_STATUS_UNCONFIRMED")
  ) {
    derivedReasons.push("WORKER_STATUS_UNCONFIRMED");
  }
  if (
    activeOnProjectCount >= 2 &&
    !derivedReasons.includes("WORKER_MULTI_PROJECT_ON")
  ) {
    derivedReasons.push("WORKER_MULTI_PROJECT_ON");
  }
  if (
    hasDuplicateCccd &&
    !derivedReasons.includes("WORKER_DUPLICATE_CCCD")
  ) {
    derivedReasons.push("WORKER_DUPLICATE_CCCD");
  }

  const isEligible =
    worker?.is_eligible === false ? false : derivedReasons.length === 0;
  const reasonLabels = derivedReasons.map(getWorkerIneligibleReasonLabel);

  if (!isEligible) {
    const joinedReasons =
      reasonLabels.length > 0
        ? reasonLabels.join("; ")
        : "Không đủ điều kiện nghiệp vụ";
    return {
      employmentStatus,
      activeOnProjectCount,
      hasDuplicateCccd,
      isEligible: false,
      statusLabel: "Không đủ điều kiện",
      tone: "danger",
      reasonCodes: derivedReasons,
      reasonLabels,
      blockingMessage: `Không thể ứng lương cho NLĐ này: ${joinedReasons}.`,
    };
  }

  return {
    employmentStatus,
    activeOnProjectCount,
    hasDuplicateCccd,
    isEligible: true,
    statusLabel: "Đủ điều kiện (ON)",
    tone: "success",
    reasonCodes: [],
    reasonLabels: [],
    blockingMessage: null,
  };
}

export function describeWorkerBankTransferEligibility(
  worker:
    | Pick<
        SalaryAdvanceWorkerOption,
        | "display_name"
        | "bank_transfer_eligible"
        | "bank_ineligible_reason"
        | "bank_account"
      >
    | null
    | undefined
): SalaryAdvanceWorkerBankTransferView {
  const bankAccount = worker?.bank_account;
  const institutionName =
    typeof bankAccount?.institution_name === "string" &&
    bankAccount.institution_name.trim().length > 0
      ? bankAccount.institution_name.trim()
      : null;
  const accountNumber =
    typeof bankAccount?.account_number === "string" &&
    bankAccount.account_number.trim().length > 0
      ? bankAccount.account_number.trim()
      : null;
  const accountNumberMasked =
    typeof bankAccount?.account_number_masked === "string" &&
    bankAccount.account_number_masked.trim().length > 0
      ? bankAccount.account_number_masked.trim()
      : accountNumber;
  const accountHolderName =
    typeof bankAccount?.account_holder_name === "string" &&
    bankAccount.account_holder_name.trim().length > 0
      ? bankAccount.account_holder_name.trim()
      : null;
  const bankId =
    typeof bankAccount?.bank_id === "string" &&
    bankAccount.bank_id.trim().length > 0
      ? bankAccount.bank_id.trim()
      : null;

  const hasBankAccount = Boolean(
    bankAccount?.has_bank_account ??
      (institutionName && accountNumber && accountHolderName)
  );
  const nameMatches = Boolean(
    hasBankAccount &&
      worker?.display_name &&
      accountHolderName &&
      isSelfOwnedBankAccountNameMatch(worker.display_name, accountHolderName)
  );
  const isSelfOwned =
    typeof bankAccount?.is_self_owned === "boolean"
      ? bankAccount.is_self_owned && nameMatches
      : nameMatches;

  const canUseBankTransfer =
    typeof worker?.bank_transfer_eligible === "boolean"
      ? worker.bank_transfer_eligible && hasBankAccount && isSelfOwned
      : hasBankAccount && isSelfOwned;

  if (canUseBankTransfer) {
    return {
      canUseBankTransfer: true,
      hasBankAccount: true,
      isSelfOwned: true,
      statusLabel: "Tài khoản chính chủ hợp lệ",
      tone: "success",
      reasonCode: null,
      blockingMessage: null,
      bankId,
      institutionName,
      accountNumber,
      accountNumberMasked,
      accountHolderName,
    };
  }

  const reasonCode: SalaryAdvanceBankIneligibleReason =
    worker?.bank_ineligible_reason === "BANK_ACCOUNT_NOT_SELF_OWNED" ||
    (hasBankAccount && !isSelfOwned)
      ? "BANK_ACCOUNT_NOT_SELF_OWNED"
      : "BANK_ACCOUNT_MISSING";

  return {
    canUseBankTransfer: false,
    hasBankAccount,
    isSelfOwned: false,
    statusLabel:
      reasonCode === "BANK_ACCOUNT_NOT_SELF_OWNED"
        ? "Tài khoản không chính chủ"
        : "Thiếu tài khoản ngân hàng",
    tone: "danger",
    reasonCode,
    blockingMessage: `${getBankIneligibleReasonLabel(reasonCode)}.`,
    bankId,
    institutionName,
    accountNumber,
    accountNumberMasked,
    accountHolderName,
  };
}

export function getRequestStateMeta(
  state: SalaryAdvanceRequestState
): SalaryAdvanceRequestStateMeta {
  return (
    REQUEST_STATE_META[state] ?? {
      state,
      label: state,
      shortLabel: state,
      tone: "neutral",
      isTerminal: false,
    }
  );
}

export function getEvidenceReviewStateMeta(
  state: SalaryAdvanceEvidenceReviewState
): SalaryAdvanceEvidenceReviewStateMeta {
  return (
    EVIDENCE_REVIEW_STATE_META[state] ?? {
      state,
      label: state,
      shortLabel: state,
      tone: "neutral",
    }
  );
}

export function getSalaryAdvanceEventTypeLabel(
  eventType: SalaryAdvanceEventType,
  evidenceKind?: SalaryAdvanceEvidenceKind | null
): string {
  if (evidenceKind === "BANK_TRANSFER_RECEIPT") {
    if (eventType === "EVIDENCE_UPLOADED") {
      return "Tải lên chứng từ chuyển khoản";
    }
    if (eventType === "EVIDENCE_REVIEWED") {
      return "Xác nhận đã đối chiếu chứng từ chuyển khoản";
    }
    if (eventType === "EVIDENCE_RETAKE_REQUESTED") {
      return "Yêu cầu gửi lại chứng từ chuyển khoản";
    }
  }
  return EVENT_TYPE_LABELS[eventType] ?? eventType;
}

export function getSalaryAdvanceEventTone(
  eventType: SalaryAdvanceEventType
): SalaryAdvanceBadgeTone {
  switch (eventType) {
    case "REQUEST_APPROVED":
    case "EVIDENCE_REVIEWED":
      return "success";
    case "REQUEST_REJECTED":
    case "EVIDENCE_RETAKE_REQUESTED":
      return "danger";
    case "INFO_REQUESTED":
    case "EVIDENCE_UPLOADED":
      return "warning";
    case "INFO_PROVIDED":
    case "MESSAGE_POSTED":
      return "info";
    case "HANDLED_EXTERNALLY_MARKED":
      return "primary";
    case "REQUEST_CREATED":
    case "REQUEST_WITHDRAWN":
    default:
      return "neutral";
  }
}

export function getSalaryAdvanceActorRoleLabel(
  role: SalaryAdvanceActorRole
): string {
  return ACTOR_ROLE_LABELS[role] ?? role;
}

export function resolveAvailableRequestActions(
  allowedActions: SalaryAdvanceAllowedActions | null | undefined
): SalaryAdvanceAvailableActionsView {
  const safe: SalaryAdvanceAllowedActions = allowedActions ?? {
    can_post_message: false,
    can_provide_info: false,
    can_withdraw: false,
    can_upload_evidence: false,
    can_request_info: false,
    can_approve: false,
    can_reject: false,
    can_mark_handled_externally: false,
    can_review_evidence: false,
  };

  const canPostMessage = Boolean(safe.can_post_message);
  const canProvideInfo = Boolean(safe.can_provide_info);
  const canWithdraw = Boolean(safe.can_withdraw);
  const canUploadEvidence = Boolean(safe.can_upload_evidence);
  const canRequestInfo = Boolean(safe.can_request_info);
  const canApprove = Boolean(safe.can_approve);
  const canReject = Boolean(safe.can_reject);
  const canMarkHandledExternally = Boolean(safe.can_mark_handled_externally);
  const canReviewEvidence = Boolean(safe.can_review_evidence);

  const hasAnyPmMutation =
    canProvideInfo || canWithdraw || canUploadEvidence || canPostMessage;
  const hasAnyAccountantDecision =
    canRequestInfo ||
    canApprove ||
    canReject ||
    canMarkHandledExternally ||
    canReviewEvidence;
  const hasAnyMutation = hasAnyPmMutation || hasAnyAccountantDecision;

  return {
    canPostMessage,
    canProvideInfo,
    canWithdraw,
    canUploadEvidence,
    canRequestInfo,
    canApprove,
    canReject,
    canMarkHandledExternally,
    canReviewEvidence,
    hasAnyPmMutation,
    hasAnyAccountantDecision,
    hasAnyMutation,
  };
}

export function evaluateRequestAttentionForTab(
  request: Pick<
    SalaryAdvanceRequestSummary,
    "request_state" | "evidence_review_state" | "allowed_actions"
  >,
  tabId: SalaryAdvanceWorkspaceTabId
): SalaryAdvanceAttentionIndicator {
  if (tabId === "pm") {
    if (
      request.request_state === "NEEDS_INFO" &&
      request.allowed_actions.can_provide_info
    ) {
      return {
        needsAttention: true,
        label: "Cần bổ sung thông tin",
        tone: "info",
      };
    }
    if (
      request.evidence_review_state === "RETAKE_REQUIRED" &&
      request.allowed_actions.can_upload_evidence
    ) {
      return {
        needsAttention: true,
        label: "Cần gửi lại ảnh nhận tiền",
        tone: "danger",
      };
    }
    if (
      request.request_state === "APPROVED" &&
      request.evidence_review_state === "NOT_UPLOADED" &&
      request.allowed_actions.can_upload_evidence
    ) {
      return {
        needsAttention: true,
        label: "Chờ tải ảnh nhận tiền",
        tone: "warning",
      };
    }
    return { needsAttention: false, label: null, tone: "neutral" };
  }

  if (tabId === "accountant") {
    if (
      request.request_state === "OPEN" &&
      (request.allowed_actions.can_approve ||
        request.allowed_actions.can_reject ||
        request.allowed_actions.can_request_info ||
        request.allowed_actions.can_mark_handled_externally)
    ) {
      return {
        needsAttention: true,
        label: "Chờ Kế toán ra quyết định",
        tone: "warning",
      };
    }
    if (
      request.evidence_review_state === "PENDING_REVIEW" &&
      request.allowed_actions.can_review_evidence
    ) {
      return {
        needsAttention: true,
        label: "Chờ đối chiếu ảnh nhận tiền",
        tone: "warning",
      };
    }
    return { needsAttention: false, label: null, tone: "neutral" };
  }

  if (request.evidence_review_state === "PENDING_REVIEW") {
    return {
      needsAttention: true,
      label: "Đang chờ đối chiếu ảnh",
      tone: "warning",
    };
  }
  if (request.request_state === "OPEN" || request.request_state === "NEEDS_INFO") {
    return {
      needsAttention: true,
      label: "Đang xử lý",
      tone: "info",
    };
  }
  return { needsAttention: false, label: null, tone: "neutral" };
}

export function isRequestOpenInStateMachine(
  request: Pick<SalaryAdvanceRequestSummary, "request_state">
): boolean {
  return !getRequestStateMeta(request.request_state).isTerminal;
}

export function countOpenRequestsForPmTab(
  requests: ReadonlyArray<Pick<SalaryAdvanceRequestSummary, "request_state">>
): number {
  let count = 0;
  for (const item of requests) {
    if (isRequestOpenInStateMachine(item)) {
      count += 1;
    }
  }
  return count;
}

export function countActionableRequestsForTab(
  requests: ReadonlyArray<
    Pick<
      SalaryAdvanceRequestSummary,
      "request_state" | "evidence_review_state" | "allowed_actions"
    >
  >,
  tabId: SalaryAdvanceWorkspaceTabId
): number {
  if (tabId === "pm") {
    return countOpenRequestsForPmTab(requests);
  }
  let count = 0;
  for (const item of requests) {
    if (evaluateRequestAttentionForTab(item, tabId).needsAttention) {
      count += 1;
    }
  }
  return count;
}

export type UpdateTabBadgeCountOptions = {
  serverBadgeCount?: number | null;
  isUnfiltered?: boolean;
  hasMore?: boolean;
};

export function updateTabBadgeCountsForTab(
  currentCounts: Partial<Record<SalaryAdvanceWorkspaceTabId, number>>,
  tabId: SalaryAdvanceWorkspaceTabId,
  requests: ReadonlyArray<
    Pick<
      SalaryAdvanceRequestSummary,
      "request_state" | "evidence_review_state" | "allowed_actions"
    >
  >,
  options?: UpdateTabBadgeCountOptions
): Partial<Record<SalaryAdvanceWorkspaceTabId, number>> {
  let nextCount: number;
  if (
    typeof options?.serverBadgeCount === "number" &&
    Number.isFinite(options.serverBadgeCount) &&
    options.serverBadgeCount >= 0
  ) {
    nextCount = Math.trunc(options.serverBadgeCount);
  } else if (options?.isUnfiltered === false || options?.hasMore === true) {
    return currentCounts;
  } else {
    nextCount = countActionableRequestsForTab(requests, tabId);
  }

  if (currentCounts[tabId] === nextCount) {
    return currentCounts;
  }
  return {
    ...currentCounts,
    [tabId]: nextCount,
  };
}

const UUID_DISPLAY_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SalaryAdvanceActorNameSource = {
  recruiterDisplayName?: string | null;
  verifiedCurrentRecruiterLink?: boolean;
  displayName?: string | null;
  loginId?: string | null;
};

function sanitizeNonUuidActorLabel(
  candidate: string | null | undefined
): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed || UUID_DISPLAY_NAME_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function sanitizeLoginIdCandidate(
  candidate: string | null | undefined
): string | null {
  const sanitized = sanitizeNonUuidActorLabel(candidate);
  if (!sanitized) return null;
  const localPart = sanitized.includes("@")
    ? sanitized.split("@")[0].trim().toLowerCase()
    : sanitized;
  if (!localPart || UUID_DISPLAY_NAME_PATTERN.test(localPart)) {
    return null;
  }
  return localPart;
}

export function resolveSalaryAdvanceActorDisplayName(
  input: string | SalaryAdvanceActorNameSource | null | undefined,
  fallbackLabel = "Chưa cập nhật tên"
): string {
  const safeFallback =
    sanitizeNonUuidActorLabel(fallbackLabel) ?? "Chưa cập nhật tên";

  if (typeof input === "string" || input === null || input === undefined) {
    return sanitizeNonUuidActorLabel(input) ?? safeFallback;
  }

  if (input.verifiedCurrentRecruiterLink !== false) {
    const linkedRecruiterName = sanitizeNonUuidActorLabel(
      input.recruiterDisplayName
    );
    if (linkedRecruiterName) {
      return linkedRecruiterName;
    }
  }

  const accountDisplayName = sanitizeNonUuidActorLabel(input.displayName);
  if (accountDisplayName) {
    return accountDisplayName;
  }

  const loginId = sanitizeLoginIdCandidate(input.loginId);
  if (loginId) {
    return loginId;
  }

  return safeFallback;
}

export function buildWorkerPortraitPreviewUrl(
  requestId: string,
  expectedDocumentId: string
): string {
  return `/api/salary-advance/requests/${encodeURIComponent(
    requestId
  )}/worker-portrait?expected_document_id=${encodeURIComponent(
    expectedDocumentId
  )}`;
}

export function buildEvidencePhotoPreviewUrl(
  requestId: string,
  evidenceVersion: number
): string {
  return `/api/salary-advance/requests/${encodeURIComponent(
    requestId
  )}/evidence/${encodeURIComponent(String(evidenceVersion))}/preview`;
}

export function evaluateEvidenceComparisonPanel(
  detail: SalaryAdvanceRequestDetail,
  selectedEvidenceVersion?: number | null
): SalaryAdvanceComparisonPanelModel {
  const { request, evidence_versions } = detail;
  const paymentMethod: SalaryAdvancePaymentMethod =
    request.payment_method === "BANK_TRANSFER" ? "BANK_TRANSFER" : "CASH";
  const evidenceKind: SalaryAdvanceEvidenceKind =
    paymentMethod === "BANK_TRANSFER"
      ? "BANK_TRANSFER_RECEIPT"
      : "CASH_HANDOVER_PHOTO";
  const requiresWorkerPortraitComparison = paymentMethod === "CASH";
  const workerPortrait = request.worker_portrait;
  const hasWorkerPortrait = workerPortrait !== null;

  const sortedVersions = [...evidence_versions].sort(
    (a, b) => b.evidence_version - a.evidence_version
  );

  const currentVersionNumber =
    request.current_evidence?.evidence_version ??
    sortedVersions[0]?.evidence_version ??
    null;

  let resolvedVersionItem: SalaryAdvanceEvidenceVersionItem | null = null;
  if (
    typeof selectedEvidenceVersion === "number" &&
    Number.isInteger(selectedEvidenceVersion)
  ) {
    resolvedVersionItem =
      sortedVersions.find(
        (item) => item.evidence_version === selectedEvidenceVersion
      ) ?? null;
  }

  if (!resolvedVersionItem) {
    if (sortedVersions.length > 0) {
      resolvedVersionItem = sortedVersions[0];
    } else if (request.current_evidence) {
      resolvedVersionItem = {
        evidence_version: request.current_evidence.evidence_version,
        evidence_kind:
          request.current_evidence.evidence_kind ?? evidenceKind,
        event_id: `ev-${request.current_evidence.evidence_version}`,
        mime_type: request.current_evidence.mime_type,
        size_bytes: request.current_evidence.size_bytes,
        checksum_sha256: request.current_evidence.checksum_sha256,
        caption_note: null,
        uploaded_by_user_id: request.current_evidence.uploaded_by_user_id,
        uploaded_by_display_name:
          request.current_evidence.uploaded_by_display_name,
        uploaded_at: request.current_evidence.uploaded_at,
      };
    }
  }

  const isViewingCurrentEvidence = Boolean(
    resolvedVersionItem !== null &&
      currentVersionNumber !== null &&
      resolvedVersionItem.evidence_version === currentVersionNumber
  );

  const canUploadEvidence = Boolean(request.allowed_actions.can_upload_evidence);
  const canReviewEvidence = Boolean(request.allowed_actions.can_review_evidence);

  const canConfirmReviewed = Boolean(
    canReviewEvidence &&
      (requiresWorkerPortraitComparison ? hasWorkerPortrait : true) &&
      resolvedVersionItem !== null &&
      isViewingCurrentEvidence
  );

  const canRequestRetake = Boolean(
    canReviewEvidence &&
      resolvedVersionItem !== null &&
      isViewingCurrentEvidence
  );

  let confirmReviewedLockReason: string | null = null;
  if (canReviewEvidence) {
    if (!resolvedVersionItem) {
      confirmReviewedLockReason = requiresWorkerPortraitComparison
        ? "Chưa có ảnh NLĐ nhận tiền mặt để xác nhận đối chiếu."
        : "Chưa có chứng từ chuyển khoản để xác nhận đối chiếu.";
    } else if (!isViewingCurrentEvidence) {
      confirmReviewedLockReason = requiresWorkerPortraitComparison
        ? "Bạn đang xem phiên bản ảnh lịch sử. Chỉ có thể đối chiếu trên phiên bản ảnh hiện hành mới nhất."
        : "Bạn đang xem phiên bản chứng từ lịch sử. Chỉ có thể đối chiếu trên phiên bản chứng từ hiện hành mới nhất.";
    } else if (requiresWorkerPortraitComparison && !hasWorkerPortrait) {
      confirmReviewedLockReason =
        "Không thể xác nhận «Đã đối chiếu» vì người lao động chưa có ảnh hồ sơ chuẩn trong hệ thống. Bạn vẫn có thể yêu cầu gửi lại ảnh hoặc giữ nguyên yêu cầu chờ cập nhật hồ sơ.";
    }
  }

  const currentEvMeta = request.current_evidence;

  return {
    requestId: request.request_id,
    paymentMethod,
    evidenceKind,
    requiresWorkerPortraitComparison,
    paymentDestinationSnapshot: request.payment_destination_snapshot ?? null,
    workerEntryId: request.worker_entry_id,
    workerEmployeeCode: request.worker_employee_code,
    workerDisplayName: request.worker_display_name,
    hasWorkerPortrait,
    workerPortrait: workerPortrait
      ? {
          documentId: workerPortrait.document_id,
          version: workerPortrait.version,
          mimeType: workerPortrait.mime_type,
          sizeBytes: workerPortrait.size_bytes,
          previewUrl: buildWorkerPortraitPreviewUrl(
            request.request_id,
            workerPortrait.document_id
          ),
          sourceLabel: "Ảnh chân dung hồ sơ NLĐ trong hệ thống",
        }
      : null,
    missingPortraitWarning:
      !requiresWorkerPortraitComparison || hasWorkerPortrait
        ? null
        : SALARY_ADVANCE_MISSING_PORTRAIT_WARNING,
    hasEvidencePhoto: resolvedVersionItem !== null,
    selectedEvidence: resolvedVersionItem
      ? {
          eventId: resolvedVersionItem.event_id,
          evidenceVersion: resolvedVersionItem.evidence_version,
          evidenceKind: resolvedVersionItem.evidence_kind ?? evidenceKind,
          mimeType: resolvedVersionItem.mime_type,
          sizeBytes: resolvedVersionItem.size_bytes,
          captionNote: resolvedVersionItem.caption_note,
          uploadedByUserId: resolvedVersionItem.uploaded_by_user_id,
          uploadedByDisplayName: resolveSalaryAdvanceActorDisplayName(
            resolvedVersionItem.uploaded_by_display_name
          ),
          uploadedAt: resolvedVersionItem.uploaded_at,
          reviewState: isViewingCurrentEvidence
            ? request.evidence_review_state
            : "RETAKE_REQUIRED",
          reviewedByUserId:
            isViewingCurrentEvidence && currentEvMeta
              ? currentEvMeta.reviewed_by_user_id
              : null,
          reviewedByDisplayName:
            isViewingCurrentEvidence &&
            currentEvMeta &&
            (currentEvMeta.reviewed_at !== null ||
              currentEvMeta.reviewed_by_user_id !== null ||
              currentEvMeta.reviewed_by_display_name !== null)
              ? resolveSalaryAdvanceActorDisplayName(
                  currentEvMeta.reviewed_by_display_name
                )
              : null,
          reviewedAt:
            isViewingCurrentEvidence && currentEvMeta
              ? currentEvMeta.reviewed_at
              : null,
          reviewNote:
            isViewingCurrentEvidence && currentEvMeta
              ? currentEvMeta.review_note
              : null,
          workerPortraitDocumentId:
            isViewingCurrentEvidence && currentEvMeta
              ? currentEvMeta.reviewed_worker_portrait_document_id
              : null,
          workerPortraitVersion:
            isViewingCurrentEvidence && currentEvMeta
              ? currentEvMeta.reviewed_worker_portrait_version
              : null,
          isCurrent: isViewingCurrentEvidence,
          previewUrl: buildEvidencePhotoPreviewUrl(
            request.request_id,
            resolvedVersionItem.evidence_version
          ),
          sourceLabel:
            (resolvedVersionItem.evidence_kind ?? evidenceKind) ===
            "BANK_TRANSFER_RECEIPT"
              ? "Chứng từ chuyển khoản (bill) đã tải lên"
              : "Ảnh NLĐ nhận tiền mặt do QLDA tải lên",
        }
      : null,
    evidenceVersions: sortedVersions.map((item) => {
      const isCurrent =
        currentVersionNumber !== null &&
        item.evidence_version === currentVersionNumber;
      return {
        evidenceVersion: item.evidence_version,
        evidenceKind: item.evidence_kind ?? evidenceKind,
        isCurrent,
        reviewState: isCurrent
          ? request.evidence_review_state
          : "RETAKE_REQUIRED",
        uploadedAt: item.uploaded_at,
        uploadedByDisplayName: resolveSalaryAdvanceActorDisplayName(
          item.uploaded_by_display_name
        ),
      };
    }),
    canUploadEvidence,
    canReviewEvidence,
    canConfirmReviewed,
    canRequestRetake,
    confirmReviewedLockReason,
  };
}

export type LatestRequestTicket = {
  readonly seq: number;
  readonly signal: AbortSignal;
  isCurrent: () => boolean;
};

export type LatestRequestTracker = {
  begin: () => LatestRequestTicket;
  cancelAll: () => void;
  isCurrent: (seq: number) => boolean;
  getCurrentSeq: () => number;
};

export function createLatestRequestTracker(): LatestRequestTracker {
  let currentSeq = 0;
  let activeController: AbortController | null = null;

  return {
    begin(): LatestRequestTicket {
      if (activeController && !activeController.signal.aborted) {
        activeController.abort();
      }
      currentSeq += 1;
      const seq = currentSeq;
      const controller = new AbortController();
      activeController = controller;

      return {
        seq,
        signal: controller.signal,
        isCurrent: () =>
          seq === currentSeq &&
          activeController === controller &&
          !controller.signal.aborted,
      };
    },
    cancelAll(): void {
      currentSeq += 1;
      if (activeController && !activeController.signal.aborted) {
        activeController.abort();
      }
      activeController = null;
    },
    isCurrent(seq: number): boolean {
      return Boolean(
        seq === currentSeq &&
          activeController !== null &&
          !activeController.signal.aborted
      );
    },
    getCurrentSeq(): number {
      return currentSeq;
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isValidRequestSummaryItem(
  value: unknown
): value is SalaryAdvanceRequestSummary {
  if (!isPlainRecord(value)) return false;
  if (typeof value.request_id !== "string" || !value.request_id.trim()) {
    return false;
  }
  if (typeof value.project_id !== "string" || !value.project_id.trim()) {
    return false;
  }
  if (
    typeof value.worker_entry_id !== "string" ||
    !value.worker_entry_id.trim()
  ) {
    return false;
  }
  if (typeof value.request_state !== "string" || !value.request_state.trim()) {
    return false;
  }
  if (
    typeof value.evidence_review_state !== "string" ||
    !value.evidence_review_state.trim()
  ) {
    return false;
  }
  if (!isPlainRecord(value.allowed_actions)) {
    return false;
  }
  return true;
}

export function parseSalaryAdvanceRequestListPayload(raw: unknown):
  | {
      ok: true;
      data: SalaryAdvanceRequestListResponse;
    }
  | {
      ok: false;
      code: string;
      message: string;
    } {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_PAYLOAD_INVALID"),
    };
  }

  if (!Array.isArray(raw.requests)) {
    return {
      ok: false,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_PAYLOAD_INVALID"),
    };
  }

  for (const item of raw.requests) {
    if (!isValidRequestSummaryItem(item)) {
      return {
        ok: false,
        code: "SALARY_ADVANCE_PAYLOAD_INVALID",
        message: salaryAdvanceErrorMessage("SALARY_ADVANCE_PAYLOAD_INVALID"),
      };
    }
  }

  if (typeof raw.has_more !== "boolean") {
    return {
      ok: false,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_PAYLOAD_INVALID"),
    };
  }

  if (
    raw.next_cursor !== null &&
    raw.next_cursor !== undefined &&
    typeof raw.next_cursor !== "string"
  ) {
    return {
      ok: false,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_PAYLOAD_INVALID"),
    };
  }

  if (
    raw.badge_count !== undefined &&
    raw.badge_count !== null &&
    (typeof raw.badge_count !== "number" ||
      !Number.isFinite(raw.badge_count) ||
      raw.badge_count < 0)
  ) {
    return {
      ok: false,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_PAYLOAD_INVALID"),
    };
  }

  if (
    raw.badge_count_capped !== undefined &&
    raw.badge_count_capped !== null &&
    typeof raw.badge_count_capped !== "boolean"
  ) {
    return {
      ok: false,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_PAYLOAD_INVALID"),
    };
  }

  const parsedData: SalaryAdvanceRequestListResponse = {
    requests: raw.requests,
    has_more: raw.has_more,
    next_cursor: typeof raw.next_cursor === "string" ? raw.next_cursor : null,
  };
  if (typeof raw.badge_count === "number") {
    parsedData.badge_count = Math.trunc(raw.badge_count);
  }
  if (typeof raw.badge_count_capped === "boolean") {
    parsedData.badge_count_capped = raw.badge_count_capped;
  }

  return {
    ok: true,
    data: parsedData,
  };
}

export type SalaryAdvanceRequestListFetchOutcome =
  | {
      status: "success";
      data: SalaryAdvanceRequestListResponse;
      isEmpty: boolean;
    }
  | {
      status: "error";
      code: string;
      message: string;
    }
  | {
      status: "stale";
    };

export async function fetchSalaryAdvanceRequestListPage(params: {
  queue: Extract<SalaryAdvanceQueue, "PM" | "ACCOUNTANT" | "SUPERVISORY">;
  projectFilter: string;
  requestStateFilter: "ALL" | SalaryAdvanceRequestState;
  evidenceStateFilter: "ALL" | SalaryAdvanceEvidenceReviewState;
  appliedSearch: string;
  cursor?: string | null;
  append?: boolean;
  includeBadge?: boolean;
  pageSize?: number;
  ticket: LatestRequestTicket;
  fetchImpl?: typeof fetch;
}): Promise<SalaryAdvanceRequestListFetchOutcome> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const queryParams = new URLSearchParams();
  queryParams.set("queue", params.queue);
  queryParams.set("page_size", String(params.pageSize ?? 25));

  if (params.projectFilter !== "ALL") {
    queryParams.set("project_id", params.projectFilter);
  }
  if (params.requestStateFilter !== "ALL") {
    queryParams.set("request_state", params.requestStateFilter);
  }
  if (params.evidenceStateFilter !== "ALL") {
    queryParams.set("evidence_review_state", params.evidenceStateFilter);
  }
  if (params.appliedSearch.trim().length > 0) {
    queryParams.set("search", params.appliedSearch.trim());
  }
  if (params.append && params.cursor) {
    queryParams.set("cursor", params.cursor);
  }
  if (params.includeBadge) {
    queryParams.set("include_badge", "1");
  }

  try {
    const response = await fetchFn(
      `/api/salary-advance/requests?${queryParams.toString()}`,
      {
        method: "GET",
        cache: "no-store",
        signal: params.ticket.signal,
      }
    );

    const json = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          data?: unknown;
          code?: string;
        }
      | null;

    if (!params.ticket.isCurrent()) {
      return { status: "stale" };
    }

    if (!response.ok || !json?.ok || json.data === undefined || json.data === null) {
      const code = json?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
      return {
        status: "error",
        code,
        message: salaryAdvanceErrorMessage(code),
      };
    }

    const parsed = parseSalaryAdvanceRequestListPayload(json.data);
    if (!parsed.ok) {
      return {
        status: "error",
        code: parsed.code,
        message: parsed.message,
      };
    }

    return {
      status: "success",
      data: parsed.data,
      isEmpty: parsed.data.requests.length === 0,
    };
  } catch {
    if (!params.ticket.isCurrent()) {
      return { status: "stale" };
    }
    return {
      status: "error",
      code: "SALARY_ADVANCE_UNAVAILABLE",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_UNAVAILABLE"),
    };
  }
}

export function buildSalaryAdvanceExportUrl(params: {
  projectFilter: string;
  requestStateFilter: "ALL" | SalaryAdvanceRequestState;
  evidenceStateFilter: "ALL" | SalaryAdvanceEvidenceReviewState;
  appliedSearch: string;
}): string {
  const queryParams = new URLSearchParams();
  if (params.projectFilter !== "ALL") {
    queryParams.set("project_id", params.projectFilter);
  }
  if (params.requestStateFilter !== "ALL") {
    queryParams.set("request_state", params.requestStateFilter);
  }
  if (params.evidenceStateFilter !== "ALL") {
    queryParams.set("evidence_review_state", params.evidenceStateFilter);
  }
  if (params.appliedSearch.trim().length > 0) {
    queryParams.set("search", params.appliedSearch.trim());
  }
  const qs = queryParams.toString();
  return qs.length > 0
    ? `/api/salary-advance/requests/export?${qs}`
    : "/api/salary-advance/requests/export";
}

export function isProjectWorkerHiddenFromPicker(
  worker:
    | Pick<
        SalaryAdvanceWorkerOption,
        "employment_status" | "ineligible_reasons"
      >
    | null
    | undefined
): boolean {
  if (!worker) return true;
  if (worker.employment_status === "OFF") {
    return true;
  }
  if (
    Array.isArray(worker.ineligible_reasons) &&
    worker.ineligible_reasons.includes("WORKER_STATUS_OFF")
  ) {
    return true;
  }
  return false;
}

export function filterSelectableProjectWorkers<
  T extends Pick<
    SalaryAdvanceWorkerOption,
    "employment_status" | "ineligible_reasons"
  >,
>(workers: ReadonlyArray<T>): T[] {
  return workers.filter((worker) => !isProjectWorkerHiddenFromPicker(worker));
}

export function reconcileSelectedWorkerEntryId(
  currentWorkerEntryId: string,
  workers: ReadonlyArray<
    Pick<
      SalaryAdvanceWorkerOption,
      "worker_entry_id" | "is_eligible" | "ineligible_reasons" | "employment_status" | "active_on_project_count" | "has_duplicate_cccd"
    >
  >
): string {
  const trimmed = currentWorkerEntryId.trim();
  if (!trimmed || workers.length === 0) {
    return "";
  }
  const match = workers.find((worker) => worker.worker_entry_id === trimmed);
  if (!match || isProjectWorkerHiddenFromPicker(match)) {
    return "";
  }
  return describeWorkerEligibility(match).isEligible ? trimmed : "";
}

export function reconcileSelectedRequestIdFromList(
  currentSelectedRequestId: string | null,
  requests: ReadonlyArray<Pick<SalaryAdvanceRequestSummary, "request_id">>
): string | null {
  if (requests.length === 0) {
    return null;
  }
  if (
    currentSelectedRequestId &&
    requests.some((item) => item.request_id === currentSelectedRequestId)
  ) {
    return currentSelectedRequestId;
  }
  return requests[0].request_id;
}

export function resolveActiveRequestDetail(
  detail: SalaryAdvanceRequestDetail | null,
  selectedRequestId: string | null
): SalaryAdvanceRequestDetail | null {
  if (!detail || !selectedRequestId) {
    return null;
  }
  return detail.request.request_id === selectedRequestId ? detail : null;
}

export type ScopedMutationUiOutcome = {
  shouldUpdateSelectedRequestUi: boolean;
  conflictBannerMessage: string | null;
  errorMessage: string | null;
  shouldReloadSelectedDetail: boolean;
  shouldReloadRequestList: boolean;
};

export function resolveScopedMutationFailureOutcome(params: {
  targetRequestId: string;
  currentSelectedRequestId: string | null;
  status: number;
  code: string | null | undefined;
  fallbackMessage?: string;
}): ScopedMutationUiOutcome {
  const isSelected =
    Boolean(params.currentSelectedRequestId) &&
    params.currentSelectedRequestId === params.targetRequestId;
  const isConflict = isSalaryAdvanceConflictError(params.status, params.code);
  const resolvedMessage =
    params.fallbackMessage ??
    salaryAdvanceErrorMessage(params.code ?? "SALARY_ADVANCE_UNAVAILABLE");

  if (!isSelected) {
    return {
      shouldUpdateSelectedRequestUi: false,
      conflictBannerMessage: null,
      errorMessage: null,
      shouldReloadSelectedDetail: false,
      shouldReloadRequestList: isConflict,
    };
  }

  if (isConflict) {
    return {
      shouldUpdateSelectedRequestUi: true,
      conflictBannerMessage: salaryAdvanceErrorMessage(
        params.code ?? "SALARY_ADVANCE_VERSION_CONFLICT"
      ),
      errorMessage: null,
      shouldReloadSelectedDetail: true,
      shouldReloadRequestList: true,
    };
  }

  return {
    shouldUpdateSelectedRequestUi: true,
    conflictBannerMessage: null,
    errorMessage: resolvedMessage,
    shouldReloadSelectedDetail: false,
    shouldReloadRequestList: false,
  };
}

export function sortEventsChronologically(
  events: ReadonlyArray<SalaryAdvanceEventItem>
): SalaryAdvanceEventItem[] {
  return [...events].sort((a, b) => a.event_seq - b.event_seq);
}

export function formatVndAmount(
  amountVnd: number | string | null | undefined
): string {
  if (amountVnd === null || amountVnd === undefined) {
    return "0 ₫";
  }
  const numeric =
    typeof amountVnd === "string" ? Number(amountVnd.trim()) : amountVnd;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) {
    return "0 ₫";
  }
  return `${Math.trunc(numeric).toLocaleString("vi-VN")} ₫`;
}

export function formatFileSizeBytes(
  sizeBytes: number | null | undefined
): string {
  if (
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0
  ) {
    return "0 B";
  }
  if (sizeBytes < 1024) {
    return `${Math.trunc(sizeBytes)} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDateTimeVi(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizePositiveVndInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[0-9.,\s_]+$/.test(trimmed)) return null;
  const digitsOnly = trimmed.replace(/[.,\s_]/g, "");
  if (!/^[1-9][0-9]*$/.test(digitsOnly)) return null;
  const parsed = Number(digitsOnly);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function validateCreateSalaryAdvanceDraft(
  draft: CreateSalaryAdvanceDraftInput
): CreateSalaryAdvanceValidationResult {
  const fieldErrors: Partial<
    Record<
      | "projectId"
      | "workerEntryId"
      | "requestedAmountRaw"
      | "paymentMethod"
      | "initialContent",
      string
    >
  > = {};

  const projectId = draft.projectId.trim();
  if (!projectId) {
    fieldErrors.projectId = "Vui lòng chọn dự án.";
  } else if (draft.hasActiveAccountant === false) {
    fieldErrors.projectId =
      "Dự án này chưa được gán Kế toán dự án đang hoạt động. Vui lòng liên hệ Admin cấu hình trước khi tạo yêu cầu.";
  }

  const workerEntryId = draft.workerEntryId.trim();
  if (!workerEntryId) {
    fieldErrors.workerEntryId = "Vui lòng chọn người lao động thuộc dự án.";
  } else if (draft.selectedWorker) {
    const eligibility = describeWorkerEligibility(draft.selectedWorker);
    if (!eligibility.isEligible) {
      fieldErrors.workerEntryId =
        eligibility.blockingMessage ??
        "Người lao động không đủ điều kiện ứng lương.";
    }
  }

  let resolvedPaymentMethod: SalaryAdvancePaymentMethod = "CASH";
  if (draft.paymentMethod !== undefined) {
    const rawMethod =
      typeof draft.paymentMethod === "string"
        ? draft.paymentMethod.trim().toUpperCase()
        : "";
    if (
      !SALARY_ADVANCE_PAYMENT_METHODS.includes(
        rawMethod as SalaryAdvancePaymentMethod
      )
    ) {
      fieldErrors.paymentMethod =
        "Vui lòng chọn phương thức nhận tiền (Tiền mặt hoặc Chuyển khoản).";
    } else {
      resolvedPaymentMethod = rawMethod as SalaryAdvancePaymentMethod;
      if (
        resolvedPaymentMethod === "BANK_TRANSFER" &&
        draft.selectedWorker
      ) {
        const bankEligibility = describeWorkerBankTransferEligibility(
          draft.selectedWorker
        );
        if (!bankEligibility.canUseBankTransfer) {
          fieldErrors.paymentMethod =
            bankEligibility.blockingMessage ??
            "Người lao động chưa có tài khoản ngân hàng chính chủ hợp lệ để nhận chuyển khoản.";
        }
      }
    }
  }

  const amountVnd = normalizePositiveVndInput(draft.requestedAmountRaw);
  if (amountVnd === null) {
    fieldErrors.requestedAmountRaw =
      "Số tiền ứng phải là số nguyên dương (VNĐ).";
  }

  const initialContent = draft.initialContent.trim();
  if (!initialContent) {
    fieldErrors.initialContent = "Vui lòng nhập nội dung đề nghị ứng lương.";
  } else if (initialContent.length > 2000) {
    fieldErrors.initialContent =
      "Nội dung đề nghị ứng lương không được vượt quá 2.000 ký tự.";
  }

  const firstError =
    fieldErrors.projectId ??
    fieldErrors.workerEntryId ??
    fieldErrors.paymentMethod ??
    fieldErrors.requestedAmountRaw ??
    fieldErrors.initialContent;

  if (firstError || amountVnd === null) {
    return {
      ok: false,
      message: firstError ?? "Dữ liệu tạo yêu cầu ứng lương chưa hợp lệ.",
      fieldErrors,
    };
  }

  return {
    ok: true,
    payload: {
      project_id: projectId,
      worker_entry_id: workerEntryId,
      requested_amount_vnd: String(amountVnd),
      payment_method: resolvedPaymentMethod,
      initial_content: initialContent,
    },
  };
}

export function validateTransitionActionInput(params: {
  action: SalaryAdvanceTransitionAction;
  messageText: string;
}):
  | { ok: true; normalizedMessage: string | null }
  | { ok: false; message: string } {
  const trimmed = params.messageText.trim();

  if (params.action === "REQUEST_INFO" || params.action === "PROVIDE_INFO") {
    if (!trimmed) {
      return {
        ok: false,
        message:
          params.action === "REQUEST_INFO"
            ? "Vui lòng nhập nội dung câu hỏi/thông tin cần QLDA bổ sung."
            : "Vui lòng nhập nội dung phản hồi bổ sung thông tin.",
      };
    }
    if (trimmed.length > 2000) {
      return {
        ok: false,
        message: "Nội dung trao đổi không được vượt quá 2.000 ký tự.",
      };
    }
    return { ok: true, normalizedMessage: trimmed };
  }

  if (params.action === "REJECT") {
    if (!trimmed) {
      return {
        ok: false,
        message: "Vui lòng nhập lý do từ chối yêu cầu ứng lương.",
      };
    }
    if (trimmed.length > 1000) {
      return {
        ok: false,
        message: "Lý do từ chối không được vượt quá 1.000 ký tự.",
      };
    }
    return { ok: true, normalizedMessage: trimmed };
  }

  if (trimmed.length > 1000) {
    return {
      ok: false,
      message: "Ghi chú kèm theo không được vượt quá 1.000 ký tự.",
    };
  }

  return {
    ok: true,
    normalizedMessage: trimmed.length > 0 ? trimmed : null,
  };
}

export function validateMessageInput(messageText: string):
  | { ok: true; normalizedMessage: string }
  | { ok: false; message: string } {
  const trimmed = messageText.trim();
  if (!trimmed) {
    return { ok: false, message: "Vui lòng nhập nội dung tin nhắn." };
  }
  if (trimmed.length > 2000) {
    return {
      ok: false,
      message: "Nội dung tin nhắn không được vượt quá 2.000 ký tự.",
    };
  }
  return { ok: true, normalizedMessage: trimmed };
}

export function validateEvidenceReviewInput(params: {
  decision: SalaryAdvanceEvidenceReviewDecision;
  note: string;
  evidenceKind?: SalaryAdvanceEvidenceKind;
  workerPortrait: { documentId: string; version: number } | null;
}):
  | {
      ok: true;
      normalizedNote: string | null;
      evidenceKind: SalaryAdvanceEvidenceKind;
      expectedWorkerPortraitDocumentId: string | null;
      expectedWorkerPortraitVersion: number | null;
    }
  | { ok: false; message: string } {
  const trimmedNote = params.note.trim();
  if (trimmedNote.length > 1000) {
    return {
      ok: false,
      message: "Ghi chú đối chiếu chứng từ không được vượt quá 1.000 ký tự.",
    };
  }

  const evidenceKind: SalaryAdvanceEvidenceKind =
    params.evidenceKind === "BANK_TRANSFER_RECEIPT"
      ? "BANK_TRANSFER_RECEIPT"
      : "CASH_HANDOVER_PHOTO";

  if (evidenceKind === "BANK_TRANSFER_RECEIPT") {
    return {
      ok: true,
      normalizedNote: trimmedNote.length > 0 ? trimmedNote : null,
      evidenceKind: "BANK_TRANSFER_RECEIPT",
      expectedWorkerPortraitDocumentId: null,
      expectedWorkerPortraitVersion: null,
    };
  }

  if (params.decision === "REVIEWED") {
    if (!params.workerPortrait) {
      return {
        ok: false,
        message:
          "Không thể xác nhận «Đã đối chiếu» khi người lao động chưa có ảnh chân dung chuẩn trong hồ sơ.",
      };
    }
    return {
      ok: true,
      normalizedNote: trimmedNote.length > 0 ? trimmedNote : null,
      evidenceKind: "CASH_HANDOVER_PHOTO",
      expectedWorkerPortraitDocumentId: params.workerPortrait.documentId,
      expectedWorkerPortraitVersion: params.workerPortrait.version,
    };
  }

  return {
    ok: true,
    normalizedNote: trimmedNote.length > 0 ? trimmedNote : null,
    evidenceKind: "CASH_HANDOVER_PHOTO",
    expectedWorkerPortraitDocumentId: params.workerPortrait?.documentId ?? null,
    expectedWorkerPortraitVersion: params.workerPortrait?.version ?? null,
  };
}

export function validateEvidenceFilePreflight(file: {
  type: string;
  size: number;
  name?: string;
}):
  | { ok: true; mimeType: SalaryAdvanceEvidenceMimeType; sizeBytes: number }
  | { ok: false; message: string } {
  const normalizedMime = file.type.trim().toLowerCase();
  if (normalizedMime !== "image/jpeg" && normalizedMime !== "image/png") {
    return {
      ok: false,
      message:
        "Chỉ chấp nhận tệp ảnh định dạng JPEG (.jpg, .jpeg) hoặc PNG (.png).",
    };
  }

  if (
    !Number.isInteger(file.size) ||
    file.size <= 0 ||
    file.size > SALARY_ADVANCE_EVIDENCE_MAX_BYTES
  ) {
    return {
      ok: false,
      message: "Dung lượng ảnh phải lớn hơn 0 và tối đa 10 MB.",
    };
  }

  return {
    ok: true,
    mimeType: normalizedMime,
    sizeBytes: file.size,
  };
}

export async function computeBrowserSha256Hex(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function newSalaryAdvanceIdempotencyKey(prefix = "sa"): string {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || "sa";
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 12)}`;
  return `${safePrefix}-${randomPart}`;
}

export function isSalaryAdvanceConflictError(
  status: number,
  code: string | null | undefined
): boolean {
  if (status === 409) return true;
  if (!code) return false;
  return CONFLICT_ERROR_CODES.has(code);
}

export async function uploadSalaryAdvanceEvidence(params: {
  requestId: string;
  expectedVersion: number;
  file: Blob & { type: string; size: number; name?: string };
  captionNote?: string | null;
  reserveIdempotencyKey?: string;
  finalizeIdempotencyKey?: string;
  fetchImpl?: typeof fetch;
  computeSha256Hex?: (file: Blob) => Promise<string>;
}): Promise<
  | {
      ok: true;
      data: SalaryAdvanceMutationDetailResponse;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    }
> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const sha256Fn = params.computeSha256Hex ?? computeBrowserSha256Hex;

  const preflight = validateEvidenceFilePreflight(params.file);
  if (!preflight.ok) {
    return {
      ok: false,
      status: 400,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: preflight.message,
    };
  }

  const trimmedCaption = params.captionNote?.trim() ?? "";
  if (trimmedCaption.length > 1000) {
    return {
      ok: false,
      status: 400,
      code: "SALARY_ADVANCE_PAYLOAD_INVALID",
      message: "Ghi chú ảnh nhận tiền không được vượt quá 1.000 ký tự.",
    };
  }

  const checksumSha256 = await sha256Fn(params.file);
  const reserveKey =
    params.reserveIdempotencyKey ?? newSalaryAdvanceIdempotencyKey("sa-ev-res");
  const finalizeKey =
    params.finalizeIdempotencyKey ?? newSalaryAdvanceIdempotencyKey("sa-ev-fin");

  const reserveResponse = await fetchFn(
    `/api/salary-advance/requests/${encodeURIComponent(
      params.requestId
    )}/evidence/reserve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": reserveKey,
      },
      body: JSON.stringify({
        expected_version: params.expectedVersion,
        mime_type: preflight.mimeType,
        size_bytes: preflight.sizeBytes,
        checksum_sha256: checksumSha256,
        caption_note: trimmedCaption.length > 0 ? trimmedCaption : null,
        idempotency_key: reserveKey,
      }),
    }
  );

  const reserveJson = (await reserveResponse.json().catch(() => null)) as
    | {
        ok?: boolean;
        data?: SalaryAdvanceEvidenceReserveResponse;
        code?: string;
      }
    | null;

  if (!reserveResponse.ok || !reserveJson?.ok || !reserveJson.data) {
    const code = reserveJson?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
    return {
      ok: false,
      status: reserveResponse.status,
      code,
      message: salaryAdvanceErrorMessage(code),
    };
  }

  const reservation = reserveJson.data;
  const putHeaders: Record<string, string> = {
    ...(reservation.upload.headers ?? {}),
  };
  if (!putHeaders["Content-Type"] && !putHeaders["content-type"]) {
    putHeaders["Content-Type"] = preflight.mimeType;
  }

  const putResponse = await fetchFn(reservation.upload.url, {
    method: reservation.upload.method || "PUT",
    headers: putHeaders,
    body: params.file,
  });

  if (!putResponse.ok) {
    return {
      ok: false,
      status: putResponse.status || 502,
      code: "SALARY_ADVANCE_STORAGE_UNAVAILABLE",
      message: salaryAdvanceErrorMessage("SALARY_ADVANCE_STORAGE_UNAVAILABLE"),
    };
  }

  const finalizeResponse = await fetchFn(
    `/api/salary-advance/requests/${encodeURIComponent(
      params.requestId
    )}/evidence/${encodeURIComponent(reservation.upload_id)}/finalize`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": finalizeKey,
      },
      body: JSON.stringify({
        expected_version: reservation.expected_version,
        idempotency_key: finalizeKey,
      }),
    }
  );

  const finalizeJson = (await finalizeResponse.json().catch(() => null)) as
    | {
        ok?: boolean;
        data?: SalaryAdvanceMutationDetailResponse;
        code?: string;
      }
    | null;

  if (!finalizeResponse.ok || !finalizeJson?.ok || !finalizeJson.data) {
    const code = finalizeJson?.code ?? "SALARY_ADVANCE_UNAVAILABLE";
    return {
      ok: false,
      status: finalizeResponse.status,
      code,
      message: salaryAdvanceErrorMessage(code),
    };
  }

  return {
    ok: true,
    data: finalizeJson.data,
  };
}

export function salaryAdvanceErrorMessage(
  code: SalaryAdvanceErrorCode | string | null | undefined
): string {
  switch (code) {
    case "UNAUTHENTICATED":
    case "SALARY_ADVANCE_UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
    case "SALARY_ADVANCE_ACCOUNT_UNAVAILABLE":
      return "Tài khoản của bạn hiện chưa sẵn sàng để sử dụng phân hệ Ứng lương.";
    case "SALARY_ADVANCE_ACCESS_DENIED":
      return "Bạn không có quyền thực hiện thao tác này hoặc không được phân công vào dự án tương ứng.";
    case "SALARY_ADVANCE_PROJECT_NOT_FOUND":
    case "SALARY_ADVANCE_WORKER_NOT_FOUND":
    case "SALARY_ADVANCE_REQUEST_NOT_FOUND":
    case "SALARY_ADVANCE_EVIDENCE_NOT_FOUND":
    case "SALARY_ADVANCE_WORKER_PORTRAIT_NOT_FOUND":
    case "SALARY_ADVANCE_NOT_FOUND":
      return "Không tìm thấy yêu cầu ứng lương hoặc dữ liệu liên quan.";
    case "SALARY_ADVANCE_PROJECT_INACTIVE":
      return "Dự án được chọn hiện không còn ở trạng thái hoạt động.";
    case "SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED":
      return "Dự án này chưa có Kế toán dự án đang hoạt động. Vui lòng liên hệ Admin cấu hình Kế toán dự án trước khi gửi yêu cầu.";
    case "SALARY_ADVANCE_WORKER_PROJECT_MISMATCH":
    case "SALARY_ADVANCE_WORKER_NOT_IN_PROJECT":
      return "Người lao động được chọn không thuộc phạm vi dự án này hoặc chưa có công hợp lệ.";
    case "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS":
      return "Người lao động hiện không ở trạng thái đang làm việc (ON) nên không đủ điều kiện ứng lương.";
    case "SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON":
      return "Người lao động đang ở trạng thái làm việc (ON) tại từ 2 dự án trở lên nên không đủ điều kiện ứng lương.";
    case "SALARY_ADVANCE_WORKER_DUPLICATE_CCCD":
      return "Hồ sơ người lao động đang thuộc nhóm trùng CCCD cần rà soát nên tạm thời bị chặn ứng lương.";
    case "SALARY_ADVANCE_PAYMENT_METHOD_INVALID":
      return "Vui lòng chọn phương thức nhận tiền hợp lệ (Tiền mặt hoặc Chuyển khoản).";
    case "SALARY_ADVANCE_BANK_ACCOUNT_MISSING":
      return "Hồ sơ người lao động chưa có đầy đủ thông tin tài khoản ngân hàng để nhận chuyển khoản.";
    case "SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED":
      return "Tên chủ tài khoản ngân hàng không trùng khớp với họ tên người lao động (không chính chủ). Không thể tạo yêu cầu chuyển khoản.";
    case "SALARY_ADVANCE_AMOUNT_INVALID":
      return "Số tiền ứng lương không hợp lệ (phải là số nguyên dương VNĐ).";
    case "SALARY_ADVANCE_CONTENT_INVALID":
    case "SALARY_ADVANCE_NOTE_INVALID":
      return "Nội dung tin nhắn hoặc ghi chú không hợp lệ.";
    case "SALARY_ADVANCE_MESSAGE_REQUIRED":
      return "Vui lòng nhập nội dung trao đổi.";
    case "SALARY_ADVANCE_REASON_REQUIRED":
    case "SALARY_ADVANCE_REJECT_REASON_REQUIRED":
      return "Vui lòng nhập lý do từ chối yêu cầu ứng lương.";
    case "SALARY_ADVANCE_STATE_CONFLICT":
      return "Trạng thái yêu cầu ứng lương đã thay đổi và không còn cho phép thao tác này. Hệ thống đã tải lại dữ liệu mới nhất.";
    case "SALARY_ADVANCE_VERSION_CONFLICT":
      return "Yêu cầu ứng lương vừa được người dùng khác cập nhật. Hệ thống đã tải lại phiên bản mới nhất.";
    case "SALARY_ADVANCE_IDEMPOTENCY_INVALID":
    case "SALARY_ADVANCE_IDEMPOTENCY_REQUIRED":
      return "Thiếu hoặc sai định dạng mã chống gửi trùng (Idempotency-Key). Vui lòng thử lại.";
    case "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT":
      return "Thao tác đang được xử lý hoặc mã chống gửi trùng bị xung đột. Hệ thống đã làm mới trạng thái.";
    case "SALARY_ADVANCE_EVIDENCE_MIME_INVALID":
      return "Định dạng ảnh không hợp lệ. Chỉ chấp nhận ảnh JPEG hoặc PNG.";
    case "SALARY_ADVANCE_EVIDENCE_SIZE_INVALID":
      return "Dung lượng ảnh vượt quá giới hạn 10 MB hoặc không hợp lệ.";
    case "SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID":
      return "Mã kiểm tra toàn vẹn ảnh (SHA-256) không khớp. Vui lòng chọn lại ảnh và tải lên lại.";
    case "SALARY_ADVANCE_EVIDENCE_UPLOAD_MISSING":
    case "SALARY_ADVANCE_EVIDENCE_CONTENT_INVALID":
      return "Tệp ảnh tải lên kho lưu trữ không hợp lệ hoặc chưa hoàn tất.";
    case "SALARY_ADVANCE_UPLOAD_SUPERSEDED":
    case "SALARY_ADVANCE_UPLOAD_EXPIRED":
      return "Phiên tải ảnh lên đã hết hạn hoặc bị thay thế. Vui lòng thực hiện tải ảnh lại.";
    case "SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT":
      return "Phiên bản ảnh nhận tiền mặt đã thay đổi. Hệ thống đã tải lại phiên bản mới nhất.";
    case "SALARY_ADVANCE_WORKER_PORTRAIT_MISSING":
    case "SALARY_ADVANCE_PORTRAIT_LOCK_INVALID":
      return "Người lao động chưa có ảnh chân dung chuẩn trong hồ sơ hệ thống nên chưa thể xác nhận «Đã đối chiếu».";
    case "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT":
      return "Ảnh chân dung hồ sơ của người lao động vừa thay đổi. Hệ thống đã tải lại ảnh mới nhất để bạn đối chiếu lại.";
    case "SALARY_ADVANCE_EXPORT_LIMIT_EXCEEDED":
      return "Số lượng dòng khớp bộ lọc vượt quá giới hạn xuất Excel cho phép (tối đa 5.000 dòng). Vui lòng thu hẹp bộ lọc theo dự án hoặc trạng thái.";
    case "SALARY_ADVANCE_EXPORT_INCOMPLETE":
      return "Không thể tải đầy đủ toàn bộ các trang dữ liệu để xuất Excel. Vui lòng thử lại.";
    case "SALARY_ADVANCE_STORAGE_UNAVAILABLE":
      return "Kho lưu trữ ảnh hiện tạm thời gián đoạn. Vui lòng thử lại sau ít phút.";
    case "SALARY_ADVANCE_QUERY_INVALID":
    case "SALARY_ADVANCE_PROJECT_INVALID":
    case "SALARY_ADVANCE_WORKER_INVALID":
    case "SALARY_ADVANCE_ACTION_INVALID":
    case "SALARY_ADVANCE_DECISION_INVALID":
    case "SALARY_ADVANCE_REQUEST_INVALID":
    case "SALARY_ADVANCE_EVIDENCE_VERSION_INVALID":
    case "SALARY_ADVANCE_UPLOAD_ID_INVALID":
    case "SALARY_ADVANCE_PAYLOAD_INVALID":
    case "INVALID_JSON":
      return "Dữ liệu gửi lên không hợp lệ. Vui lòng kiểm tra lại các trường thông tin.";
    case "SALARY_ADVANCE_UNAVAILABLE":
    default:
      return "Hệ thống tạm thời chưa xử lý được yêu cầu. Vui lòng thử lại.";
  }
}
