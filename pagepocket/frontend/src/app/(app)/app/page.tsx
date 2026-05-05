import { Suspense } from "react";
import { archive } from "@/lib/api/archive";
import { Dashboard } from "@/components/app/dashboard";

export default async function AppPage() {
  const initialData = await archive.listPages({
    page: 1,
    page_size: 20,
    sort_by: "archived_at",
  });

  return (
    <Suspense>
      <Dashboard initialData={initialData} />
    </Suspense>
  );
}
