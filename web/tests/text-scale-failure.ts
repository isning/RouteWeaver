import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";

/** Failure-only observation: never scroll, focus, settle animation, or restore text size. */
export async function captureTextScaleFailure(page: Page, info: TestInfo, target: Locator) {
  const name = "lower-group-200pct-reading-failure";
  // Explicit scalar geometry only: no IDs, classes, labels, values, markup or URLs.
  try {
    const evidence = await target.evaluate(async (element) => {
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
      const rect = (box: DOMRectReadOnly | null) => box && ({
        x: box.x, y: box.y, width: box.width, height: box.height,
        top: box.top, right: box.right, bottom: box.bottom, left: box.left,
      });
      const category = (value: string, allowed: string[]) => allowed.includes(value) ? value : "other";
      const ancestors = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        ancestors.push({
          depth: ancestors.length, rect: rect(node.getBoundingClientRect()),
          clientWidth: node.clientWidth, clientHeight: node.clientHeight,
          clientTop: node.clientTop, clientLeft: node.clientLeft,
          scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
          scrollTop: node.scrollTop, scrollLeft: node.scrollLeft,
          overflowX: category(style.overflowX, ["visible", "hidden", "clip", "scroll", "auto"]),
          overflowY: category(style.overflowY, ["visible", "hidden", "clip", "scroll", "auto"]),
          position: category(style.position, ["static", "relative", "absolute", "fixed", "sticky"]),
          fontSize: number(parseFloat(style.fontSize)), lineHeight: number(parseFloat(style.lineHeight)),
        });
      }
      const animations = document.getAnimations().map((animation) => ({
        state: category(animation.playState, ["idle", "running", "paused", "finished"]),
        currentTime: number(animation.currentTime),
        progress: number(animation.effect?.getComputedTiming().progress),
        duration: number(animation.effect?.getComputedTiming().duration),
        property: animation instanceof CSSTransition
          ? category(animation.transitionProperty, ["font-size", "line-height", "height", "min-height", "width", "transform", "color", "background-color", "border-color", "box-shadow"])
          : "other",
      }));
      const intersection = await new Promise<object>((resolve) => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve({ ratio: entry.intersectionRatio, intersecting: entry.isIntersecting,
            target: rect(entry.boundingClientRect), intersection: rect(entry.intersectionRect), root: rect(entry.rootBounds) });
        });
        observer.observe(element);
      });
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
        ancestors, animations, intersection, centerHitsTarget: hit === element || !!hit && element.contains(hit) };
    }, undefined, { timeout: 2000 });
    const body = JSON.stringify(evidence, null, 2);
    await writeFile(info.outputPath(`${name}.json`), body);
    await info.attach(name, { body, contentType: "application/json" });
  } catch { /* Preserve the original assertion if observation itself fails. */ }
  try {
    // Mask all textual/replaced content without changing layout or animation state.
    // Keep control borders/ancestor geometry visible; never expose credential values.
    await page.screenshot({
      path: info.outputPath(`${name}.png`), fullPage: false, animations: "allow",
      style: "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; background-image: none !important; }",
      mask: [page.locator("input, textarea, select, [contenteditable], img, svg, canvas, video, iframe")],
      timeout: 2000,
    });
  } catch { /* A screenshot failure must not replace the original assertion. */ }
}
