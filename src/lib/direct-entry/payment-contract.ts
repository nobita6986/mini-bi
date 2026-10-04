export const PAYMENT_STATES = [
  "omitted",
  "unknown",
  "intentionally_blank",
  "provided",
] as const;

export type PaymentState = typeof PAYMENT_STATES[number];

export type PaymentInput = {
  state: PaymentState;
  account_number: string | null;
  bank_id: string | null;
  account_holder_name: string | null;
};

export type AccountMetadataInput = {
  account_number: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
};

export type PaymentProjection = PaymentInput & {
  bank_name: string | null;
  version: number;
  masked: boolean;
};

const BANK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FULL_KEYS = [
  "state", "account_number", "bank_id", "bank_name", "account_holder_name", "version",
];
const MASKED_KEYS = ["state", "account_number", "version"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function isPaymentState(value: unknown): value is PaymentState {
  return typeof value === "string" && PAYMENT_STATES.includes(value as PaymentState);
}

export function projectPaymentInput(
  value: unknown,
  activeBankIds?: ReadonlySet<string>,
): PaymentInput | null {
  if (!isRecord(value) ||
      !exactKeys(value, ["state", "account_number", "bank_id", "account_holder_name"]) ||
      !isPaymentState(value.state)) return null;

  const { state, account_number, bank_id, account_holder_name } = value;
  if (state !== "provided") {
    if (account_number !== null || bank_id !== null || account_holder_name !== null) return null;
    return {
      state,
      account_number: null,
      bank_id: null,
      account_holder_name: null,
    };
  }

  if (typeof account_number !== "string" || !/^\d{1,64}$/.test(account_number) ||
      typeof bank_id !== "string" || !BANK_ID.test(bank_id) ||
      (activeBankIds !== undefined && !activeBankIds.has(bank_id)) ||
      typeof account_holder_name !== "string" ||
      account_holder_name.trim().length < 1 || account_holder_name.length > 256) return null;
  return { state, account_number, bank_id, account_holder_name };
}

function projectOptionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const length = Array.from(normalized).length;
  if (length > maxLength || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) return undefined;
  return normalized;
}

export function projectAccountMetadataInput(value: unknown): AccountMetadataInput | null {
  if (!isRecord(value) ||
      !exactKeys(value, ["account_number", "bank_name", "account_holder_name"])) return null;
  const account_number = projectOptionalText(value.account_number, 64);
  const bank_name = projectOptionalText(value.bank_name, 256);
  const account_holder_name = projectOptionalText(value.account_holder_name, 256);
  if (account_number === undefined || bank_name === undefined ||
      account_holder_name === undefined) return null;
  return { account_number, bank_name, account_holder_name };
}

export function projectPaymentProjection(value: unknown): PaymentProjection | null {
  if (!isRecord(value) ||
      (Object.keys(value).length === MASKED_KEYS.length
        ? !exactKeys(value, MASKED_KEYS)
        : !exactKeys(value, FULL_KEYS)) ||
      !isPaymentState(value.state) ||
      (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) ||
      (value.account_number !== null && typeof value.account_number !== "string")) return null;

  const masked = Object.keys(value).length === MASKED_KEYS.length;
  if (masked) {
    if (value.state === "provided" &&
        (typeof value.account_number !== "string" ||
          !/^•*\d{0,4}$/.test(value.account_number))) return null;
    if (value.state !== "provided" && value.account_number !== null) return null;
    return {
      state: value.state,
      account_number: value.account_number as string | null,
      bank_id: null,
      bank_name: null,
      account_holder_name: null,
      version: value.version,
      masked: true,
    };
  }

  if ((value.bank_id !== null && typeof value.bank_id !== "string") ||
      (value.bank_id !== null && !BANK_ID.test(value.bank_id)) ||
      (value.state === "provided"
        ? [value.account_number, value.bank_name, value.account_holder_name].some(
            (field, index) => projectOptionalText(field, index === 0 ? 64 : 256) === undefined,
          )
        : value.account_number !== null || value.bank_name !== null ||
          value.account_holder_name !== null || value.bank_id !== null)) return null;
  const account_number = projectOptionalText(value.account_number, 64);
  const bank_name = projectOptionalText(value.bank_name, 256);
  const account_holder_name = projectOptionalText(value.account_holder_name, 256);
  if (account_number === undefined || bank_name === undefined ||
      account_holder_name === undefined ||
      (value.state === "provided" &&
        account_number === null && bank_name === null && account_holder_name === null)) return null;
  return {
    state: value.state,
    account_number,
    bank_id: value.bank_id as string | null,
    bank_name,
    account_holder_name,
    version: value.version,
    masked: false,
  };
}

export function projectPaymentUpdateResult(
  value: unknown,
  entryId: string,
): { entry_id: string; entry_version: number; payment_version: number } | null {
  if (!isRecord(value) || !exactKeys(value, ["entry_id", "entry_version", "payment_version"]) ||
      value.entry_id !== entryId ||
      typeof value.entry_version !== "number" || !Number.isSafeInteger(value.entry_version) ||
      value.entry_version < 1 ||
      typeof value.payment_version !== "number" || !Number.isSafeInteger(value.payment_version) ||
      value.payment_version < 1) return null;
  return {
    entry_id: value.entry_id,
    entry_version: value.entry_version,
    payment_version: value.payment_version,
  };
}
