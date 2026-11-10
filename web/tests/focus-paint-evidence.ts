import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Diagnostic evidence, not a contrast/compliance assertion. Record every ancestor
// because InputGroup/FieldLabel may own the paint instead of the focused control.
async function paintSnapshot(target: Locator) {
  return target.evaluate((element) => {
    const describe = (node: Element, pseudo?: string) => {
      const style = getComputedStyle(node, pseudo);
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName,
        slot: node.getAttribute("data-slot"),
        pseudo: pseudo ?? null,
        focused: node === document.activeElement,
        focusVisible: node.matches(":focus-visible"),
        focusWithin: node.matches(":focus-within"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backgroundClip: style.backgroundClip,
        color: style.color,
        opacity: style.opacity,
        border: ["Top", "Right", "Bottom", "Left"].map((side) => ({
          color: style.getPropertyValue(`border-${side.toLowerCase()}-color`),
          width: style.getPropertyValue(`border-${side.toLowerCase()}-width`),
          style: style.getPropertyValue(`border-${side.toLowerCase()}-style`),
        })),
        shadow: style.boxShadow,
        outline: {
          color: style.outlineColor,
          width: style.outlineWidth,
          style: style.outlineStyle,
          offset: style.outlineOffset,
        },
        overflow: { x: style.overflowX, y: style.overflowY },
        content: pseudo ? style.content : null,
      };
    };
    const ancestors = [];
    for (let node = element.parentElement; node; node = node.parentElement)
      ancestors.push(describe(node));
    const rect = element.getBoundingClientRect();
    const points = [
      [rect.left - 4, rect.top + rect.height / 2],
      [rect.right + 4, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top - 4],
      [rect.left + rect.width / 2, rect.bottom + 4],
    ];
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      target: describe(element),
      pseudos: [describe(element, "::before"), describe(element, "::after")],
      ancestors,
      // Hit surfaces are context, not pixel colors: transparency, overlap and
      // antialiasing still require inspection of the paired screenshots.
      adjacentSurfaces: points.map(([x, y]) => {
        const node = document.elementFromPoint(x, y);
        return { x, y, surface: node ? describe(node) : null };
      }),
    };
  });
}

export async function captureNativeFocusPair(
  page: Page,
  target: Locator,
  info: TestInfo,
  name: string,
) {
  await expect(target).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(target).not.toBeFocused();
  await settledTask(target);
  const before = await paintSnapshot(target);
  await info.attach(`${name}-before.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
  await settledTask(target);
  const after = await paintSnapshot(target);
  expect(after.target.focusVisible).toBe(true);
  await info.attach(`${name}-focused.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await info.attach(`${name}-paint`, {
    body: JSON.stringify(
      {
        scope:
          "Synthetic service form; native Shift+Tab then Tab; settled styles. Not a contrast compliance verdict. Geometry may change through native scrolling.",
        before,
        after,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
}
