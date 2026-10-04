import type {
  DraftPaymentAccountField,
  DraftProfileField,
  DraftProfileProjection,
} from "./write-repository.ts";

export type DraftProfileGridCells = {
  cells: Record<string, string>;
  displayValues: Record<string, string>;
};

function projectField(
  cells: Record<string, string>,
  displayValues: Record<string, string>,
  key: string,
  field: DraftProfileField | DraftPaymentAccountField,
): void {
  if (field.state === "provided") {
    cells[key] = field.value;
  } else if (field.state === "masked") {
    displayValues[key] = field.value;
  } else if (field.state === "redacted") {
    displayValues[key] = field.present ? "Có dữ liệu · đã ẩn theo quyền" : "Không có dữ liệu";
  } else if (field.state === "omitted") {
    displayValues[key] = "Không được cung cấp";
  } else if (field.state === "unknown") {
    displayValues[key] = "Chưa xác định";
  } else {
    displayValues[key] = "Cố ý để trống";
  }
}

export function projectDraftProfileGridCells(
  profile: DraftProfileProjection,
): DraftProfileGridCells {
  const cells: Record<string, string> = {};
  const displayValues: Record<string, string> = {};

  for (const [key, field] of Object.entries(profile.worker_details)) {
    projectField(cells, displayValues, key, field);
  }
  projectField(cells, displayValues, "general_note", profile.general_note);

  if (profile.employment) {
    projectField(cells, displayValues, "leave_date", profile.employment.leave_date);
    projectField(cells, displayValues, "leave_reason_text", profile.employment.leave_reason_text);
  } else {
    displayValues.leave_date = "Chưa có dữ liệu việc làm";
    displayValues.leave_reason_text = "Chưa có dữ liệu việc làm";
  }

  if (profile.payment) {
    projectField(cells, displayValues, "account_number", profile.payment.account_number);
    projectField(cells, displayValues, "bank_name", profile.payment.bank_name);
    projectField(cells, displayValues, "account_holder_name", profile.payment.account_holder_name);
  } else {
    displayValues.account_number = "Chưa có hồ sơ thanh toán";
    displayValues.bank_name = "Chưa có hồ sơ thanh toán";
    displayValues.account_holder_name = "Chưa có hồ sơ thanh toán";
  }

  return { cells, displayValues };
}
