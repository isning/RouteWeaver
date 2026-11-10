// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { cleanupNotifications } from "./cleanup-notifications";

afterEach(async () => {
  cleanup();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

it.each(["queued", "active", "dismissing"] as const)(
  "finishes a %s notification before releasing its DOM environment",
  async (state) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Toaster />);
    act(() => {
      toast.success("Saved", { id: "saved", duration: Infinity });
    });
    if (state !== "queued") {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByText("Saved")).toBeTruthy();
    }
    if (state === "dismissing") {
      act(() => {
        toast.dismiss("saved");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
      // Public dismissal is immediate, while the rendered exit remains pending.
      expect(toast.getToasts()).toHaveLength(0);
      expect(screen.getByText("Saved")).toBeTruthy();
    }
    await cleanupNotifications();
    expect(document.querySelector("[data-sonner-toaster]")).toBeNull();
    expect(toast.getToasts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
