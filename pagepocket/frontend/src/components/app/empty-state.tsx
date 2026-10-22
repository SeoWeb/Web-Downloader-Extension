import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

type EmptyStateAction = {
  label: string;
  onClick?: () => void;
  href?: string;
};

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: EmptyStateAction;
  actions?: EmptyStateAction[];
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  actions,
}: EmptyStateProps) {
  const allActions = actions ?? (action ? [action] : []);

  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <div className="max-w-sm space-y-4 text-center">
        <div className="bg-muted mx-auto flex h-12 w-12 items-center justify-center rounded-full">
          <Icon className="text-muted-foreground size-6" />
        </div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-muted-foreground text-sm">{description}</p>
        {allActions.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {allActions.map((a) =>
              a.href ? (
                a.href.startsWith("http") ? (
                  // External destinations (e.g. the Chrome Web Store listing)
                  // open in a new tab via a plain anchor; internal routes keep
                  // next/link client-side navigation.
                  <Button
                    key={a.label}
                    nativeButton={false}
                    render={
                      <a
                        href={a.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                  >
                    {a.label}
                  </Button>
                ) : (
                  <Button
                    key={a.label}
                    nativeButton={false}
                    render={<Link href={a.href} />}
                  >
                    {a.label}
                  </Button>
                )
              ) : (
                <Button key={a.label} onClick={a.onClick}>
                  {a.label}
                </Button>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
