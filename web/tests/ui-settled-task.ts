import { expect, test, type Locator } from "@playwright/test";
import { surfaceMotionState } from "./ui-surface-stability";

// Wait for actual finite task motion, not an arbitrary delay or disabled animation.
// Existing surfaceMotionState rejects visible/busy/infinite motion; no exceptions
// are added here. Geometry limits remain the caller's responsibility.
export async function settledTask(surface: Locator) {
  await expect(surface).toBeVisible();
  const snapshot = () =>
    surface.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        width: rect.width,
        right: rect.right,
        opacity: style.opacity,
        transform: style.transform,
        animations: element
          .getAnimations()
          .map((a) => ({
            playState: a.playState,
            currentTime: String(a.currentTime),
          })),
      };
    });
  const before = await snapshot();
  try {
    await surface.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect
      .poll(() => surface.evaluate(surfaceMotionState))
      .toEqual({ opacity: "1", preparing: false, running: false });
  } finally {
    await test
      .info()
      .attach("task-surface-settling", {
        contentType: "application/json",
        body: JSON.stringify({ before, after: await snapshot() }),
      });
  }
}
