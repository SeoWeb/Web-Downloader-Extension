import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PageResponse } from "@/lib/api/schemas";
import { PageResponseSchema } from "@/lib/api/schemas";

// Shared, observable next/navigation stubs: tests set `nav.params` before
// render (the ?format URL state) and assert `nav.replace` calls (the
// tab-switch write-back). Same mock shape dashboard.test.tsx uses, hoisted
// so the factory and the tests share one instance.
const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  params: new URLSearchParams(),
  pathname: "/app/pages/test-page-id",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: nav.replace,
    back: vi.fn(),
  }),
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.params,
}));

// Mock share dialog to avoid pulling in React Query provider
vi.mock("../share-dialog", () => ({
  ShareDialog: () => null,
}));

const { PageViewerShell } = await import("../page-viewer-shell");
const { PublicViewerShell } = await import("../public-viewer-shell");

// NOTE: no trailing Z — the shell renders `archived_at + "Z"` (UTC pin).
const BASE_PAGE = {
  id: "test-page-id",
  user_id: "user-1",
  url: "https://example.com/article",
  title: "Example Article",
  archived_at: "2026-10-01T12:00:00",
};

function makePageMeta(contentFormats: string[]): PageResponse {
  return PageResponseSchema.parse({
    ...BASE_PAGE,
    content_formats: contentFormats,
  });
}

const MD_URL = "/api/pp/archive/pages/test-page-id/f/index.md";
const TXT_URL = "/api/pp/archive/pages/test-page-id/f/index.txt";
const SHARE_MD_URL = "/api/sc/tok/index.md";

const MARKDOWN_SOURCE = [
  "# Saved Document",
  "",
  "A **stored** paragraph.",
  "",
  "- one",
  "- two",
].join("\n");

const PLAIN_TEXT = "Saved plain text\nwith a second line.";

// Static, mocked serving routes (text-native-downloads): no live API — the
// BFF file routes are answerable purely from the requested URL.
const FILE_BODIES: Record<string, string> = {
  [MD_URL]: MARKDOWN_SOURCE,
  [TXT_URL]: PLAIN_TEXT,
  [SHARE_MD_URL]: MARKDOWN_SOURCE,
};

