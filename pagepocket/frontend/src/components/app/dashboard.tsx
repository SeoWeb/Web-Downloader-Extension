"use client";

import { Archive } from "lucide-react";
import { EmptyState } from "@/components/app/empty-state";
import { PageCard } from "@/components/app/page-card";
import { MoveDialog } from "@/components/app/move-dialog";
import { MoveCombobox } from "@/components/app/move-combobox";
import { ShareDialog } from "@/components/app/share-dialog";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { clientApi } from "@/lib/client-api";
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useRouter, useSearchParams } from "next/navigation";
import type { ListPagesResponse } from "@/lib/api/schemas";
import { useQK } from "@/components/providers/query-provider";

type DashboardProps = {
  initialData?: ListPagesResponse;
  collectionId?: string;
};

export function Dashboard({ initialData, collectionId }: DashboardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortBy = searchParams.get("sort_by") ?? "archived_at";
  const queryClient = useQueryClient();
  const qk = useQK();

  const [actionPageId, setActionPageId] = useState<string | null>(null);
  const [actionPageCollectionId, setActionPageCollectionId] = useState<
    string | null
  >(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [comboboxPageId, setComboboxPageId] = useState<string | null>(null);
  const [comboboxCollectionId, setComboboxCollectionId] = useState<
    string | null
  >(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const queryParams = {
    page_size: 20,
    sort_by: sortBy,
    ...(collectionId ? { collection_id: collectionId } : {}),
  };

  const { data: colData } = useQuery({
    queryKey: qk("library", "collections"),
    queryFn: () => clientApi.listCollections(),
    enabled: !!collectionId,
  });
  const collectionName = colData?.collections.find(
    (c) => c.id === collectionId,
  )?.name;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery<ListPagesResponse>({
      queryKey: qk("archive", "listPages", queryParams),
      queryFn: ({ pageParam }) =>
        clientApi.listPages({
          ...queryParams,
          page: pageParam as number,
        }),
      initialPageParam: 1,
      getNextPageParam: (lastPage, allPages) => {
        const totalFetched = allPages.reduce(
          (sum, p) => sum + p.pages.length,
          0,
        );
        if (totalFetched < lastPage.total) return lastPage.page + 1;
        return undefined;
      },
      ...(initialData
        ? {
            initialData: {
              pages: [initialData],
              pageParams: [1],
            },
          }
        : {}),
    });

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleSortChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set("sort_by", value);
      const basePath = collectionId
        ? `/app/collections/${collectionId}`
        : "/app";
      router.replace(`${basePath}?${params.toString()}`);
    },
    [searchParams, router, collectionId],
  );

  // Optimistic delete
  const deleteMutation = useMutation({
    mutationFn: (pageId: string) => clientApi.deletePage(pageId),
    onMutate: async (pageId) => {
      const queryKey = qk("archive", "listPages", queryParams);
      await queryClient.cancelQueries({ queryKey });

      const previousData = queryClient.getQueryData<typeof data>(queryKey);

      queryClient.setQueryData<typeof data>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            pages: page.pages.filter((p) => p.id !== pageId),
            total: page.total - 1,
          })),
        };
      });

      return { previousData, queryKey };
    },
    onError: (_err, _pageId, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(context.queryKey, context.previousData);
      }
      toast.error("Failed to delete page");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk("archive", "listPages") });
    },
  });

  function handleDelete(pageId: string) {
    if (confirm("Delete this page?")) {
      deleteMutation.mutate(pageId);
    }
  }

  function handleMove(pageId: string) {
    const allPages = data?.pages.flatMap((p) => p.pages) ?? [];
    const page = allPages.find((p) => p.id === pageId);
    setActionPageId(pageId);
    setActionPageCollectionId(page?.collection_id ?? null);
    setMoveOpen(true);
  }

  function handleShare(pageId: string) {
    setActionPageId(pageId);
    setShareOpen(true);
  }

  // Shift+M keyboard shortcut for move
  const [focusedPageId, setFocusedPageId] = useState<string | null>(null);
  const [focusedCollectionId, setFocusedCollectionId] = useState<
    string | null
  >(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === "M" && focusedPageId) {
        e.preventDefault();
        setComboboxPageId(focusedPageId);
        setComboboxCollectionId(focusedCollectionId);
        setComboboxOpen(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [focusedPageId, focusedCollectionId]);

  const allPages = data?.pages.flatMap((p) => p.pages) ?? [];
  const totalCount = data?.pages[0]?.total ?? 0;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <EmptyState
        icon={Archive}
        title="No saved pages yet"
        description="Install the PagePocket extension to start saving web pages to your library."
        actions={[
          {
            label: "Install the extension",
            href: "https://chromewebstore.google.com/category/extensions",
          },
          {
            label: "Watch a 60-second demo",
            href: "#demo",
          },
        ]}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          {collectionName ?? "All Pages"}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({totalCount})
          </span>
        </h1>
        <Select value={sortBy} onValueChange={handleSortChange}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="archived_at">Newest first</SelectItem>
            <SelectItem value="title">Title A-Z</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {allPages.map((p) => (
          <div
            key={p.id}
            onFocus={() => {
              setFocusedPageId(p.id);
              setFocusedCollectionId(p.collection_id ?? null);
            }}
            onBlur={() => {
              setFocusedPageId(null);
              setFocusedCollectionId(null);
            }}
            tabIndex={0}
          >
            <PageCard
              page={p}
              onDelete={handleDelete}
              onMove={handleMove}
              onShare={handleShare}
            />
          </div>
        ))}
      </div>

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} className="h-1" />

      {isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      )}

      {!hasNextPage && totalCount > 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          You&apos;ve reached the end
        </p>
      )}

      {actionPageId && (
        <>
          <MoveDialog
            pageId={actionPageId}
            currentCollectionId={actionPageCollectionId}
            open={moveOpen}
            onOpenChange={setMoveOpen}
          />
          <ShareDialog
            pageId={actionPageId}
            open={shareOpen}
            onOpenChange={setShareOpen}
          />
        </>
      )}

      {comboboxPageId && (
        <MoveCombobox
          pageId={comboboxPageId}
          currentCollectionId={comboboxCollectionId}
          open={comboboxOpen}
          onOpenChange={setComboboxOpen}
        />
      )}
    </div>
  );
}

export default Dashboard;
