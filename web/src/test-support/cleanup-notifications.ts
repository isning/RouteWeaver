import { act, cleanup, waitFor } from "@testing-library/react";
import { toast } from "sonner";

/** Finish Sonner's notification work before unmounting its React owner. */
export async function cleanupNotifications() {
  // Sonner queues newly published notices with setTimeout(0). Let that delivery
  // render before dismissing, including notices emitted at the end of a test.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  act(() => {
    toast.dismiss();
  });
  // Dismissal clears getToasts() immediately, but the mounted toast still owns
  // an exit-removal timer. Unmounting first leaves that callback alive after
  // jsdom teardown. Observe completion rather than sleeping for its duration.
  await waitFor(() => {
    if (document.querySelector("[data-sonner-toast]")) {
      throw new Error("Notifications are still completing their exit");
    }
  });
  cleanup();
}