async function serveStoredFiles(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : String(input);
  const body = FILE_BODIES[url];
  if (body === undefined) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

const fetchMock = vi.fn(serveStoredFiles);

beforeEach(() => {
  // mockReset (not mockClear): implementations set inside a test (hostile
  // document, 500s) must not leak into later tests.
  fetchMock.mockReset();
  fetchMock.mockImplementation(serveStoredFiles);
  vi.stubGlobal("fetch", fetchMock);
  // Fresh URL state per test: no ?format param, default pathname.
  nav.replace.mockClear();
  nav.params = new URLSearchParams();
  nav.pathname = "/app/pages/test-page-id";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PageViewerShell format switcher", () => {
  it("renders HTML | Markdown | Text tabs with HTML default (canonically ordered)", async () => {
    // Stored order deliberately non-canonical: the switcher must reorder.
    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["text", "markdown", "html"])}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent("HTML");
    expect(tabs[1]).toHaveTextContent("Markdown");
    expect(tabs[2]).toHaveTextContent("Text");

    // HTML tab is the default and the sandboxed iframe serves index.html.
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    const iframe = screen.getByTitle("Saved page content");
    expect(iframe).toHaveAttribute(
      "src",
      "/api/pp/archive/pages/test-page-id/f/index.html",
    );
    expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-forms");
    // Text documents are fetched lazily — never up front.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("switches to rendered markdown (fetched from /f/index.md) with a Raw toggle", async () => {
    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown"])}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Markdown" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Saved Document" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/stored/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      MD_URL,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(
      screen.getByRole("button", { name: "Show raw markdown source" }),
    ).toBeInTheDocument();
  });

  it("Raw toggle shows the markdown source in a pre and switches back", async () => {
    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown"])}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    await screen.findByRole("heading", { level: 1 });

    await userEvent.click(
      screen.getByRole("button", { name: "Show raw markdown source" }),
    );
    const pre = screen.getByText((_, element) => element?.tagName === "PRE");
    expect(pre).toHaveTextContent("# Saved Document");
    expect(
      screen.getByRole("button", { name: "Show rendered markdown" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Show rendered markdown" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Saved Document" }),
    ).toBeInTheDocument();
  });

  it("renders embedded <script> in markdown inert (no injection) while Raw shows the source", async () => {
    const hostile =
      '# Hi\n\n<script>window.__ppPwned = true;</script>\n\n<img src=x onerror="window.__ppPwned = true;">';

    // Serve the hostile document BEFORE rendering (the pane fetches on mount).
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      return new Response(url === MD_URL ? hostile : "Not found", {
        status: url === MD_URL ? 200 : 404,
      });
    });

    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["markdown"])}
      />,
    );
    // Single known format → no switcher chrome, markdown rendered directly.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Saved page content")).not.toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Hi" }),
    ).toBeInTheDocument();
    // Nothing injected: no script/img elements exist and no handler ran.
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect((window as { __ppPwned?: boolean }).__ppPwned).toBeUndefined();
    // The raw HTML is escaped into inert TEXT (react-markdown default) —
    // visible as source characters, never parsed as markup.
    expect(screen.getByText(/__ppPwned/).tagName).not.toBe("SCRIPT");

    // The raw toggle reveals the original source verbatim (escaped, inert pre).
    await userEvent.click(
      screen.getByRole("button", { name: "Show raw markdown source" }),
    );
    const pre = screen.getByText((_, element) => element?.tagName === "PRE");
    expect(pre).toHaveTextContent("<script>window.__ppPwned = true;</script>");
    expect((window as { __ppPwned?: boolean }).__ppPwned).toBeUndefined();
  });

  it("renders a text-only page as styled plain text with no switcher", async () => {
    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["text"])}
      />,
    );

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const pre = await screen.findByText(
      (_, element) => element?.tagName === "PRE",
    );
    // toHaveTextContent normalizes whitespace — assert the lines separately.
    expect(pre).toHaveTextContent("Saved plain text");
    expect(pre).toHaveTextContent("with a second line.");
    expect(fetchMock).toHaveBeenCalledWith(TXT_URL, expect.anything());
    expect(screen.queryByTitle("Saved page content")).not.toBeInTheDocument();
  });

  it("markdown tab failure shows an error with retry (viewer error pattern)", async () => {
    fetchMock.mockImplementation(
      async () => new Response("boom", { status: 500 }),
    );

    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown"])}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Markdown" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This document could not be loaded.",
    );

    // Restore the happy path and retry — the document loads.
    fetchMock.mockImplementation(serveStoredFiles);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Saved Document" }),
    ).toBeInTheDocument();
  });

  it("legacy html-only page renders the bare iframe with no switcher chrome", () => {
    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html"])}
      />,
    );

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const iframe = screen.getByTitle("Saved page content");
    expect(iframe).toHaveAttribute(
      "src",
      "/api/pp/archive/pages/test-page-id/f/index.html",
    );
    expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-forms");
    expect(iframe).toHaveClass("w-full flex-1 border-0");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("URL-backed active format (?format param)", () => {
  it("opens on the ?format tab when it names a present format (back/forward restore)", async () => {
    nav.params = new URLSearchParams("format=markdown");

    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown"])}
      />,
    );

    // Markdown is active straight from the URL — not the HTML default.
    expect(screen.getByRole("tab", { name: "Markdown" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    // The restored tab lazily fetches its document, same as a click.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Saved Document" }),
    ).toBeInTheDocument();
    // Reading state is derived from the URL — mounting never writes it.
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("writes a tab switch back to the URL with replace and no scroll", async () => {
    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown", "text"])}
      />,
    );

    await userEvent.click(screen.getByRole("tab", { name: "Text" }));

    // replace (not push): switching tabs must not create a history entry,
    // and { scroll: false } must not jump the viewport.
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith(
      "/app/pages/test-page-id?format=text",
      { scroll: false },
    );
  });

  it("ignores an unknown ?format value and keeps the HTML default without writing the URL", () => {
    nav.params = new URLSearchParams("format=evil");

    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown"])}
      />,
    );

    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("ignores ?format naming a format this page does not have", () => {
    nav.params = new URLSearchParams("format=text");

    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown"])}
      />,
    );

    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("with no param, HTML stays the default and the URL is untouched on mount", () => {
    render(
      <PageViewerShell
        pageId="test-page-id"
        pageMeta={makePageMeta(["html", "markdown", "text"])}
      />,
    );

    expect(screen.getByRole("tab", { name: "HTML" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe("PublicViewerShell share parity", () => {
  it("offers the same switcher with the same defaults and share-route URLs", async () => {
    render(
      <PublicViewerShell token="tok" formats={["markdown", "html", "text"]} />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "HTML",
      "Markdown",
      "Text",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTitle("Shared page content")).toHaveAttribute(
      "src",
      "/api/sc/tok/index.html",
    );

    await userEvent.click(screen.getByRole("tab", { name: "Markdown" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Saved Document" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(SHARE_MD_URL, expect.anything());
    expect(
      screen.getByRole("button", { name: "Show raw markdown source" }),
    ).toBeInTheDocument();
  });

  it("renders a markdown-only shared page directly with no HTML tab", async () => {
    render(<PublicViewerShell token="tok" formats={["markdown"]} />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Saved Document" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(SHARE_MD_URL, expect.anything());
  });

  it("legacy share (no formats) keeps the bare iframe", async () => {
    render(<PublicViewerShell token="tok" />);

    // The share-side gallery probe (image gallery feature) hits the images
    // route once; the stub's 404 degrades to today's bare iframe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sc/tok/images");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    const iframe = await screen.findByTitle("Shared page content");
    expect(iframe).toHaveAttribute("src", "/api/sc/tok/index.html");
    expect(iframe).toHaveAttribute("sandbox", "allow-popups allow-forms");
  });

  it("honors the same ?format param on the share route (viewer parity)", async () => {
    nav.params = new URLSearchParams("format=markdown");
    nav.pathname = "/s/tok";

    render(<PublicViewerShell token="tok" formats={["markdown", "html"]} />);

    expect(screen.getByRole("tab", { name: "Markdown" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Saved Document" }),
    ).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();

    // Switching writes the share route's URL with the same replace contract.
    await userEvent.click(screen.getByRole("tab", { name: "HTML" }));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith("/s/tok?format=html", {
      scroll: false,
    });
  });
});
