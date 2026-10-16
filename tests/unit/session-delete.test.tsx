/**
 * @vitest-environment jsdom
 *
 * Unit tests for the panel delete flow (close-cloud-lifecycle-gaps D2 /
 * task 3.4): the "Also remove from PagePocket" checkbox renders ONLY for
 * cloud-success sessions and defaults to unchecked, and the confirm action
 * threads the opt-in flag into the delete callback.
 *
 * Rendered with react-dom/client directly (no @testing-library/react —
 * not a project dependency), against a jsdom document.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDelete } from "../../src/sidepanel/components/SessionDelete";

// ---------------------------------------------------------------------------
// Mocks — the component resolves labels through react-i18next; return the
// key so assertions can match on it.
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Minimal render harness (createRoot + act + dispatched bubbling events)
// ---------------------------------------------------------------------------

function renderUi(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });

  const queryButtons = () => Array.from(container.querySelectorAll("button"));
  const findButtonByText = (text: string) =>
    queryButtons().find((b) => b.textContent?.includes(text)) ?? null;
  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

  return {
    container,
    root: root as Root,
    queryButtons,
    findButtonByText,
    click,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

/** Wrapper rendering the component under a test-controlled cloud status. */
function Harness(props: {
  cloudStatus?: string | null;
  onDelete: (options: { deleteCloud: boolean }) => Promise<void> | void;
}) {
  return <SessionDelete {...props} />;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionDelete (panel delete flow)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("offers the checkbox for cloud-success sessions and defaults unchecked", () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const ui = renderUi(<Harness cloudStatus="success" onDelete={onDelete} />);

    // Idle → expand the delete flow
    const trigger = ui.findButtonByText("sessionDelete.deleteButton");
    expect(trigger).not.toBeNull();
    ui.click(trigger!);

    const checkbox = ui.container.querySelector('button[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    // Default OFF — a local delete must never silently destroy cloud data.
    expect(checkbox!.getAttribute("aria-checked")).toBe("false");
    expect(checkbox!.getAttribute("data-state")).toBe("unchecked");
    expect(
      ui.container.querySelector('label[for="sessionDeleteCloud"]')
        ?.textContent,
    ).toBe("sessionDelete.alsoRemoveFromPagepocket");

    ui.unmount();
  });

  it("renders no checkbox for a non-success cloud status", () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const ui = renderUi(<Harness cloudStatus="failed" onDelete={onDelete} />);

    ui.click(ui.findButtonByText("sessionDelete.deleteButton")!);

    expect(ui.container.querySelector('button[role="checkbox"]')).toBeNull();
    expect(
      ui.container.querySelector('label[for="sessionDeleteCloud"]'),
    ).toBeNull();

    ui.unmount();
  });

  it("renders no checkbox when the session has no cloud status", () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const ui = renderUi(<Harness cloudStatus={null} onDelete={onDelete} />);

    ui.click(ui.findButtonByText("sessionDelete.deleteButton")!);

    expect(ui.container.querySelector('button[role="checkbox"]')).toBeNull();

    ui.unmount();
  });

  it("confirms a local-only delete when the checkbox stays unchecked", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const ui = renderUi(<Harness cloudStatus="success" onDelete={onDelete} />);

    ui.click(ui.findButtonByText("sessionDelete.deleteButton")!);
    await act(async () => {
      ui.findButtonByText("sessionDelete.confirmDelete")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith({ deleteCloud: false });
    // Success feedback replaces the controls
    expect(ui.container.textContent?.includes("sessionDelete.deleted")).toBe(
      true,
    );

    ui.unmount();
  });

  it("threads deleteCloud=true when the checkbox is checked", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const ui = renderUi(<Harness cloudStatus="success" onDelete={onDelete} />);

    ui.click(ui.findButtonByText("sessionDelete.deleteButton")!);
    ui.click(ui.container.querySelector('button[role="checkbox"]')!);
    expect(
      ui.container
        .querySelector('button[role="checkbox"]')!
        .getAttribute("aria-checked"),
    ).toBe("true");

    await act(async () => {
      ui.findButtonByText("sessionDelete.confirmDelete")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith({ deleteCloud: true });

    ui.unmount();
  });

  it("keeps the confirm view and shows the error when the delete throws", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("Network error"));
    const ui = renderUi(<Harness cloudStatus={null} onDelete={onDelete} />);

    ui.click(ui.findButtonByText("sessionDelete.deleteButton")!);
    await act(async () => {
      ui.findButtonByText("sessionDelete.confirmDelete")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(
      ui.container.textContent?.includes("sessionDelete.deleteFailed"),
    ).toBe(true);
    // Still in the confirm phase — the user can retry or cancel
    expect(ui.findButtonByText("sessionDelete.confirmDelete")).not.toBeNull();

    ui.unmount();
  });
});
