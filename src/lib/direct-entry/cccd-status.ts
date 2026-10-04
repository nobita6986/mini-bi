/**
 * P1.6-I04C3-R2 - Trang thai cot "Ho so CCCD" tren luoi nhap lieu.
 *
 * Blocker da xac minh: direct_entry_list_own_drafts / OwnDraft KHONG tra trang thai tai lieu,
 * nen khi tai trang KHONG duoc gia dinh 0/2 va KHONG duoc goi entry detail cho tung dong
 * (tranh N+1). Vi vay:
 *   - dong chua co entry_id            => "Chưa lưu"        (nut quan ly bi khoa)
 *   - dong da luu, chua mo ho so       => "Chưa tải trạng thái"
 *   - da mo dung dong do (1 GET)       => "0/2" | "1/2" | "2/2"
 *
 * Cache chi nam trong memory cua trang, gan voi entry version da doc; khong localStorage,
 * khong sessionStorage, khong chua storage metadata.
 */
import {
  CCCD_STATUS_UNKNOWN_LABEL,
  cccdProgressLabel,
  type CccdDocumentSummary,
} from "./cccd-document-pair.ts";

export const CCCD_UNSAVED_LABEL = "Chưa lưu";
export { CCCD_STATUS_UNKNOWN_LABEL };

export type CccdStatusKind = "UNSAVED" | "UNKNOWN" | "LOADED";

export type CccdStatusEntry = { entryVersion: number; label: string };

/** Key = entry_id. Gia tri gan voi entry version luc doc duoc. */
export type CccdStatusCache = ReadonlyMap<string, CccdStatusEntry>;

export const EMPTY_CCCD_STATUS_CACHE: CccdStatusCache = new Map<string, CccdStatusEntry>();

export type CccdStatusView = { kind: CccdStatusKind; label: string; canManage: boolean };

/**
 * Nhan cot. Version lech => coi nhu chua tai (du lieu cu khong duoc dung lai).
 */
export function readCccdStatus(
  cache: CccdStatusCache,
  entryId: string | null,
  entryVersion: number | null,
): CccdStatusView {
  if (entryId === null || entryId === "") {
    return { kind: "UNSAVED", label: CCCD_UNSAVED_LABEL, canManage: false };
  }
  const cached = cache.get(entryId);
  if (cached && entryVersion !== null && cached.entryVersion === entryVersion) {
    return { kind: "LOADED", label: cached.label, canManage: true };
  }
  return { kind: "UNKNOWN", label: CCCD_STATUS_UNKNOWN_LABEL, canManage: true };
}

/** Ghi cache sau mot lan doc detail thanh cong (bat bien, khong sua Map dang dung). */
export function writeCccdStatus(
  cache: CccdStatusCache,
  entryId: string,
  entryVersion: number,
  documents: readonly CccdDocumentSummary[],
): CccdStatusCache {
  const next = new Map(cache);
  next.set(entryId, { entryVersion, label: cccdProgressLabel(documents) });
  return next;
}

/** Sau khi submission/entry doi phien ban, bo cache cu cua dung entry do. */
export function dropCccdStatus(cache: CccdStatusCache, entryId: string): CccdStatusCache {
  if (!cache.has(entryId)) return cache;
  const next = new Map(cache);
  next.delete(entryId);
  return next;
}
