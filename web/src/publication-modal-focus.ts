import type { KeyboardEvent } from "react";
import { visibleFocusCandidates } from "./ui-patterns/focus-candidates";

// Supplement existing dialog traps at button boundaries. Access tasks can opt
// into their trailing native link; interior traversal stays browser-owned.
export function wrapPublicationModalTab(
  event: KeyboardEvent<HTMLDivElement>,
  options: { allowTrailingLink?: boolean; scroll?: "native" } = {},
) {
  if (
    event.key !== "Tab" ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const root = event.currentTarget;
  const dialog = root.closest<HTMLElement>('[role="dialog"]');
  // Official Radix FocusScope owns all task-dialog boundaries.
  if (dialog?.matches("[data-task-overlay]")) return;
  const active = document.activeElement;
  if (
    !dialog ||
    !(active instanceof HTMLElement) ||
    event.target !== active ||
    !root.contains(active) ||
    active.closest('[role="dialog"]') !== dialog ||
    active.closest(
      '[role="menu"], [role="listbox"], [role="tree"], [role="grid"], [aria-expanded="true"]',
    )
  )
    return;

  const eligible = (element: HTMLElement) => {
    if (
      !element.isConnected ||
      element.tabIndex < 0 ||
      element.closest('[hidden], [inert], [aria-hidden="true"]') ||
      element.matches(':disabled, [aria-disabled="true"]') ||
      element.closest('[role="dialog"]') !== dialog
    )
      return false;
    const visibility = getComputedStyle(element).visibility;
    return visibility !== "hidden" && visibility !== "collapse";
  };
  // Non-task legacy surfaces provide rendered native controls and tabindex candidates. Add
  // inherited visibility, inert, disabled-fieldset and nested-dialog guards.
  const controls = visibleFocusCandidates(dialog)
    .filter(eligible)
    .sort((a, b) => {
      const order = (element: HTMLElement) =>
        element.tabIndex > 0 ? element.tabIndex : Infinity;
      return order(a) - order(b);
    });
  const first = controls[0];
  const last = controls[controls.length - 1];
  // Keep the existing first-button contract and decline composite/radio edges.
  // Only explicitly opted-in access tasks may end on a native href.
  const trailingLink =
    options.allowTrailingLink &&
    last instanceof HTMLAnchorElement &&
    last.hasAttribute("href");
  if (
    !(first instanceof HTMLButtonElement) ||
    !(last instanceof HTMLButtonElement || trailingLink)
  )
    return;
  const destination =
    event.shiftKey && active === first
      ? last
      : !event.shiftKey && active === last
        ? first
        : null;
  if (!destination) return;
  event.preventDefault();
  // Only opted-in tasks need native ancestor scrolling; focusing never activates a link.
  if (options.scroll === "native" || destination instanceof HTMLAnchorElement)
    destination.focus();
  else destination.focus({ preventScroll: true });
}
