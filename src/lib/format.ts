/** Định dạng timestamp hiển thị, không phụ thuộc timezone trình duyệt/người dùng. */
const GMT7_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** ISO timestamp (UTC) -> "YYYY-MM-DD HH:mm:ss (GMT+7)". Trả "—" khi rỗng/sai. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = GMT7_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return (
    get("year") + "-" + get("month") + "-" + get("day") +
    " " + get("hour") + ":" + get("minute") + ":" + get("second") + " (GMT+7)"
  );
}

/** Ngày "hôm nay" theo Asia/Ho_Chi_Minh (YYYY-MM-DD) — không dùng toISOString().slice(0,10) (UTC). */
export function todayDateIso(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

/** Rút gọn ID dài (drive_file_id...) để hiển thị; full value nằm ở title. */
export function shortenId(id: string | null | undefined, length = 8): string {
  if (!id) return "—";
  if (id.length <= length + 1) return id;
  return id.slice(0, length) + "…";
}
