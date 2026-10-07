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

/**
 * Resolve a stored catalog value without confusing a presentation label with
 * its stable key. Exact label/keyword matches are retained only to recognize
 * rows saved by older UI versions; new edits always commit `option.id`.
 * Ambiguous legacy labels fail closed instead of selecting an arbitrary row.
 */
export function findCatalogOptionByStoredValue<
  T extends { id: string; label: string; keywords?: string },
>(options: readonly T[], value: string): T | undefined {
  const normalize = (text: string) => text.trim().normalize("NFC").toLocaleLowerCase("vi");
  const needle = normalize(value);
  if (needle === "") return undefined;

  const ids = options.filter((option) => normalize(option.id) === needle);
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) return undefined;

  const legacyValues = options.filter((option) =>
    normalize(option.label) === needle ||
    (option.keywords !== undefined && normalize(option.keywords) === needle));
  return legacyValues.length === 1 ? legacyValues[0] : undefined;
}

/* ------------------------------------------------------------------ popup */

export type SearchPopupAnchor = {
  /** Toa do viewport cua o input dang sua. */
  top: number;
  bottom: number;
  left: number;
  width: number;
};

export type SearchPopupLayout = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "below" | "above";
};

export const SEARCH_POPUP_MARGIN = 8;
/** Chieu cao toi da mong muon cua danh sach truoc khi bi cat theo viewport. */
export const SEARCH_POPUP_MAX_HEIGHT = 240;
export const SEARCH_POPUP_MIN_HEIGHT = 80;

/**
 * P3-W07C-R4-R2: danh sach goi y nam trong o cua react-data-grid, ma o do co
 * overflow: clip, nen popup bi cat khoi o. Danh sach duoc render qua portal ra
 * ngoai cell va dat bang position: fixed; ham nay tinh toa do do.
 *
 * Vi tri luon nam trong viewport: lat len tren khi khong du cho phia duoi, va
 * kep ngang trong le margin.
 */
export function computeSearchPopupPosition(input: {
  anchor: SearchPopupAnchor;
  listHeight: number;
  viewport: { width: number; height: number };
  margin?: number;
  maxHeight?: number;
  minHeight?: number;
}): SearchPopupLayout {
  const margin = input.margin ?? SEARCH_POPUP_MARGIN;
  const maxHeight = input.maxHeight ?? SEARCH_POPUP_MAX_HEIGHT;
  const minHeight = input.minHeight ?? SEARCH_POPUP_MIN_HEIGHT;

  const spaceBelow = input.viewport.height - input.anchor.bottom - margin;
  const spaceAbove = input.anchor.top - margin;
  // Uu tien phia duoi khi du cho; neu khong thi chon ben rong hon.
  const placement: "below" | "above" =
    spaceBelow >= maxHeight || spaceBelow >= spaceAbove ? "below" : "above";

  const available = Math.max(minHeight, placement === "below" ? spaceBelow : spaceAbove);
  // Tran cuoi cung: chieu cao cung khong duoc vuot qua chinh viewport, ke ca khi
  // o neo nam ngoai viewport (grid cuon roi ma editor con mo).
  const viewportCapacity = Math.max(0, input.viewport.height - margin * 2);
  const height = Math.max(
    0,
    Math.min(Math.max(input.listHeight, minHeight), maxHeight, available, viewportCapacity),
  );

  const rawTop = placement === "below" ? input.anchor.bottom : input.anchor.top - height;
  const maxTop = Math.max(margin, input.viewport.height - margin - height);
  const top = Math.min(Math.max(margin, rawTop), maxTop);

  const width = Math.max(0, Math.min(input.anchor.width, input.viewport.width - margin * 2));
  const maxLeft = Math.max(margin, input.viewport.width - width - margin);
  const left = Math.min(Math.max(margin, input.anchor.left), maxLeft);

  return { top, left, width, maxHeight: height, placement };
}
