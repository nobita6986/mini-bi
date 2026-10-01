export default function DashboardLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 animate-pulse px-4 py-6 sm:px-6">
      <div className="mb-6 space-y-2">
        <div className="h-7 w-56 rounded bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-4 w-96 max-w-full rounded bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <div className="mb-6 h-28 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-20 rounded-lg bg-zinc-200 dark:bg-zinc-800" />)}
      </div>
      <div className="mb-6 h-64 rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-48 rounded-lg bg-zinc-200 dark:bg-zinc-800" />)}
      </div>
    </main>
  );
}
