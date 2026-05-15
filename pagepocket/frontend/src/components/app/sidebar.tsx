"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clientApi } from "@/lib/client-api";
import { FolderOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { CollectionTree } from "@/components/app/collection-tree";
import { toast } from "sonner";
import { useQK } from "@/components/providers/query-provider";

export function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const qk = useQK();

  // Derive selected collection from URL
  const selectedId = pathname.match(/\/app\/collections\/([^/]+)/)?.[1];

  const onSelect = useCallback(
    (id: string) => {
      router.push(`/app/collections/${id}`);
    },
    [router],
  );

  // New collection dialog state (lifted from CollectionTree)
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");
  const [newParentId, setNewParentId] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: { name: string; color: string; parent_id?: string }) =>
      clientApi.createCollection(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk("library", "collections") });
      setShowNewDialog(false);
      setNewName("");
      toast.success("Collection created");
    },
    onError: () => {
      toast.error("Failed to create collection");
    },
  });

  const handleRequestNewCollection = useCallback((parentId?: string) => {
    setNewParentId(parentId ?? null);
    setNewName("");
    setNewColor("#3b82f6");
    setShowNewDialog(true);
  }, []);

  const isAllPagesActive = pathname === "/app";

  return (
    <>
      <aside className="hidden md:flex w-64 flex-col border-r border-border bg-card">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <Link href="/app" className="font-semibold text-lg">
            PagePocket
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New collection"
            onClick={() => handleRequestNewCollection()}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <nav className="flex-1 overflow-auto p-2">
          <Link
            href="/app"
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors ${
              isAllPagesActive ? "bg-accent font-medium" : ""
            }`}
          >
            <FolderOpen className="size-4" />
            All Pages
          </Link>
          <div className="mt-4">
            <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Collections
            </h3>
            <div className="mt-1 space-y-0.5">
              <CollectionTree
                selectedId={selectedId}
                onSelect={onSelect}
                onRequestNewCollection={handleRequestNewCollection}
              />
            </div>
          </div>
        </nav>
      </aside>

      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            {newParentId && (
              <DialogDescription>
                Will be created as a sub-collection.
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              placeholder="Collection name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground">Colour</label>
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                className="h-8 w-8 cursor-pointer rounded border border-border"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button
              onClick={() =>
                createMutation.mutate({
                  name: newName,
                  color: newColor,
                  ...(newParentId ? { parent_id: newParentId } : {}),
                })
              }
              disabled={!newName.trim() || createMutation.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
