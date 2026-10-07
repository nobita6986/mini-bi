/**
 * P3-UI-COMPANY-DISPLAY-NAMES - Ten hien thi gon cho du an / cong ty.
 *
 * Nguyen tac:
 *  - Ten phap ly VAN LA du lieu chuan. Module nay chi tao chuoi HIEN THI, khong
 *    doi gia tri luu, khong doi project_id/khoa lien ket, khong dung cho export.
 *  - Uu tien truong "Ten hien thi" tuy chon neu noi goi cung cap.
 *  - Neu khong co, bo cac tien to phap ly pho bien khi hien thi.
 *  - KHONG cat phan ten rieng: chi bo tien to, va khong bao gio tra ve chuoi rong.
 *  - Ten qua ngan hoac khong khop tien to nao duoc tra ve nguyen ven.
 */

export type CompanyNameSource = {
  /** Khoa lien ket (project_id). Khong bao gio bi thay doi. */
  key: string;
  /** Ten phap ly day du tu catalog. */
  fullName: string;
  /** Truong "Ten hien thi" tuy chon neu catalog ho tro. */
  displayName?: string | null;
};

/**
 * Tien to phap ly pho bien, xet theo thu tu DAI -> NGAN de tranh cat sot.
 * Moi mau yeu cau mot khoang trang phia sau, nen "CP" trong "CP Group" van cat
 * duoc nhung "CtyABC" thi khong bi dung toi.
 */
export const LEGAL_NAME_PREFIXES: readonly string[] = Object.freeze([
  "Công ty TNHH MTV",
  "Công ty trách nhiệm hữu hạn một thành viên",
  "Công ty trách nhiệm hữu hạn",
  "Công ty TNHH",
  "Công ty Cổ phần",
  "Công ty CP",
  "Công ty Hợp danh",
  "Công ty",
  "Tập đoàn",
  "Tổng công ty",
  "CTCP",
  "CT TNHH",
  "TNHH MTV",
  "TNHH",
  "Co., Ltd",
  "Co.,Ltd",
  "Corporation",
  "Corp.",
  "JSC",
  "Ltd.",
]);

const NORMALIZED_PREFIXES = LEGAL_NAME_PREFIXES
  .map((prefix) => ({ raw: prefix, lower: prefix.toLocaleLowerCase("vi") }))
  .sort((left, right) => right.raw.length - left.raw.length);

/** Khoa sentinel cua read-model khong phai ten cong ty that. */
export function isSentinelProjectKey(key: string): boolean {
  return key.startsWith("__");
}

/**
 * Ten hien thi gon cho MOT ten. Tra ve ten goc khi khong co gi de bo, hoac khi
 * viec bo tien to se lam mat phan ten rieng.
 */
export function shortCompanyName(
  fullName: string,
  explicitDisplayName?: string | null,
): string {
  const explicit = (explicitDisplayName ?? "").trim();
  if (explicit !== "") return explicit;

  const trimmed = fullName.trim();
  if (trimmed === "") return fullName;
  // Sentinel cua read-model ("__unknown__", "__invalid__") khong phai ten cong ty.
  if (isSentinelProjectKey(trimmed)) return trimmed;

  const lower = trimmed.toLocaleLowerCase("vi");
  for (const { raw, lower: prefix } of NORMALIZED_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;
    const rest = trimmed.slice(raw.length);
    // Bat buoc phai co khoang trang phan cach va con lai phai co ten rieng.
    if (!/^\s+\S/.test(rest)) continue;
    const shortened = rest.trim();
    if (shortened === "") continue;
    return shortened;
  }
  return trimmed;
}

/**
 * Tinh ten hien thi cho ca mot danh sach, CO xu ly trung ten.
 *
 * Neu hai cong ty khac nhau cho ra cung ten gon, ca hai duoc tra ve TEN DAY DU
 * de nguoi dung van phan biet duoc. Khong bao gio gop/gop nhan hai don vi khac nhau.
 */
export function buildCompanyDisplayNames(
  items: readonly CompanyNameSource[],
): Map<string, string> {
  const shortByKey = new Map<string, string>();
  const ownersByShort = new Map<string, Set<string>>();

  for (const item of items) {
    const short = shortCompanyName(item.fullName, item.displayName);
    shortByKey.set(item.key, short);
    const owners = ownersByShort.get(short) ?? new Set<string>();
    owners.add(item.key);
    ownersByShort.set(short, owners);
  }

  const resolved = new Map<string, string>();
  for (const item of items) {
    const short = shortByKey.get(item.key) ?? item.fullName;
    const collides = (ownersByShort.get(short)?.size ?? 0) > 1;
    // Trung ten => dung ten day du de phan biet; ten day du luon khac nhau theo key.
    resolved.set(item.key, collides ? item.fullName : short);
  }
  return resolved;
}

/** Tien ich cho mot dong le: uu tien displayName, sau do bo tien to. */
export function companyLabel(
  fullName: string,
  explicitDisplayName?: string | null,
): string {
  return shortCompanyName(fullName, explicitDisplayName);
}
