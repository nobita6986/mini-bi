export function ErrorState({ title = "Không tải được dữ liệu", detail }: { title?: string; detail?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-6 py-10 dark:border-red-900 dark:bg-red-950">
      <p className="text-sm font-semibold text-red-800 dark:text-red-200">{title}</p>
      {detail ? <p className="mt-2 text-sm text-red-700 dark:text-red-300">{detail}</p> : null}
    </div>
  );
}
