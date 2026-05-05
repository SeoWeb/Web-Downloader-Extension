"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Share2, FolderInput, Trash2 } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { useState } from "react";
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
    collection_id: string | null;
  };
  onDelete?: (id: string) => void;
  onShare?: (id: string) => void;
  onMove?: (id: string) => void;
};

export function PageCard({ page, onDelete, onShare, onMove }: PageCardProps) {
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

  const faviconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  const [faviconError, setFaviconError] = useState(false);

  const initial = page.title.charAt(0).toUpperCase();

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`group rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-md ${isDragging ? "opacity-50" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold overflow-hidden">
            {faviconError ? (
              initial
            ) : (
              <img
                src={faviconUrl}
                alt=""
                className="h-5 w-5"
                onError={() => setFaviconError(true)}
              />
            )}
          </div>
          <div className="min-w-0">
            <Link
              href={`/app/pages/${page.id}`}
              className="text-sm font-medium hover:underline line-clamp-1"
              onClick={(e) => e.stopPropagation()}
            >
              {page.title}
            </Link>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {hostname}
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Page actions"
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onShare?.(page.id)}>
              <Share2 className="size-4 mr-2" />
              Share
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onMove?.(page.id)}>
              <FolderInput className="size-4 mr-2" />
              Move to collection
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => onDelete?.(page.id)}
            >
              <Trash2 className="size-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Archived {formatDistanceToNow(new Date(page.archived_at), { addSuffix: true })}
      </p>
    </div>
  );
}
