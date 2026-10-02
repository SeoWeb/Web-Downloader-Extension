"use client";

import { Search, LogOut, User } from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { clientApi } from "@/lib/client-api";
import { useQK } from "@/components/providers/query-provider";
import { useState, useEffect, useRef } from "react";

export function AppTopbar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const qk = useQK();
  const searchParams = useSearchParams();
  const currentQ = searchParams.get("q") ?? "";

  const [searchValue, setSearchValue] = useState(currentQ);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchValue(currentQ);
  }, [currentQ]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(searchValue), 250);
    return () => clearTimeout(timer);
  }, [searchValue]);

  const { data: previewData } = useQuery({
    queryKey: qk("search-preview", debouncedQ),
    queryFn: () => clientApi.search({ q: debouncedQ, page_size: 5 }),
    enabled: debouncedQ.length >= 3 && showPreview,
  });

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowPreview(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  async function handleLogout() {
    await fetch("/api/session", { method: "DELETE" });
    queryClient.clear();
    router.push("/");
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-4">
      <div className="relative flex items-center gap-2 max-w-md" ref={containerRef}>
        <Search className="size-4 text-muted-foreground" />
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (searchValue.trim()) {
              router.push(
                `/app/search?q=${encodeURIComponent(searchValue.trim())}`,
              );
              setShowPreview(false);
            }
          }}
        >
          <input
            name="q"
            type="search"
            value={searchValue}
            onChange={(e) => {
              setSearchValue(e.target.value);
              setShowPreview(true);
            }}
            onFocus={() => {
              if (searchValue.length >= 3) setShowPreview(true);
            }}
            onBlur={() => {
              setTimeout(() => setShowPreview(false), 150);
            }}
            placeholder="Search pages..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </form>
        {showPreview && previewData && previewData.results.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-popover shadow-lg z-50 overflow-hidden">
            {previewData.results.map((result) => (
              <button
                key={result.page_id}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => {
                  e.preventDefault();
                  router.push(`/app/pages/${result.page_id}`);
                  setShowPreview(false);
                }}
              >
                <Search className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{result.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground dark:hover:bg-muted/50"
            aria-label="User menu"
          >
            <User className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="size-4 mr-2" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
