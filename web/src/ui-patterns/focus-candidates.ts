/** Legacy non-dialog boundary traversal; official Radix scopes handle task overlays. */
export function visibleFocusCandidates(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button,input:not([type="hidden"]),select,textarea,a[href],area[href],summary,[tabindex],[contenteditable="true"]',
    ),
  ).filter((element) => {
    if (
      element.tabIndex < 0 ||
      element.matches(":disabled") ||
      element.closest("[hidden],[inert],[aria-hidden='true']")
    )
      return false;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    for (
      let node: HTMLElement | null = element;
      node;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        return false;
    }
    return true;
  });
}
