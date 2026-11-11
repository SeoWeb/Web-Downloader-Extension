import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageResponseSchema, type PageResponse } from "@/lib/api/schemas";

// Shared, observable next/navigation stub (same shape as
// page-format-viewer.test.tsx). replace() also APPLIES the new query to
// nav.params — Next updates useSearchParams in place on a same-route
// replace, and the subpage selection is derived from the URL alone, so the
// pane swap the tests observe below is the production data flow.
const nav = vi.hoisted(() => ({
  replace: vi.fn((url: string) => {
    nav.params = new URLSearchParams(url.split("?")[1] ?? "");
  }),
  push: vi.fn(),
  params: new URLSearchParams(),
  pathname: "/app/pages/test-page-id",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: nav.push,
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

vi.mock("@/lib/client-api", () => ({
  clientApi: {
    listPageImages: vi.fn(),
  },
}));

const { PageViewerShell } = await import("../page-viewer-shell");
const { PublicViewerShell } = await import("../public-viewer-shell");

const BASE_PAGE = {
  id: "test-page-id",
  user_id: "user-1",
  url: "https://example.com/article",
  title: "Example Article",
  archived_at: "2026-10-01T12:00:00",
};

// Manifest shape the gateway emits (multipage-download-fixes D7): linked
// pages under pages/, titles from <title>, "" when nothing was captured.
const MANIFEST = [
  {
    path: "about.md",
    title: "About",
    url: "https://example.com/about",
    content_format: "markdown",
  },
  {
    path: "docs/notes.txt",
    title: "Notes",
    url: "https://example.com/docs/notes",
    content_format: "text",
  },
  {
    path: "hash-fallback.txt",
    title: "",
    url: "",
    content_format: "text",
  },
];

function makePageMeta(
  contentFormats: string[],
  pages?: typeof MANIFEST,
): PageResponse {
  return PageResponseSchema.parse({
    ...BASE_PAGE,
    content_formats: contentFormats,
    ...(pages ? { pages } : {}),
  });
}

const MAIN_MD_URL = "/api/pp/archive/pages/test-page-id/f/index.md";
const ABOUT_URL = "/api/pp/archive/pages/test-page-id/f/pages/about.md";
const NOTES_URL = "/api/pp/archive/pages/test-page-id/f/pages/docs/notes.txt";
const FALLBACK_URL =
  "/api/pp/archive/pages/test-page-id/f/pages/hash-fallback.txt";
const SHARE_ABOUT_URL = "/api/sc/tok/pages/about.md";

const MAIN_MARKDOWN = "# Main Document\n\nMain body.";
const ABOUT_MARKDOWN = "# About Page\n\nSubpage body.";
const NOTES_TEXT = "Subpage notes text.";
const FALLBACK_TEXT = "Hash fallback text.";

// Static, mocked serving routes: no live API — the BFF file routes are
// answerable purely from the requested URL (same convention as
// page-format-viewer.test.tsx).
const FILE_BODIES: Record<string, string> = {
  [MAIN_MD_URL]: MAIN_MARKDOWN,
  "/api/pp/archive/pages/test-page-id/f/index.txt": "Main body.\nSecond line.",
  [ABOUT_URL]: ABOUT_MARKDOWN,
  [NOTES_URL]: NOTES_TEXT,
  [FALLBACK_URL]: FALLBACK_TEXT,
  "/api/sc/tok/index.md": MAIN_MARKDOWN,
  [SHARE_ABOUT_URL]: ABOUT_MARKDOWN,
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
  // mockReset (not mockClear): implementations set inside a test (500s)
  // must not leak into later tests; the shared replace() implementation
  // must survive, so it is re-installed explicitly.
  fetchMock.mockReset();
  fetchMock.mockImplementation(serveStoredFiles);
  vi.stubGlobal("fetch", fetchMock);
  nav.replace.mockReset();
  nav.replace.mockImplementation((url: string) => {
    nav.params = new URLSearchParams(url.split("?")[1] ?? "");
  });
  nav.push.mockClear();
  nav.params = new URLSearchParams();
  nav.pathname = "/app/pages/test-page-id";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderViewer(pageMeta: PageResponse) {
  return render(<PageViewerShell pageId="test-page-id" pageMeta={pageMeta} />);
}

async function openSidebar() {
  await userEvent.click(screen.getByRole("button", { name: "Pages" }));
  return screen.findByRole("navigation", { name: "Pages" });
}

describe("PageViewerShell subpage navigation (multipage-download-fixes 8.3)", () => {
  describe("burger button gating", () => {
    it("renders the burger for a multi-document page", () => {
      renderViewer(makePageMeta(["markdown"], MANIFEST));
      expect(screen.getByRole("button", { name: "Pages" })).toBeInTheDocument();
    });

    it("shows no burger for a single-document page (zero UI change)", async () => {
      renderViewer(makePageMeta(["markdown"], [MANIFEST[0]!]));
      expect(
        screen.queryByRole("button", { name: "Pages" }),
      ).not.toBeInTheDocument();
      expect(
        await screen.findByRole("heading", { level: 1, name: "Main Document" }),
      ).toBeInTheDocument();
    });

    it("shows no burger for a legacy page without a pages field", () => {
      renderViewer(makePageMeta(["html"]));
      expect(
        screen.queryByRole("button", { name: "Pages" }),
      ).not.toBeInTheDocument();
      expect(screen.getByTitle("Saved page content")).toBeInTheDocument();
    });
  });

  describe("sidebar listing", () => {
    it("lists every document with title and host/path, main entry first and active", async () => {
      renderViewer(makePageMeta(["markdown"], MANIFEST));
      const sidebar = await openSidebar();

      const entries = [...sidebar.querySelectorAll("button")];
      // Title line per entry, in order: main documents first.
      expect(
        entries.map((entry) => entry.querySelector("span")?.textContent),
      ).toEqual([
        "Example Article",
        "About",
        "Notes",
        "hash-fallback.txt", // no title/url → stored path as fallback title
      ]);
      // Secondary host/path line per entry.
      expect(
        entries.map((entry) => entry.querySelectorAll("span")[1]?.textContent),
      ).toEqual([
        "example.com/article",
        "example.com/about",
        "example.com/docs/notes",
        "hash-fallback.txt", // no URL captured → stored path as the secondary line
      ]);
      // The page's own documents are the default view (first entry).
      expect(entries[0]).toHaveAttribute("aria-current", "true");
      expect(entries[1]).not.toHaveAttribute("aria-current");
    });
  });

  describe("pane swap", () => {
    it("swaps the main pane to a markdown subpage (same no-store fetch pattern)", async () => {
      renderViewer(makePageMeta(["markdown"], MANIFEST));

      await openSidebar();
      // Entry accessible names concatenate the title and host/path lines —
      // match on the title prefix.
      await userEvent.click(screen.getByRole("button", { name: /^About/ }));

      expect(
        await screen.findByRole("heading", { level: 1, name: "About Page" }),
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        ABOUT_URL,
        expect.objectContaining({ cache: "no-store" }),
      );
      // Selection is mirrored into the URL, non-scrolling replace.
      expect(nav.replace).toHaveBeenCalledWith(
        "/app/pages/test-page-id?page=about.md",
        { scroll: false },
      );
      // The sidebar closes after a selection.
      expect(
        screen.queryByRole("navigation", { name: "Pages" }),
      ).not.toBeInTheDocument();
    });

    it("swaps to a text subpage rendered as plain text", async () => {
      renderViewer(makePageMeta(["markdown"], MANIFEST));

      await openSidebar();
      await userEvent.click(screen.getByRole("button", { name: /^Notes/ }));

      const pre = await screen.findByText(
        (_, element) => element?.tagName === "PRE",
      );
      expect(pre).toHaveTextContent("Subpage notes text.");
      expect(fetchMock).toHaveBeenCalledWith(
        NOTES_URL,
        expect.objectContaining({ cache: "no-store" }),
      );
    });

    it("selecting the page's own entry returns to the main document and clears ?page=", async () => {
      nav.params = new URLSearchParams("page=about.md");
      renderViewer(makePageMeta(["markdown"], MANIFEST));
      expect(
        await screen.findByRole("heading", { level: 1, name: "About Page" }),
      ).toBeInTheDocument();

      await openSidebar();
      await userEvent.click(
        screen.getByRole("button", { name: /^Example Article/ }),
      );

      expect(
        await screen.findByRole("heading", { level: 1, name: "Main Document" }),
      ).toBeInTheDocument();
      expect(nav.replace).toHaveBeenCalledWith("/app/pages/test-page-id", {
        scroll: false,
      });
    });

    it("preserves ?format= when writing ?page= (params co-exist)", async () => {
      nav.params = new URLSearchParams("format=text");
      renderViewer(makePageMeta(["html", "markdown", "text"], MANIFEST));

      // ?format=text picked the Text tab for the main document.
      const mainPre = await screen.findByText(
        (_, element) => element?.tagName === "PRE",
      );
      expect(mainPre).toHaveTextContent("Main body.");

      await openSidebar();
      await userEvent.click(screen.getByRole("button", { name: /^About/ }));

      expect(nav.replace).toHaveBeenCalledWith(
        "/app/pages/test-page-id?format=text&page=about.md",
        { scroll: false },
      );
    });
  });

  describe("?page= URL contract", () => {
    it("opens on the ?page= subpage (back/forward restore) without writing the URL", async () => {
      nav.params = new URLSearchParams("page=about.md");
      renderViewer(makePageMeta(["markdown"], MANIFEST));

      expect(
        await screen.findByRole("heading", { level: 1, name: "About Page" }),
      ).toBeInTheDocument();
      // Reading state from the URL never writes it.
      expect(nav.replace).not.toHaveBeenCalled();
    });

    it("falls back to the first page (the main documents) for an invalid ?page= without writing the URL", async () => {
      nav.params = new URLSearchParams("page=evil.md");
      renderViewer(makePageMeta(["markdown"], MANIFEST));

      expect(
        await screen.findByRole("heading", { level: 1, name: "Main Document" }),
      ).toBeInTheDocument();
      expect(nav.replace).not.toHaveBeenCalled();
    });

    it("restores the selection on back/forward (segment re-render from the restored URL)", async () => {
      const view = renderViewer(makePageMeta(["markdown"], MANIFEST));
      expect(
        await screen.findByRole("heading", { level: 1, name: "Main Document" }),
      ).toBeInTheDocument();

      // Browser "back" to a URL that had the About subpage open.
      nav.params = new URLSearchParams("page=about.md");
      view.rerender(
        <PageViewerShell
          pageId="test-page-id"
          pageMeta={makePageMeta(["markdown"], MANIFEST)}
        />,
      );
      expect(
        await screen.findByRole("heading", { level: 1, name: "About Page" }),
      ).toBeInTheDocument();
      expect(nav.replace).not.toHaveBeenCalled();

      // Browser "forward" to the deep-linked Notes subpage.
      nav.params = new URLSearchParams("page=docs/notes.txt");
      view.rerender(
        <PageViewerShell
          pageId="test-page-id"
          pageMeta={makePageMeta(["markdown"], MANIFEST)}
        />,
      );
      const pre = await screen.findByText(
        (_, element) => element?.tagName === "PRE",
      );
      expect(pre).toHaveTextContent("Subpage notes text.");
      expect(nav.replace).not.toHaveBeenCalled();
    });
  });

  describe("escape closes the sidebar (no accidental back navigation)", () => {
    it("Escape closes an open sidebar instead of navigating back", async () => {
      const { fireEvent } = await import("@testing-library/react");
      renderViewer(makePageMeta(["markdown"], MANIFEST));

      await openSidebar();
      fireEvent.keyDown(document.body, { key: "Escape" });

      expect(
        screen.queryByRole("navigation", { name: "Pages" }),
      ).not.toBeInTheDocument();
      expect(nav.push).not.toHaveBeenCalled();
    });

    it("Escape with the sidebar closed still navigates back (unchanged)", async () => {
      const { fireEvent } = await import("@testing-library/react");
      renderViewer(makePageMeta(["markdown"], MANIFEST));

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(nav.push).toHaveBeenCalledTimes(1);
      expect(nav.push).toHaveBeenCalledWith("/app");
    });
  });
});

describe("PublicViewerShell subpage parity (share route)", () => {
  it("renders the burger + sidebar and swaps the pane via the token route", async () => {
    nav.pathname = "/s/tok";
    render(
      <PublicViewerShell token="tok" formats={["markdown"]} pages={MANIFEST} />,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Main Document" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Pages" }));
    const sidebar = await screen.findByRole("navigation", { name: "Pages" });
    // Share validation carries no title/url — neutral main entry.
    expect(sidebar).toHaveTextContent("Shared page");
    expect(sidebar).toHaveTextContent("About");

    await userEvent.click(screen.getByRole("button", { name: /^About/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "About Page" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      SHARE_ABOUT_URL,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(nav.replace).toHaveBeenCalledWith("/s/tok?page=about.md", {
      scroll: false,
    });
  });

  it("honors ?page= on the share route and clears it on the main entry", async () => {
    nav.pathname = "/s/tok";
    nav.params = new URLSearchParams("page=about.md");
    render(
      <PublicViewerShell token="tok" formats={["markdown"]} pages={MANIFEST} />,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "About Page" }),
    ).toBeInTheDocument();
    expect(nav.replace).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Pages" }));
    await userEvent.click(screen.getByRole("button", { name: "Shared page" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Main Document" }),
    ).toBeInTheDocument();
    expect(nav.replace).toHaveBeenCalledWith("/s/tok", { scroll: false });
  });

  it("shows no burger for a single-document share", async () => {
    render(
      <PublicViewerShell
        token="tok"
        formats={["markdown"]}
        pages={[MANIFEST[0]!]}
      />,
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Main Document" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pages" }),
    ).not.toBeInTheDocument();
  });

  it("shows no burger for a legacy share without a pages field (probe 404 degrades to the bare iframe)", async () => {
    render(<PublicViewerShell token="tok" />);

    // The share-side gallery probe (image gallery feature) hits the images
    // route once; the stub's 404 degrades to today's bare iframe.
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sc/tok/images");
    expect(await screen.findByTitle("Shared page content")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pages" }),
    ).not.toBeInTheDocument();
  });
});
