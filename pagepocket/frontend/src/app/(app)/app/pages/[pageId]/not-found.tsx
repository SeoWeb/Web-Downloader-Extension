import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This saved page doesn&apos;t exist or has been deleted.
        </p>
        <Link
          href="/app"
          className="text-sm text-primary hover:underline"
        >
          Back to library
        </Link>
      </div>
    </div>
  );
}
