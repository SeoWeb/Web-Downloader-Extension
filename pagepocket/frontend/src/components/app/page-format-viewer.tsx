"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { Code, Eye, FileText, Globe, RefreshCw, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ContentFormat } from "@/lib/content-formats";

// Nested sandbox intersection (defense in depth, archived-html-serving) —
// single source of truth shared by the dashboard viewer, the public share
// viewer, and every format tab below. The serving routes (/api/pp/archive/
// pages/*/f/*, /api/sc/*, backed by the gateway's /f/* routes) already
// respond with `Content-Security-Policy: sandbox allow-popups allow-forms`;
// this iframe attribute is the second, independent layer. The browser
// enforces the STRICTER of the two, so neither layer can relax the other:
// - NO `allow-same-origin` here (and none in the CSP): the archived document
//   is a unique opaque origin — even a script that somehow executes gets no
//   access to pagepocket.app cookies, storage, or DOM.
// - `allow-popups` / `allow-forms` still work: window.open links and form
//   controls inside the archived page keep functioning as captured.
// - Scripts never run: `allow-scripts` is granted by neither layer.
export const IFRAME_SANDBOX = "allow-popups allow-forms";

type PageFormatViewerProps = {
  /** Known formats for the page, already filtered to canonical order. */
  formats: ContentFormat[];
  /** Archive-relative file URL per format (viewer fetches text lazily). */
  fileUrls: Record<ContentFormat, string>;
  /** Accessible title of the sandboxed HTML iframe. */
  iframeTitle?: string;
};

const FORMAT_META: Record<
  ContentFormat,
  { label: string; icon: typeof Globe }
> = {
  html: { label: "HTML", icon: Globe },
  markdown: { label: "Markdown", icon: FileText },
  text: { label: "Text", icon: Type },
};

type FileTextState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; text: string };

/**
 * Fetch a stored text document (index.md / index.txt) on demand — the
 * viewer's plain-fetch + useState data pattern (see handleDelete in
 * page-viewer-shell): no react-query dependency, works identically in the
 * provider-less public share viewer.
 */
function useFileText(url: string): { state: FileTextState; retry: () => void } {
  const [state, setState] = useState<FileTextState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        if (!cancelled) {
          setState({ status: "ready", text });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, attempt]);

  return { state, retry };
}

function PaneSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading content"
      className="mx-auto w-full max-w-3xl space-y-3 px-6 py-6"
    >
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-4 w-4/6" />
    </div>
  );
}

function PaneError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-muted-foreground text-sm">
        This document could not be loaded.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw data-icon="inline-start" />
        Retry
      </Button>
    </div>
  );
}

/**
 * Rendered markdown (D6). react-markdown renders embedded raw HTML as inert
 * ESCAPED TEXT by default (no rehype-raw): a `<script>` in the stored
 * document never becomes an element — the source is only ever shown
 * verbatim through the Raw toggle's `<pre>`.
 */
function MarkdownPane({ fileUrl }: { fileUrl: string }) {
  const [raw, setRaw] = useState(false);
  const { state, retry } = useFileText(fileUrl);

  if (state.status === "loading") {
    return <PaneSkeleton />;
  }
  if (state.status === "error") {
    return <PaneError onRetry={retry} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end px-4 pt-2">
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={raw}
          aria-label={
            raw ? "Show rendered markdown" : "Show raw markdown source"
          }
          onClick={() => setRaw((current) => !current)}
        >
          {raw ? (
            <Eye data-icon="inline-start" />
          ) : (
            <Code data-icon="inline-start" />
          )}
          {raw ? "Rendered" : "Raw"}
        </Button>
      </div>
      {raw ? (
        <pre className="mx-auto w-full max-w-3xl flex-1 px-6 py-4 font-mono text-sm break-words whitespace-pre-wrap">
          {state.text}
        </pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="markdown-viewer mx-auto w-full max-w-3xl px-6 py-4">
            <ReactMarkdown>{state.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

/** Styled plain text (D6) — preserved whitespace, no interpretation. */
function TextPane({ fileUrl }: { fileUrl: string }) {
  const { state, retry } = useFileText(fileUrl);

  if (state.status === "loading") {
    return <PaneSkeleton />;
  }
  if (state.status === "error") {
    return <PaneError onRetry={retry} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <pre className="text-foreground/90 mx-auto w-full max-w-3xl px-6 py-4 font-mono text-sm break-words whitespace-pre-wrap">
        {state.text}
      </pre>
    </div>
  );
}

function FormatPane({
  format,
  fileUrls,
  iframeTitle,
}: {
  format: ContentFormat;
  fileUrls: Record<ContentFormat, string>;
  iframeTitle: string;
}) {
  if (format === "html") {
    return (
      <iframe
        src={fileUrls.html}
        sandbox={IFRAME_SANDBOX}
        className="h-full w-full border-0"
        title={iframeTitle}
      />
    );
  }
  if (format === "markdown") {
    return <MarkdownPane fileUrl={fileUrls.markdown} />;
  }
  return <TextPane fileUrl={fileUrls.text} />;
}

/**
 * Content area for pages with at least one non-HTML format (D6):
 * - exactly one known format → rendered directly, no switcher chrome;
 * - several → the HTML | Markdown | Text segmented control, defaulting to
 *   HTML when present else the first known format, overridden by a valid
 *   ?format URL param. Switches are written back to the URL (router.replace,
 *   no history entry) so back/forward restores the tab the user was on.
 * Legacy pages (html-only / unknown) never reach this component — callers
 * render the bare iframe for them.
 */
export function PageFormatViewer({
  formats,
  fileUrls,
  iframeTitle = "Saved page content",
}: PageFormatViewerProps) {
  // The active tab is URL state (?format=<value>), mirroring the dashboard's
  // ?sort_by pattern: the viewer segment remounts on back/forward, so the
  // active format must be derivable from the URL alone or every return to
  // the page resets the switcher to HTML. Hooks run unconditionally (single
  // -format pages return early below, never reading or writing the param).
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (formats.length === 1) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <FormatPane
          format={formats[0]!}
          fileUrls={fileUrls}
          iframeTitle={iframeTitle}
        />
      </div>
    );
  }

  // Initial tab: the ?format param when it names a known format present for
  // this page; invalid/unknown values (or its absence) fall back to HTML
  // when present, else the first known format.
  const requested = searchParams.get("format");
  const defaultFormat =
    requested && formats.includes(requested as ContentFormat)
      ? (requested as ContentFormat)
      : formats.includes("html")
        ? "html"
        : formats[0]!;

  // Mirror a tab switch into the URL with replace (no history entry, no
  // scroll): back leaves the page entirely, forward re-mounts it already on
  // the format the user was reading. Other params, if any, are preserved.
  function handleFormatChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("format", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <Tabs
      defaultValue={defaultFormat}
      onValueChange={handleFormatChange}
      className="min-h-0 flex-1 gap-0"
      aria-label="Saved formats"
    >
      <div className="border-border border-b px-4 py-1.5">
        <TabsList aria-label="Content format">
          {formats.map((format) => {
            const { label, icon: Icon } = FORMAT_META[format];
            return (
              <TabsTrigger key={format} value={format} className="px-3">
                <Icon data-icon="inline-start" className="size-3.5" />
                {label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      {formats.map((format) => (
        <TabsContent
          key={format}
          value={format}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <FormatPane
            format={format}
            fileUrls={fileUrls}
            iframeTitle={iframeTitle}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
