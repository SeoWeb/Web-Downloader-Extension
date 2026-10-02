"use client";

import { useParams } from "next/navigation";
import { Dashboard } from "@/components/app/dashboard";

export default function CollectionPage() {
  const { id } = useParams<{ id: string }>();
  return <Dashboard key={id} collectionId={id} />;
}
