"use client";

import { useState, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { clientApi } from "@/lib/client-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Copy, Link2, Trash2, CalendarIcon } from "lucide-react";
import { toast } from "sonner";
import { useQK } from "@/components/providers/query-provider";
import { format } from "date-fns";

type ShareDialogProps = {
  pageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function resolveShareUrl(link: { short_url?: string; token: string } | undefined): string {
  if (!link) return "";
  return link.short_url || `${window.location.origin}/s/${link.token}`;
}

export function ShareDialog({ pageId, open, onOpenChange }: ShareDialogProps) {
  const [isPublic, setIsPublic] = useState(true);
  const [expiry, setExpiry] = useState("never");
  const [customDate, setCustomDate] = useState<Date | undefined>();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const manualInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const qk = useQK();

  const { data: existingLink } = useQuery({
    queryKey: qk("share", "link", pageId),
    queryFn: () => clientApi.getLink(pageId),
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: () => {
      let expiresAt: string | null = null;
      const now = Date.now();
      if (expiry === "24h") expiresAt = new Date(now + 86400000).toISOString();
      else if (expiry === "7d") expiresAt = new Date(now + 7 * 86400000).toISOString();
      else if (expiry === "30d") expiresAt = new Date(now + 30 * 86400000).toISOString();
      else if (expiry === "custom" && customDate) {
        const d = new Date(customDate);
        d.setHours(23, 59, 59, 999);
        expiresAt = d.toISOString();
      }

      return clientApi.createLink({
        page_id: pageId,
        is_public: isPublic,
        expires_at: expiresAt,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk("share", "link", pageId) });
      toast.success("Share link created");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => {
      if (!existingLink?.token) throw new Error("No link to revoke");
      return clientApi.revokeLink(existingLink.token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qk("share", "link", pageId) });
      toast.success("Share link revoked");
    },
  });

  const shareUrl = resolveShareUrl(existingLink);

  const copyLink = useCallback(async () => {
    const url = resolveShareUrl(existingLink);
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch {
      // Fallback: select text in a temporary input
      const input = document.createElement("input");
      input.value = url;
      input.setAttribute("readonly", "");
      input.style.cssText = "position:fixed;left:-9999px;opacity:0";
      document.body.appendChild(input);
      input.select();
      try {
        document.execCommand("copy");
        toast.success("Link copied to clipboard");
        document.body.removeChild(input);
      } catch {
        // Total failure: show the URL for manual copy
        if (manualInputRef.current) {
          manualInputRef.current.value = url;
          manualInputRef.current.style.cssText =
            "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;width:400px;padding:8px;border:2px solid;border-radius:4px;font-size:14px";
          manualInputRef.current.select();
        }
        toast.error("Could not copy — select and copy manually");
      }
    }
  }, [existingLink]);

  const hasActiveLink = !!existingLink?.token;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share page</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="public-toggle">Public link</Label>
            <Switch
              id="public-toggle"
              checked={isPublic}
              onCheckedChange={setIsPublic}
            />
          </div>

          <div className="space-y-2">
            <Label>Expires</Label>
            {expiry === "custom" && !hasActiveLink ? (
              <div className="flex items-center gap-2">
                <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                  <PopoverTrigger
                    render={(props: React.ComponentPropsWithoutRef<"button">) => (
                      <button
                        {...props}
                        className="flex-1 inline-flex items-center justify-start rounded-md border border-input bg-background px-4 py-2 text-sm font-normal ring-offset-background hover:bg-accent hover:text-accent-foreground"
                      >
                        <CalendarIcon className="mr-2 size-4" />
                        {customDate ? format(customDate, "PPP") : "Pick a date"}
                      </button>
                    )}
                  />
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={customDate}
                      onSelect={(d) => {
                        setCustomDate(d ?? undefined);
                        setCalendarOpen(false);
                      }}
                      disabled={{ before: new Date() }}
                    />
                  </PopoverContent>
                </Popover>
                <Button variant="ghost" size="sm" onClick={() => setExpiry("never")}>
                  Clear
                </Button>
              </div>
            ) : (
              <Select
                value={expiry}
                onValueChange={(v) => { if (v) setExpiry(v); }}
                disabled={hasActiveLink}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never</SelectItem>
                  <SelectItem value="24h">24 hours</SelectItem>
                  <SelectItem value="7d">7 days</SelectItem>
                  <SelectItem value="30d">30 days</SelectItem>
                  <SelectItem value="custom">Custom date</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>

          {hasActiveLink ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted p-3">
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm truncate">
                  {shareUrl}
                </span>
              </div>
              {existingLink.view_count !== undefined && (
                <p className="text-xs text-muted-foreground">
                  {existingLink.view_count} view{existingLink.view_count !== 1 ? "s" : ""}
                </p>
              )}
              <div className="flex gap-2">
                <Button onClick={copyLink} className="flex-1">
                  <Copy className="size-4 mr-2" />
                  Copy link
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (confirm("Revoke this share link?")) {
                      revokeMutation.mutate();
                    }
                  }}
                  disabled={revokeMutation.isPending}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending || (expiry === "custom" && !customDate)}
              className="w-full"
            >
              Create share link
            </Button>
          )}
        </div>
        {/* Hidden input for manual-copy fallback */}
        <input ref={manualInputRef} readOnly className="sr-only" />
      </DialogContent>
    </Dialog>
  );
}
