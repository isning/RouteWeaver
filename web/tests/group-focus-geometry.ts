import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";

/** Observe the keyboard's original scroll position; never focus or scroll here. */
export async function captureGroupFocusGeometry(
  page: Page, info: TestInfo, field: Locator, phase: "entry" | "reverse-entry",
) {
  const evidence = await field.evaluate(async (element) => {
    const rect = (box: DOMRectReadOnly) => ({
      left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      width: box.width, height: box.height,
    });
    const ratio = await new Promise<number>((resolve) => {
      const observer = new IntersectionObserver(([entry]) => {
        observer.disconnect();
        resolve(entry.intersectionRatio);
      });
      observer.observe(element);
    });
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const clippingAncestors = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      const clipsX = ["auto", "scroll", "hidden", "clip"].includes(css.overflowX);
      const clipsY = ["auto", "scroll", "hidden", "clip"].includes(css.overflowY);
      if (clipsX || clipsY) {
        const bounds = node.getBoundingClientRect();
        clippingAncestors.push({
          clipsX, clipsY,
          left: bounds.left + node.clientLeft,
          right: bounds.left + node.clientLeft + node.clientWidth,
          top: bounds.top + node.clientTop,
          bottom: bounds.top + node.clientTop + node.clientHeight,
          scrollTop: node.scrollTop, scrollLeft: node.scrollLeft,
        });
      }
    }
    const toolbar = document.querySelector(".profile-publish-action");
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    // Parse only numeric shadow lengths, never emit content, IDs, or values.
    const shadows = [...style.boxShadow.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]), blur: Number(match[3]), spread: Number(match[4] ?? 0) }));
    return {
      simulation: "doubled computed font and line-height, not browser-native zoom",
      focused: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
      fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight),
      marginTop: parseFloat(style.scrollMarginTop), marginBottom: parseFloat(style.scrollMarginBottom),
      target: rect(box), ratio, shadows, clippingAncestors,
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      toolbar: toolbar ? rect(toolbar.getBoundingClientRect()) : null,
      centerHitsTarget: hit === element || !!hit && element.contains(hit),
    };
  });
  const name = `group-name-keyboard-200pct-${phase}`;
  const body = JSON.stringify(evidence, null, 2);
  await writeFile(info.outputPath(`${name}.json`), body);
  await info.attach(name, { body, contentType: "application/json" });
  // Same privacy boundary as failure-only text-scale evidence. Keep the outer
  // ring outside the masked input border, without moving or restyling geometry.
  const screenshot = await page.screenshot({
    path: info.outputPath(`${name}.png`), fullPage: false, animations: "allow",
    style: "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; background-image: none !important; }",
    mask: [page.locator("input, textarea, select, [contenteditable], img, svg, canvas, video, iframe")],
  });
  await info.attach(`${name}-original-position`, { body: screenshot, contentType: "image/png" });
  return evidence;
}
