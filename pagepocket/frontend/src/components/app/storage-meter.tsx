"use client";

import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { clientApi } from "@/lib/client-api";
import { useQK, useUserId } from "@/components/providers/query-provider";
import { formatBytes } from "@/lib/format";

/**
 * Sidebar storage meter (storage-usage-display, design D6). Display-only
 * usage vs plan limit; loads and fails quietly — a skeleton while in flight,
 * nothing on error — so the sidebar never breaks.
 */
export function StorageMeter() {
  const userId = useUserId();
  const qk = useQK();

  const { data, isError } = useQuery({
    queryKey: qk("archive", "storageUsage"),
    queryFn: () => clientApi.getStorageUsage(),
    enabled: !!userId,
    staleTime: 60_000,
  });

  // No session: the query never runs and the meter stays out of the way.
  if (!userId || isError) {
    return null;
  }

  if (!data) {
    return (
      <div className="border-border border-t p-4">
        <div className="bg-muted h-3 w-28 animate-pulse rounded" />
        <div className="bg-muted mt-2 h-1.5 w-full animate-pulse rounded-full" />
      </div>
    );
  }

  const overLimit = data.used_bytes > data.storage_limit_bytes;
  const pct =
    data.storage_limit_bytes > 0
      ? Math.min(
          100,
          Math.round((data.used_bytes / data.storage_limit_bytes) * 1000) / 10,
        )
      : 100;
  const fillClass =
    pct >= 90 || overLimit
      ? "bg-red-500"
      : pct >= 75
        ? "bg-amber-500"
        : "bg-emerald-500";
  const planLabel = data.plan.charAt(0).toUpperCase() + data.plan.slice(1);

  return (
    <div className="border-border border-t p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <HardDrive className="size-3.5 shrink-0" />
          <span className="truncate">
            {formatBytes(data.used_bytes)} of{" "}
            {formatBytes(data.storage_limit_bytes)} used
          </span>
        </span>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium">
          {planLabel}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="bg-muted mt-2 h-1.5 w-full overflow-hidden rounded-full"
      >
        <div
          className={`h-full rounded-full transition-colors ${fillClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
