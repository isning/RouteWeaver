// Self-contained so Playwright can serialize it into the browser context.
export function measureTitleText(element: Element) {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    rects.push(
      ...Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0,
      ),
    );
  }
  const tops: number[] = [];
  for (const rect of rects) {
    if (!tops.some((top) => Math.abs(top - rect.top) <= 1)) tops.push(rect.top);
  }
  return {
    width: element.getBoundingClientRect().width,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    textHeight: rects.length
      ? Math.max(...rects.map((r) => r.bottom)) -
        Math.min(...rects.map((r) => r.top))
      : 0,
    lineCount: tops.length,
  };
}
