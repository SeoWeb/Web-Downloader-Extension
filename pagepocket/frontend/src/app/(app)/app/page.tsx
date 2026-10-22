import { Suspense } from "react";
import { archive } from "@/lib/api/archive";
import { Dashboard } from "@/components/app/dashboard";
import type { ListPagesResponse } from "@/lib/api/schemas";

// SSR hydration fetch for the dashboard must never break the render: with an
// expired pp_access cookie but a valid pp_refresh, src/proxy.ts deliberately
// passes the request through, the stale bearer token 401s, and the /api/pp
// proxy silently refreshes the session client-side instead. So on ANY SSR
// failure (401, network, gateway 5xx) hand the unhydrated Dashboard to the
// client — its query fetches through the refreshing proxy — rather than
// tripping (app)/app/error.tsx. Same graceful shape as archive.getPage.
export async function loadInitialPages(): Promise<
  ListPagesResponse | undefined
> {
  try {
    return await archive.listPages({
      page: 1,
      page_size: 20,
      sort_by: "archived_at",
    });
  } catch (error) {
    console.error(
      "[app] initial page list fetch failed, falling back to client fetch",
      error,
    );
    return undefined;
  }
}

export default async function AppPage() {
  const initialData = await loadInitialPages();

  return (
    <Suspense>
      <Dashboard initialData={initialData} />
    </Suspense>
  );
}
