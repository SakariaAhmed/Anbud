import { Skeleton } from "@/components/ui/skeleton";

export default function BidLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 px-4 py-6 md:px-8">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-6">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-5 w-full max-w-2xl" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-56 rounded-3xl" />
        <Skeleton className="h-56 rounded-3xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {[1, 2, 3, 4].map((item) => (
          <Skeleton key={item} className="h-32 rounded-3xl" />
        ))}
      </div>
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <Skeleton className="h-[720px] rounded-3xl" />
        <div className="grid gap-4">
          <Skeleton className="h-[360px] rounded-3xl" />
          <Skeleton className="h-[360px] rounded-3xl" />
        </div>
      </div>
    </div>
  );
}
