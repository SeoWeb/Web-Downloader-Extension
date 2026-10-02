"use client";

import type { ReactNode } from "react";
import dynamic from "next/dynamic";

const AppDndProvider = dynamic(
  () => import("@/components/app/dnd-context").then((m) => m.AppDndProvider),
  { ssr: false },
);

export function ClientDndProvider({ children }: { children: ReactNode }) {
  return <AppDndProvider>{children}</AppDndProvider>;
}
