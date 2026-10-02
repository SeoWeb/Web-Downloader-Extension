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
      <div className="text-center space-y-4 max-w-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Icon className="size-6 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
        {allActions.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {allActions.map((a) =>
              a.href ? (
                <Button key={a.label} nativeButton={false} render={<Link href={a.href} />}>
                  {a.label}
                </Button>
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
