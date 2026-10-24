"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  MoreVertical,
  Download,
  Share2,
  FolderInput,
  Trash2,
} from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type PageCardProps = {
  page: {
    id: string;
    title: string;
    url: string;
    archived_at: string;
    collection_id?: string | null | undefined;
    size_bytes?: number | undefined;
  };
  onDelete?: (id: string) => void;
  onShare?: (id: string) => void;
  onMove?: (id: string) => void;
  onDownload?: (id: string) => void;
};

export function PageCard({
  page,
  onDelete,
  onShare,
  onMove,
  onDownload,
}: PageCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `page-${page.id}`,
    data: {
      pageId: page.id,
      pageTitle: page.title,
      collectionId: page.collection_id,
    },
  });

  const hostname = (() => {
    try {
      return new URL(page.url).hostname;
    } catch {
      return page.url;
    }
  })();

  // Favicon privacy (pagepocket-frontend-shell): archived hostnames are never
  // sent to third-party favicon providers (previously google.com/s2). Cards
  // render a local letter avatar — zero outbound requests.
  const initial = page.title.charAt(0).toUpperCase();

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`group border-border bg-card rounded-lg border p-4 transition-shadow hover:shadow-md ${isDragging ? "opacity-50" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <div className="bg-primary text-primary-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold">
            {initial}
          </div>
          <div className="min-w-0">
            <Link
              href={`/app/pages/${page.id}`}
              className="line-clamp-1 text-sm font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {page.title}
            </Link>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {hostname}
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Page actions"
              />
            }
          >
            <MoreVertical className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onDownload?.(page.id)}>
              <Download className="mr-2 size-4" />
              Download
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onShare?.(page.id)}>
              <Share2 className="mr-2 size-4" />
              Share
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onMove?.(page.id)}>
              <FolderInput className="mr-2 size-4" />
              Move to collection
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => onDelete?.(page.id)}
            >
              <Trash2 className="mr-2 size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
        <span>
          Archived{" "}
          {formatDistanceToNow(new Date(page.archived_at + "Z"), {
            addSuffix: true,
          })}
        </span>
        {page.size_bytes !== undefined && (
          <span className="bg-muted rounded px-1.5 py-0.5 text-[10px] tabular-nums">
            {formatBytes(page.size_bytes)}
          </span>
        )}
      </div>
    </div>
  );
}
