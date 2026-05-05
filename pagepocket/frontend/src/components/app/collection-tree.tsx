"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDroppable } from "@dnd-kit/core";
import { clientApi } from "@/lib/client-api";
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  Palette,
  Pencil,
  FolderPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useDndContext } from "@/components/app/dnd-context";
import { useQK } from "@/components/providers/query-provider";

const PRESET_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#f97316",
  "#6366f1",
  "#14b8a6",
];

type Collection = {
  id: string;
  name: string;
  color: string;
  parent_id: string | null;
  page_count: number;
};

type TreeNodeProps = {
  collection: Collection;
  allCollections: Collection[];
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  selectedId: string | undefined;
  onSelect: ((id: string) => void) | undefined;
  onRequestNewCollection: ((parentId?: string) => void) | undefined;
};

function TreeNode({
  collection,
  allCollections,
  expandedIds,
  toggleExpand,
  selectedId,
  onSelect,
  onRequestNewCollection,
}: TreeNodeProps) {
  const children = allCollections.filter(
    (c) => c.parent_id === collection.id,
  );
  const isExpanded = expandedIds.has(collection.id);
  const isSelected = selectedId === collection.id;
  const queryClient = useQueryClient();
  const qk = useQK();
  const { activeDrag, overId } = useDndContext();

  const isOver = overId === collection.id;
  const isAlreadyInCollection = activeDrag?.collectionId === collection.id;

  const { setNodeRef } = useDroppable({
    id: collection.id,
    data: { type: "collection", collectionId: collection.id },
  });

  const showDropHighlight = activeDrag !== null;
  const dropState = showDropHighlight
    ? isAlreadyInCollection
      ? "already-in"
      : isOver
        ? "valid"
        : "idle"
    : "idle";

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(collection.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const collectionsKey = qk("library", "collections");

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      clientApi.updateCollection(collection.id, { name }),
    onMutate: async (newName) => {
      await queryClient.cancelQueries({ queryKey: collectionsKey });
      const previousData = queryClient.getQueryData(collectionsKey);
      queryClient.setQueryData(collectionsKey, (old: { collections?: Collection[] } | undefined) => {
        if (!old?.collections) return old;
        return {
          ...old,
          collections: old.collections.map((c: Collection) =>
            c.id === collection.id ? { ...c, name: newName } : c,
          ),
        };
      });
      return { previousData };
    },
    onError: (_err, _name, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(collectionsKey, context.previousData);
      }
      toast.error("Failed to rename collection");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: collectionsKey });
    },
    onSuccess: () => {
      setIsRenaming(false);
    },
  });

  const colorMutation = useMutation({
    mutationFn: (color: string) =>
      clientApi.updateCollection(collection.id, { color }),
    onMutate: async (newColor) => {
      await queryClient.cancelQueries({ queryKey: collectionsKey });
      const previousData = queryClient.getQueryData(collectionsKey);
      queryClient.setQueryData(collectionsKey, (old: { collections?: Collection[] } | undefined) => {
        if (!old?.collections) return old;
        return {
          ...old,
          collections: old.collections.map((c: Collection) =>
            c.id === collection.id ? { ...c, color: newColor } : c,
          ),
        };
      });
      return { previousData };
    },
    onError: (_err, _color, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(collectionsKey, context.previousData);
      }
      toast.error("Failed to recolour collection");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: collectionsKey });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => clientApi.deleteCollection(collection.id),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: collectionsKey });
      const previousData = queryClient.getQueryData(collectionsKey);
      queryClient.setQueryData(collectionsKey, (old: { collections?: Collection[] } | undefined) => {
        if (!old?.collections) return old;
        return {
          ...old,
          collections: old.collections.filter(
            (c: Collection) => c.id !== collection.id,
          ),
        };
      });
      return { previousData };
    },
    onError: (_err, _void, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(collectionsKey, context.previousData);
      }
      toast.error("Failed to delete collection");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: collectionsKey });
    },
    onSuccess: () => {
      setShowDeleteConfirm(false);
      toast.success("Collection deleted");
    },
  });

  function handleRenameKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      if (renameValue.trim() && renameValue !== collection.name) {
        renameMutation.mutate(renameValue.trim());
      } else {
        setIsRenaming(false);
      }
    } else if (e.key === "Escape") {
      setIsRenaming(false);
      setRenameValue(collection.name);
    }
  }

  function handleRenameBlur() {
    if (renameValue.trim() && renameValue !== collection.name) {
      renameMutation.mutate(renameValue.trim());
    } else {
      setIsRenaming(false);
      setRenameValue(collection.name);
    }
  }

  const dropHighlightClass =
    dropState === "valid"
      ? "ring-2 ring-primary ring-offset-1 bg-primary/5"
      : dropState === "already-in"
        ? "opacity-50"
        : "";

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger>
          <button
            ref={setNodeRef}
            onClick={() => {
              onSelect?.(collection.id);
              if (children.length > 0) toggleExpand(collection.id);
            }}
            className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-accent transition-colors ${
              isSelected ? "bg-accent font-medium" : ""
            } ${dropHighlightClass}`}
          >
            {children.length > 0 ? (
              isExpanded ? (
                <ChevronDown className="size-3.5 shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" />
              )
            ) : (
              <span className="w-3.5" />
            )}
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: collection.color }}
            />
            {isRenaming ? (
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={handleRenameBlur}
                className="h-6 px-1 py-0 text-xs"
                autoFocus
              />
            ) : (
              <span className="truncate">{collection.name}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {collection.page_count}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setIsRenaming(true)}>
            <Pencil className="size-4 mr-2" />
            Rename
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Palette className="size-4 mr-2" />
              Recolour
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <div className="grid grid-cols-5 gap-1 p-1">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    className={`size-6 rounded-full border-2 transition-transform hover:scale-110 ${
                      collection.color === color
                        ? "border-foreground"
                        : "border-transparent"
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => colorMutation.mutate(color)}
                  />
                ))}
              </div>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            onSelect={() => onRequestNewCollection?.(collection.id)}
          >
            <FolderPlus className="size-4 mr-2" />
            Add sub-collection
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onSelect={() => setShowDeleteConfirm(true)}
          >
            <Trash2 className="size-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded && children.length > 0 && (
        <div className="ml-4">
          {children.map((child) => (
            <TreeNode
              key={child.id}
              collection={child}
              allCollections={allCollections}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              selectedId={selectedId}
              onSelect={onSelect}
              onRequestNewCollection={onRequestNewCollection}
            />
          ))}
        </div>
      )}

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete collection?</DialogTitle>
            <DialogDescription>
              Pages will not be deleted — they are only removed from this
              collection.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type CollectionTreeProps = {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onRequestNewCollection: (parentId?: string) => void;
};

export function CollectionTree({
  selectedId,
  onSelect,
  onRequestNewCollection,
}: CollectionTreeProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const saved = localStorage.getItem("pp_expanded_collections");
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const qk = useQK();

  const { data } = useQuery({
    queryKey: qk("library", "collections"),
    queryFn: () => clientApi.listCollections(),
  });

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      try {
        localStorage.setItem(
          "pp_expanded_collections",
          JSON.stringify([...next]),
        );
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const collections = data?.collections ?? [];
  const rootCollections = collections.filter((c) => !c.parent_id);

  return (
    <div className="space-y-0.5">
      {rootCollections.map((collection) => (
        <TreeNode
          key={collection.id}
          collection={collection}
          allCollections={collections}
          expandedIds={expandedIds}
          toggleExpand={toggleExpand}
          selectedId={selectedId}
          onSelect={onSelect}
          onRequestNewCollection={onRequestNewCollection}
        />
      ))}
      {rootCollections.length === 0 && (
        <p className="px-2 py-4 text-xs text-muted-foreground text-center">
          No collections yet
        </p>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="w-full mt-2"
        onClick={() => onRequestNewCollection?.()}
      >
        <Plus className="size-3 mr-1" />
        New collection
      </Button>
    </div>
  );
}
