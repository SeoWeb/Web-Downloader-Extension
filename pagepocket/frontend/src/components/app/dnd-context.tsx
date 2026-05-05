"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  DndContext as DndKitContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clientApi } from "@/lib/client-api";
import { toast } from "sonner";
import { useQK } from "@/components/providers/query-provider";

type DragData = {
  pageId: string;
  pageTitle: string;
  collectionId: string | null;
};

type DndContextValue = {
  activeDrag: DragData | null;
  overId: string | null;
};

const DndContext = createContext<DndContextValue>({
  activeDrag: null,
  overId: null,
});

export function useDndContext() {
  return useContext(DndContext);
}

export function AppDndProvider({ children }: { children: ReactNode }) {
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const qk = useQK();

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 5 },
  });
  const keyboardSensor = useSensor(KeyboardSensor);
  const sensors = useSensors(pointerSensor, keyboardSensor);

  const moveMutation = useMutation({
    mutationFn: ({
      collectionId,
      pageId,
    }: {
      collectionId: string;
      pageId: string;
    }) => clientApi.addPageToCollection(collectionId, pageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk("archive", "listPages") });
      queryClient.invalidateQueries({ queryKey: qk("library", "collections") });
    },
  });

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined;
    if (data) {
      setActiveDrag(data);
    }
  }, []);

  const handleDragOver = useCallback((event: { over: { id: string | number } | null }) => {
    setOverId(event.over ? String(event.over.id) : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = event.active.data.current as DragData | undefined;
      const targetId = event.over?.id;

      setActiveDrag(null);
      setOverId(null);

      if (!data || !targetId) return;

      const collectionId = String(targetId);
      if (collectionId === data.collectionId) return;

      moveMutation.mutate(
        { collectionId, pageId: data.pageId },
        {
          onSuccess: () => {
            toast.success(`Moved to collection`, {
              action: {
                label: "Undo",
                onClick: () => {
                  clientApi
                    .removePageFromCollection(collectionId, data.pageId)
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
        },
      );
    },
    [moveMutation, queryClient, qk],
  );

  const handleDragCancel = useCallback(() => {
    setActiveDrag(null);
    setOverId(null);
  }, []);

  return (
    <DndKitContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <DndContext.Provider value={{ activeDrag, overId }}>
        {children}
        <DragOverlay>
          {activeDrag ? (
            <div className="rounded-lg border border-primary bg-card p-3 shadow-lg opacity-90 max-w-xs">
              <p className="text-sm font-medium truncate">
                {activeDrag.pageTitle}
              </p>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext.Provider>
    </DndKitContext>
  );
}
