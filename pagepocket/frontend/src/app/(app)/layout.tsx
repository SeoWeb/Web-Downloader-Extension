import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getCurrentUserId } from "@/lib/auth/server-session";
import { QueryProvider } from "@/components/providers/query-provider";
import { AppSidebar } from "@/components/app/sidebar";
import { AppTopbar } from "@/components/app/topbar";
import { ClientDndProvider } from "@/components/app/client-dnd-provider";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const userId = await getCurrentUserId(await cookies());

  return (
    <QueryProvider userId={userId}>
      <ClientDndProvider>
        <div className="flex h-screen">
          <AppSidebar />
          <div className="flex flex-1 flex-col min-w-0">
            <AppTopbar />
            <main className="flex-1 overflow-auto p-6">{children}</main>
          </div>
        </div>
      </ClientDndProvider>
    </QueryProvider>
  );
}
