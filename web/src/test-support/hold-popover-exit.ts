import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/** JSDOM has no CSS animation clock/live styles. Keep real Radix exit presence. */
export function holdPopoverExit() {
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computed(element);
    if (element.getAttribute("data-slot") === "popover-content") {
      Object.defineProperty(style, "animationName", {
        get: () =>
          element.getAttribute("data-state") === "closed"
            ? "choice-exit"
            : "none",
      });
    }
    return style;
  });
  // The test animation has a literal CSS identifier, with no escaping needed.
  if (!globalThis.CSS?.escape) vi.stubGlobal("CSS", { escape: String });
  return (element: HTMLElement) => {
    const end = new Event("animationend", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: "choice-exit" });
    fireEvent(element, end);
  };
}
