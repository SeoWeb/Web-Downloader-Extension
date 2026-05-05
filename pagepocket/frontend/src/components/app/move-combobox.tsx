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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import { useQK } from "@/components/providers/query-provider";
import { useEffect, useRef } from "react";

type MoveComboboxProps = {
  pageId: string;
  currentCollectionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MoveCombobox({
  pageId,
  currentCollectionId,
  open,
  onOpenChange,
}: MoveComboboxProps) {
  const queryClient = useQueryClient();
  const qk = useQK();
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  // Auto-focus the search input when the popover opens
  useEffect(() => {
    if (open) {
      // Let the popover render, then focus the command input
      requestAnimationFrame(() => {
        const input = triggerRef.current
          ?.closest("[data-slot='popover']")
          ?.querySelector("input");
        input?.focus();
      });
    }
  }, [open]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger ref={triggerRef} className="sr-only" />
      <PopoverContent className="p-0 w-64" side="bottom" align="start">
        <Command>
          <CommandInput placeholder="Search collections..." autoFocus />
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
      </PopoverContent>
    </Popover>
  );
}
