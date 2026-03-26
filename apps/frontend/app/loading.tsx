export default function HomeLoading() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div className="space-y-2">
        <div className="h-8 w-64 animate-pulse rounded-md bg-slate-200" />
        <div className="h-4 w-48 animate-pulse rounded-md bg-slate-200" />
      </div>
      <div className="flex gap-2">
        <div className="h-10 w-48 animate-pulse rounded-full bg-slate-200" />
        <div className="h-10 w-48 animate-pulse rounded-full bg-slate-200" />
        <div className="h-10 w-48 animate-pulse rounded-full bg-slate-200" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="h-96 animate-pulse rounded-xl bg-slate-200" />
        <div className="space-y-4">
          <div className="h-48 animate-pulse rounded-xl bg-slate-200" />
          <div className="h-36 animate-pulse rounded-xl bg-slate-200" />
        </div>
      </div>
    </div>
  );
}
