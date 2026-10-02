"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { clientApi } from "@/lib/client-api";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useQK } from "@/components/providers/query-provider";

type MoveDialogProps = {
  pageId: string;
  currentCollectionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MoveDialog({
  pageId,
  currentCollectionId,
  open,
  onOpenChange,
}: MoveDialogProps) {
  const queryClient = useQueryClient();
  const qk = useQK();

  const { data } = useQuery({
    queryKey: qk("library", "collections"),
    queryFn: () => clientApi.listCollections(),
    enabled: open,
  });

  const moveMutation = useMutation({
    mutationFn: ({
      collectionId,
      pageId: pid,
    }: {
      collectionId: string;
      pageId: string;
    }) => clientApi.addPageToCollection(collectionId, pid),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: qk("archive", "listPages") });
      queryClient.invalidateQueries({ queryKey: qk("library", "collections") });
      onOpenChange(false);
      toast.success("Moved to collection", {
        action: {
          label: "Undo",
          onClick: () => {
            clientApi
              .removePageFromCollection(
                variables.collectionId,
                variables.pageId,
              )
              .then(() => {
                queryClient.invalidateQueries({
                  queryKey: qk("archive", "listPages"),
                });
                queryClient.invalidateQueries({
                  queryKey: qk("library", "collections"),
                });
                toast.success("Move undone");
              });
          },
        },
      });
    },
    onError: () => {
      toast.error("Failed to move page");
    },
  });

  const collections = data?.collections ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 w-64">
        <DialogHeader className="sr-only">
          <DialogTitle>Move to collection</DialogTitle>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="Search collections..." />
          <CommandList>
            <CommandEmpty>No collections found.</CommandEmpty>
            <CommandGroup>
              {collections.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  disabled={c.id === currentCollectionId}
                  onSelect={() => {
                    if (c.id !== currentCollectionId) {
                      moveMutation.mutate({ collectionId: c.id, pageId });
                    }
                  }}
                  className={c.id === currentCollectionId ? "opacity-50" : ""}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full mr-2"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="truncate">{c.name}</span>
                  {c.id === currentCollectionId && (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Current
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

