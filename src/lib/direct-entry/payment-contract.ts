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

export type PaymentProjection = PaymentInput & {
  version: number;
  bank_name?: string | null;
};

const BANK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAYMENT_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/;
const LEGACY_MASKED_ACCOUNT_NUMBER = /^•+.{4}$/u;
const FULL_KEYS = [
  "state", "account_number", "bank_id", "account_holder_name", "version",
];
const FULL_NAME_KEYS = [
  "state", "account_number", "bank_id", "bank_name", "account_holder_name", "version",
];

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

export function isPaymentText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    [...value].length <= maxLength && !PAYMENT_CONTROLS.test(value);
}

export function isPaymentAccountNumber(value: unknown): value is string {
  return isPaymentText(value, 64) && !LEGACY_MASKED_ACCOUNT_NUMBER.test(value);
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

export function projectPaymentProjection(value: unknown): PaymentProjection | null {
  if (!isRecord(value) ||
      (!exactKeys(value, FULL_KEYS) && !exactKeys(value, FULL_NAME_KEYS)) ||
      !isPaymentState(value.state) ||
      (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1)) return null;

  const accountNumber = value.account_number;
  const bankId = value.bank_id;
  const bankName = "bank_name" in value ? value.bank_name : undefined;
  const holder = value.account_holder_name;
  if ((accountNumber !== null && !isPaymentAccountNumber(accountNumber)) ||
      (bankId !== null && (typeof bankId !== "string" || !BANK_ID.test(bankId))) ||
      ("bank_name" in value && bankName !== null && !isPaymentText(bankName, 256)) ||
      (holder !== null && !isPaymentText(holder, 256))) return null;

  if (value.state !== "provided") {
    if (accountNumber !== null || bankId !== null ||
        ("bank_name" in value && bankName !== null) || holder !== null) return null;
    return "bank_name" in value
      ? { state: value.state, account_number: null, bank_id: null, bank_name: null,
        account_holder_name: null, version: value.version }
      : { state: value.state, account_number: null, bank_id: null,
        account_holder_name: null, version: value.version };
  }

  // R4 persists partial metadata. The older five-key projection may omit a bank_name-only value.
  if (
    "bank_name" in value &&
    accountNumber === null &&
    bankId === null &&
    bankName === null &&
    holder === null
  ) {
    return null;
  }
  return "bank_name" in value
    ? { state: value.state, account_number: accountNumber as string | null,
      bank_id: bankId as string | null, bank_name: bankName as string | null,
      account_holder_name: holder as string | null, version: value.version }
    : { state: value.state, account_number: accountNumber as string | null,
      bank_id: bankId as string | null, account_holder_name: holder as string | null,
      version: value.version };
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
