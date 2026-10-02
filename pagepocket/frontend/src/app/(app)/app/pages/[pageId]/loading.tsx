import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between h-12 border-b border-border px-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
        </div>
      </div>
      <div className="flex-1">
        <Skeleton className="h-full w-full" />
      </div>
    </div>
  );
}
