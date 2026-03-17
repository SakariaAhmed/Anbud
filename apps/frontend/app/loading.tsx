import { Skeleton } from "@/components/ui/skeleton";

export default function HomeLoading() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-8 px-4 py-8 md:px-8 lg:py-12">
      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-16 w-full max-w-3xl" />
          <Skeleton className="h-6 w-full max-w-2xl" />
        </div>
        <Skeleton className="h-52 rounded-[2rem]" />
      </div>
      <Skeleton className="h-52 rounded-3xl" />
      <div className="grid gap-4">
        {[1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-36 rounded-3xl" />
        ))}
      </div>
    </main>
  );
}
