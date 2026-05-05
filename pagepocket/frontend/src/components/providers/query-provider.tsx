"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, createContext, useContext, useCallback, type ReactNode } from "react";

const UserIdContext = createContext<string | null>(null);

export function useUserId() {
  return useContext(UserIdContext);
}

export function useQK() {
  const userId = useContext(UserIdContext);
  return useCallback(
    (...keys: unknown[]) => (userId ? ["user", userId, ...keys] : keys),
    [userId],
  );
}

export function QueryProvider({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string | null;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <UserIdContext.Provider value={userId}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </UserIdContext.Provider>
  );
}
