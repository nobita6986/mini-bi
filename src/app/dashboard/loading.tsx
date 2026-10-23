export default function DashboardLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="Đang tải bảng điều khiển"
      className="mx-auto w-full max-w-6xl flex-1 animate-pulse motion-reduce:animate-none px-4 py-6 sm:px-6"
    >
      <div className="mb-6 space-y-2">
        <div className="h-7 w-56 rounded-lg bg-muted/30" />
        <div className="h-4 w-96 max-w-full rounded bg-muted/30" />
      </div>
      <div className="mb-6 h-28 rounded-2xl bg-muted/30" />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-2xl bg-muted/30" />)}
      </div>
      <div className="mb-6 h-72 rounded-2xl bg-muted/30" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-56 rounded-2xl bg-muted/30" />)}
      </div>
    </main>
  );
}
