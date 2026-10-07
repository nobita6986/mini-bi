/**
 * P3-W07C-R4 - Loc option cho dropdown co tim kiem (Dự án / Người tuyển).
 *
 * Pure, khong phu thuoc React hay catalog that. Tach rieng de test duoc bang Node
 * va de editor trong grid tai dung thay vi tu viet lai logic loc.
 */
export type CatalogSearchOption = {
  /** Stable id cua option; cung duoc dung lam ma de tim (vi du ma nhan su). */
  id: string;
  /** Nhan dang hien thi cho nguoi dung. */
  label: string;
  /** Van ban bo sung duoc tim nhung khong hien thi (vi du vendor id). */
  keywords?: string;
};

/**
 * Loc theo noi dung dang hien thi (label), tu khoa bo sung (keywords) va
 * ma/dinh danh (id). Khong phan biet hoa/thuong, chuan hoa NFC + locale "vi"
 * giong helper typeahead hien co. Query rong tra ve toan bo option.
 */
export function filterCatalogSearchOptions<
  T extends { id: string; label: string; keywords?: string },
>(options: readonly T[], query: string): T[] {
  const normalized = query.trim().normalize("NFC").toLocaleLowerCase("vi");
  if (normalized === "") return [...options];
  const separator = " ";
  return options.filter((option) =>
    (option.label + separator + (option.keywords ?? "") + separator + option.id)
      .normalize("NFC")
      .toLocaleLowerCase("vi")
      .includes(normalized));
}
