import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-28" />
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border p-4 space-y-2">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
