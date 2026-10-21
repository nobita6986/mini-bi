export function ErrorState({ title = "Không tải được dữ liệu", detail }: { title?: string; detail?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-status-danger-border bg-status-danger-bg px-6 py-10 text-status-danger-text">
      <p className="text-sm font-semibold">{title}</p>
      {detail ? <p className="mt-2 text-sm">{detail}</p> : null}
    </div>
  );
}
