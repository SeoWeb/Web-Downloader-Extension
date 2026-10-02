import Link from "next/link";

export default function ShareNotFound() {
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <div className="text-center space-y-4">
        <h1 className="text-xl font-semibold">
          This link has expired or been revoked
        </h1>
        <p className="text-sm text-muted-foreground">
          The shared page is no longer available.
        </p>
        <Link
          href="/"
          className="text-sm text-primary hover:underline"
        >
          Go to PagePocket
        </Link>
      </div>
    </div>
  );
}
