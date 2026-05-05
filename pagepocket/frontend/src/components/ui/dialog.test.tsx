import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

function TestDialog({ onClose }: { onClose?: () => void }) {
  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogTrigger render={<Button>Open</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm action</DialogTitle>
          <DialogDescription>Are you sure?</DialogDescription>
        </DialogHeader>
        <DialogClose render={<Button>Confirm</Button>} />
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog focus trap", () => {
  it("moves focus into the dialog on open", async () => {
    const user = userEvent.setup();
    render(<TestDialog />);

    await user.click(screen.getByText("Open"));
    expect(await screen.findByText("Confirm action")).toBeInTheDocument();

    const confirmBtn = screen.getByText("Confirm");
    expect(confirmBtn).toBeInTheDocument();
    // Focus should be inside the dialog content
    const dialogContent = confirmBtn.closest("[data-slot='dialog-content']");
    expect(dialogContent?.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<TestDialog />);

    const trigger = screen.getByText("Open");
    await user.click(trigger);
    expect(await screen.findByText("Confirm action")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByText("Confirm action")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab focus within the dialog", async () => {
    const user = userEvent.setup();
    render(<TestDialog />);

    await user.click(screen.getByText("Open"));
    expect(await screen.findByText("Confirm action")).toBeInTheDocument();

    // Tab through focusable elements inside the dialog
    await user.tab();
    const focused = document.activeElement;
    const dialogContent = focused?.closest("[data-slot='dialog-content']") as HTMLElement | null;
    expect(dialogContent).toBeTruthy();
  });

  it("closes via the close button", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TestDialog onClose={onClose} />);

    await user.click(screen.getByText("Open"));
    expect(await screen.findByText("Confirm action")).toBeInTheDocument();

    // The X close button has "Close" sr-only text
    const closeBtn = screen.getByRole("button", { name: /close/i });
    await user.click(closeBtn);

    expect(screen.queryByText("Confirm action")).not.toBeInTheDocument();
  });
});
