import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageCard } from "../page-card";

const page = {
  id: "test-page-id",
  title: "Example Page",
  url: "https://example.com/article",
  archived_at: "2026-01-01T00:00:00",
  collection_id: null as string | null,
};

function renderCard() {
  return render(
    <PageCard
      page={page}
      onDownload={vi.fn()}
      onShare={vi.fn()}
      onMove={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: "Page actions" }));
  return screen.findByRole("menuitem", { name: "Download" });
}

describe("PageCard action menu", () => {
  it("includes a Download entry as the first item, above Share", async () => {
    renderCard();
    await openMenu();
    const items = screen.getAllByRole("menuitem");
    const names = items.map((item) => item.textContent?.trim());
    expect(names[0]).toBe("Download");
    expect(names).toContain("Share");
  });

  it("invokes onDownload with the page id when Download is triggered", async () => {
    const onDownload = vi.fn();
    render(<PageCard page={page} onDownload={onDownload} />);
    const download = await openMenu();
    await userEvent.click(download);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith("test-page-id");
  });
});

describe("PageCard size badge (storage-usage-display)", () => {
  it("shows the human-readable size when the page carries size_bytes", () => {
    render(<PageCard page={{ ...page, size_bytes: 2516582 }} />);
    expect(screen.getByText("2.4 MB")).toBeInTheDocument();
  });

  it("renders no size badge when size_bytes is missing", () => {
    render(<PageCard page={page} />);
    expect(screen.queryByText("2.4 MB")).not.toBeInTheDocument();
    expect(screen.getByText(/Archived/)).toBeInTheDocument();
  });
});
