"use client";

import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { clientApi } from "@/lib/client-api";
import { Search as SearchIcon, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/app/empty-state";
import Link from "next/link";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { useQK } from "@/components/providers/query-provider";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";

type SearchResult = {
  page_id: string;
  title: string;
  url: string;
  snippet: string;
  highlights: Array<{ start: number; end: number }>;
  archived_at: string;
};

function highlightSnippet(
  text: string,
  highlights: Array<{ start: number; end: number }>,
) {
  if (highlights.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let lastEnd = 0;
  for (const { start, end } of highlights) {
    if (start > lastEnd) parts.push(text.slice(lastEnd, start));
    parts.push(
      <mark
        key={start}
        className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-800"
      >
        {text.slice(start, end)}
      </mark>,
    );
    lastEnd = end;
  }
  if (lastEnd < text.length) parts.push(text.slice(lastEnd));
  return parts;
}

function ResultCard({ result }: { result: SearchResult }) {
  const hostname = (() => {
    try {
      return new URL(result.url).hostname;
    } catch {
      return result.url;
    }
  })();
  return (
    <Link
      href={`/app/pages/${result.page_id}`}
      className="block rounded-lg border border-border p-4 transition-colors hover:bg-accent"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="line-clamp-1 text-sm font-medium">{result.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{hostname}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {format(new Date(result.archived_at + "Z"), "MMM d, yyyy")}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
        {highlightSnippet(result.snippet, result.highlights)}
      </p>
    </Link>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchContent />
    </Suspense>
  );
}

function SearchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const q = searchParams.get("q") ?? "";
  const collectionId = searchParams.get("collection_id");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const resultsRef = useRef<HTMLDivElement>(null);
  const qk = useQK();

  const { data, isLoading } = useQuery({
    queryKey: qk("search", { q, collection_id: collectionId }),
    queryFn: () =>
      clientApi.search({
        q,
        page_size: 20,
        ...(collectionId ? { collection_id: collectionId } : {}),
      }),
    enabled: q.length > 0,
  });

  const { data: collectionsData } = useQuery({
    queryKey: qk("collections"),
    queryFn: () => clientApi.listCollections(),
  });

  const collectionName = collectionId
    ? collectionsData?.collections.find((c) => c.id === collectionId)?.name
    : null;

  const results = useMemo(() => data?.results ?? [], [data?.results]);
  const total = data?.total ?? 0;
  const shouldVirtualise = total > 200;

  const virtualiser = useVirtualizer({
    count: results.length,
    getScrollElement: () => resultsRef.current,
    estimateSize: () => 100,
    overscan: 5,
  });

  const navigateToResult = useCallback(
    (index: number) => {
      const result = results[index];
      if (result) {
        router.push(`/app/pages/${result.page_id}`);
      }
    },
    [results, router],
  );

  useEffect(() => {
    const container = resultsRef.current;
    if (!container) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (results.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => {
          const next = Math.min(i + 1, results.length - 1);
          virtualiser.scrollToIndex(next, { align: "auto" });
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => {
          const prev = Math.max(i - 1, 0);
          virtualiser.scrollToIndex(prev, { align: "auto" });
          return prev;
        });
      } else if (e.key === "Enter") {
        setFocusedIndex((current) => {
          if (current >= 0 && current < results.length) {
            navigateToResult(current);
          }
          return current;
        });
      }
    }

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [results.length, virtualiser, navigateToResult]);

  if (!q) {
    return (
      <EmptyState
        icon={SearchIcon}
        title="Search your pages"
        description="Type a search term to find pages by content"
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">
          No pages match &ldquo;{q}&rdquo;
        </h1>
        <Button variant="outline" onClick={() => router.push("/app")}>
          Clear search
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">
          {total} result{total !== 1 ? "s" : ""}
        </h1>
        {collectionId && (
          <Badge
            variant="secondary"
            data-testid="collection-filter-chip"
            className="gap-1"
          >
            {collectionName ?? "Collection"}
            <button
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.delete("collection_id");
                router.push(`/app/search?${params.toString()}`);
              }}
              aria-label="Remove collection filter"
            >
              <X className="size-3" />
            </button>
          </Badge>
        )}
      </div>

      {shouldVirtualise ? (
        <div
          ref={resultsRef}
          tabIndex={0}
          className="h-[calc(100vh-12rem)] overflow-auto outline-none"
          role="listbox"
          aria-label="Search results"
        >
          <div
            style={{
              height: `${virtualiser.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualiser.getVirtualItems().map((virtualItem) => {
              const result = results[virtualItem.index]!;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  role="option"
                  aria-selected={virtualItem.index === focusedIndex}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  className={
                    virtualItem.index === focusedIndex
                      ? "ring-2 ring-ring rounded-lg"
                      : ""
                  }
                >
                  <ResultCard result={result} />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div
          ref={resultsRef}
          tabIndex={0}
          className="space-y-3 outline-none"
          role="listbox"
          aria-label="Search results"
        >
          {results.map((result, index) => (
            <div
              key={result.page_id}
              role="option"
              aria-selected={index === focusedIndex}
              className={
                index === focusedIndex
                  ? "ring-2 ring-ring rounded-lg"
                  : ""
              }
            >
              <ResultCard result={result} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
