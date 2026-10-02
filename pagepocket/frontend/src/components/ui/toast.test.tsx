import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";

function ToastHarness({
  variant,
  message,
}: {
  variant: "success" | "error" | "info" | "warning";
  message: string;
}) {
  return (
    <>
      <Toaster position="top-right" />
      <Button
        onClick={() => {
          const opts: Record<string, { duration?: number }> = {
            success: { duration: 3000 },
            error: { duration: 6000 },
            info: { duration: 4000 },
            warning: { duration: 5000 },
          };
          toast[variant](message, opts[variant]);
        }}
      >
        Show toast
      </Button>
    </>
  );
}

describe("Toast (sonner)", () => {
  it("renders a success toast", async () => {
    const user = userEvent.setup();
    render(<ToastHarness variant="success" message="Saved!" />);
    await user.click(screen.getByText("Show toast"));
    expect(await screen.findByText("Saved!")).toBeInTheDocument();
  });

  it("renders an error toast with action button", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster position="top-right" />
        <Button
          onClick={() =>
            toast.error("Upload failed", {
              duration: 6000,
              action: { label: "Retry", onClick: vi.fn() },
            })
          }
        >
          Show toast
        </Button>
      </>,
    );
    await user.click(screen.getByText("Show toast"));
    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("renders an info toast", async () => {
    const user = userEvent.setup();
    render(<ToastHarness variant="info" message="Syncing..." />);
    await user.click(screen.getByText("Show toast"));
    expect(await screen.findByText("Syncing...")).toBeInTheDocument();
  });

  it("renders a warning toast", async () => {
    const user = userEvent.setup();
    render(<ToastHarness variant="warning" message="Almost out of space" />);
    await user.click(screen.getByText("Show toast"));
    expect(await screen.findByText("Almost out of space")).toBeInTheDocument();
  });

  it("auto-dismisses after duration", () => {
    vi.useFakeTimers();
    render(
      <>
        <Toaster position="top-right" />
        <Button
          onClick={() => toast.success("Gone soon", { duration: 1000 })}
        >
          Show toast
        </Button>
      </>,
    );

    act(() => {
      screen.getByText("Show toast").click();
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });

    // Toast is visible after triggering
    expect(screen.getByText("Gone soon")).toBeInTheDocument();

    // Advance past the duration + sonner's internal animation buffer
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText("Gone soon")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
