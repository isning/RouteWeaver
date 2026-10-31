/**
 * Browser-evaluable vertical text audit; not an occlusion or native-zoom oracle.
 * Keep every runtime dependency inside the function for Locator.evaluate.
 */
export function auditTextGeometry(root: Element) {
  const issues: Array<{
    control: string;
    issue: string;
    paintedHeight?: number;
    availableHeight?: number;
  }> = [];
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(
      "button,input,textarea,label,h1,h2,[data-slot='dialog-title']",
    ),
  );
  for (const element of candidates) {
    const box = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    if (
      !box.width ||
      !box.height ||
      css.visibility === "hidden" ||
      element.closest('[aria-hidden="true"]')
    )
      continue;
    const control =
      element.getAttribute("aria-label") ||
      element.textContent?.trim().slice(0, 70) ||
      element.tagName;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest('[aria-hidden="true"]')) continue;
      if (
        parent.closest("button,label,h1,h2,[data-slot='dialog-title']") !==
        element
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const painted of Array.from(range.getClientRects())) {
        if (!painted.width || !painted.height) continue;
        // One CSS pixel tolerates sub-pixel font rounding, not a clipped line.
        if (painted.top < box.top - 1 || painted.bottom > box.bottom + 1) {
          issues.push({
            control,
            issue: "text extends vertically beyond its control/label",
            paintedHeight: painted.height,
            availableHeight: box.height,
          });
        }
        // Off-scroll text is intentionally outside a scroll viewport. Beyond
        // that boundary, check the viewport's reachability rather than treating
        // its unscrolled text coordinates as a clipped outer-dialog defect.
        let relevantBounds = painted;
        let scrollBoundary = false;
        for (
          let ancestor = parent;
          ancestor && root.contains(ancestor);
          ancestor = ancestor.parentElement!
        ) {
          const clip = getComputedStyle(ancestor).overflowY;
          if (
            (clip === "auto" || clip === "scroll") &&
            ancestor.clientHeight > 0 &&
            ancestor.scrollHeight > ancestor.clientHeight + 1
          ) {
            relevantBounds = ancestor.getBoundingClientRect();
            scrollBoundary = true;
            continue;
          }
          if (clip !== "hidden" && clip !== "clip") continue;
          const bounds = ancestor.getBoundingClientRect();
          if (
            relevantBounds.top < bounds.top - 1 ||
            relevantBounds.bottom > bounds.bottom + 1
          ) {
            issues.push({
              control,
              issue: scrollBoundary
                ? "scroll viewport vertically clipped by an overflow-hidden ancestor"
                : "text vertically clipped by an overflow-hidden ancestor",
              paintedHeight: relevantBounds.height,
              availableHeight: bounds.height,
            });
            break;
          }
        }
      }
    }
    if (
      (element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement &&
          [
            "text",
            "search",
            "email",
            "url",
            "tel",
            "password",
            "number",
          ].includes(element.type))) &&
      element.value &&
      box.width > 4
    ) {
      const canvas = document.createElement("canvas");
      const drawing = canvas.getContext("2d")!;
      drawing.font = css.font;
      const metrics = drawing.measureText("选Ag");
      const paintedHeight =
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
      const availableHeight = element.clientHeight;
      if (paintedHeight > availableHeight + 1)
        issues.push({
          control,
          issue: "input glyphs taller than its inner control",
          paintedHeight,
          availableHeight,
        });
    }
  }
  return { checkedControlsAndLabels: candidates.length, issues };
}
