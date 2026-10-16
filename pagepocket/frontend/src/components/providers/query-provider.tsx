"use client";

import {
  QueryCache,
  QueryClient,
  MutationCache,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useRef, useState, createContext, useContext, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AuthenticationError } from "@/lib/api/errors";

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

/**
 * Global 401 handling (pagepocket-frontend-auth): a definitive
 * AuthenticationError on an authenticated surface means the session is gone —
 * clear all cached session state and send the user to /login instead of
 * leaving a zombie dashboard mounted. Public surfaces (the /s/* share
 * viewers, marketing pages) are never hijacked.
 */
export function shouldRedirectOnAuthError(error: unknown, pathname: string): boolean {
  if (!(error instanceof AuthenticationError)) return false;
  return pathname.startsWith("/app");
}

export function QueryProvider({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string | null;
}) {
  const router = useRouter();
  const handleAuthErrorRef = useRef<(error: unknown) => void>(() => {});

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: true,
          },
        },
        queryCache: new QueryCache({
          onError: (error) => handleAuthErrorRef.current(error),
        }),
        mutationCache: new MutationCache({
          onError: (error) => handleAuthErrorRef.current(error),
        }),
      }),
  );

  handleAuthErrorRef.current = (error) => {
    if (typeof window === "undefined") return;
    if (!shouldRedirectOnAuthError(error, window.location.pathname)) return;
    queryClient.clear();
    const redirect = encodeURIComponent(
      `${window.location.pathname}${window.location.search}`,
    );
    router.push(`/login?redirect=${redirect}`);
  };

  return (
    <UserIdContext.Provider value={userId}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </UserIdContext.Provider>
  );
}
