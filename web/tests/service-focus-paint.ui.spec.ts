import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { activate, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});

async function tabTo(page: Page, dialog: Locator, target: Locator) {
  const stops = await dialog
    .locator('a[href],button,input,select,textarea,[tabindex]')
    .count();
  for (let step = 0; step <= stops; step++) {
    if (await target.evaluate((element) => element === document.activeElement))
      break;
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function expectFocusedRingInsideClips(target: Locator) {
  await expect(target).toBeFocused();
  await settledTask(target);
  const paint = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let left = 0,
      top = 0,
      right = innerWidth,
      bottom = innerHeight;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node),
        box = node.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left + node.clientLeft);
        right = Math.min(right, box.left + node.clientLeft + node.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top + node.clientTop);
        bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight);
      }
    }
    return {
      focused: element === document.activeElement,
      focusVisible: element.matches(":focus-visible"),
      shadow: getComputedStyle(element).boxShadow,
      box: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
      clip: { left, top, right, bottom },
    };
  });
  expect(paint.focused).toBe(true);
  expect(paint.focusVisible).toBe(true);
  // Independent design contract: the official Button paints a 3px outer ring.
  // Check the actual settled shadow, not the production helper's CSS variable.
  expect(paint.shadow).toMatch(/(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/);
  // Half a pixel is the existing browser paint/rasterization tolerance.
  expect(paint.box.left - 3).toBeGreaterThanOrEqual(paint.clip.left - 0.5);
  expect(paint.box.right + 3).toBeLessThanOrEqual(paint.clip.right + 0.5);
  expect(paint.box.top - 3).toBeGreaterThanOrEqual(paint.clip.top - 0.5);
  expect(paint.box.bottom + 3).toBeLessThanOrEqual(paint.clip.bottom + 0.5);
  return paint;
}

for (const height of [900, 640]) {
  test(`service plan native Tab keeps the entire focus ring visible at 390x${height}`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width: 390, height });
    await signIn(page, baseURL, "admin");
    const mutations: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname.startsWith("/api/") &&
        !["GET", "HEAD"].includes(request.method())
      )
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname.startsWith("/api/") &&
        response.status() >= 400
      )
        errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    await page.goto("/#services");
    await expect(
      page.getByRole("heading", { name: "服务方案", exact: true, level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const opener = page
      .locator(".page-heading")
      .getByRole("button", { name: "新建方案", exact: true });
    // A second open checks that a previous task's scroll/focus cannot hide a failure.
    for (const attempt of [1, 2]) {
      await activate(page, opener);
      const dialog = page.getByRole("dialog", {
        name: "新建服务方案",
        exact: true,
      });
      await settledTask(dialog);
      const name = dialog.getByRole("textbox", {
        name: "服务方案名称",
        exact: true,
      });
      await expect(name).toHaveValue("");
      const body = dialog.locator("[data-task-overlay-body]");
      const outsideScroll = () =>
        body.evaluate((element) => {
          const offsets: number[] = [scrollX, scrollY];
          for (let node = element.parentElement; node; node = node.parentElement)
            offsets.push(node.scrollLeft, node.scrollTop);
          return offsets;
        });
      const before = await outsideScroll();
      const cancel = dialog.getByRole("button", { name: "取消", exact: true });
      const preview = dialog.getByRole("button", {
        name: "预览影响",
        exact: true,
      });
      await tabTo(page, dialog, cancel);
      await expectFocusedRingInsideClips(cancel);
      await page.keyboard.press("Tab");
      const paint = await expectFocusedRingInsideClips(preview);
      expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(
        0,
      );
      expect(await outsideScroll()).toEqual(before);
      const position = await body.evaluate((element) => element.scrollTop);
      await page.keyboard.press("Shift+Tab");
      await expectFocusedRingInsideClips(cancel);
      await page.keyboard.press("Tab");
      await expectFocusedRingInsideClips(preview);
      expect(await body.evaluate((element) => element.scrollTop)).toBe(position);
      await expect(name).toHaveValue("");
      await info.attach(`service-focus-paint-390x${height}-open${attempt}`, {
        body: JSON.stringify(paint),
        contentType: "application/json",
      });
      await info.attach(`service-focus-paint-390x${height}-open${attempt}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    }
    expect(
      mutations,
      "Tab and dismissal must not preview or apply any service policy",
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
}
