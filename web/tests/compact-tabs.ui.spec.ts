import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { auditTextGeometry } from "./text-geometry";

test.use({trace: "off", screenshot: "off", video: "off"});

// Preserve the viewport exactly as the keyboard journey left it. Do not scroll,
// refocus, resize, finish animations, hide carets, or crop to a component.
async function attachViewport(page: Page, info: TestInfo, phase: string) {
  const name = `compact-tabs-${phase}`;
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({path, fullPage: false, animations: "allow", caret: "initial"});
  await info.attach(name, {path, contentType: "image/png"});
}

test.afterEach(async ({page}, info) => {
  if (info.status === info.expectedStatus || page.isClosed()) return;
  try {
    await attachViewport(page, info, "failure-original-viewport");
  } catch {
    // Keep the original assertion failure authoritative if capture is unavailable.
    await info.attach("compact-tabs-failure-capture-unavailable", {
      contentType: "text/plain",
      body: "The original failed viewport could not be captured; no page recovery was attempted.",
    });
  }
});

async function scaleText(page: Page) {
  await page.evaluate(() => {
    // Same pre-mutation snapshot principle as product-model's existing audit.
    // This is controlled text enlargement, NOT native browser zoom.
    const entries = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(element => !["SCRIPT", "STYLE", "LINK"].includes(element.tagName))
      .map(element => ({element, font: parseFloat(getComputedStyle(element).fontSize), line: getComputedStyle(element).lineHeight}));
    for (const {element, font, line} of entries) {
      element.style.setProperty("font-size", `${font * 2}px`, "important");
      if (line !== "normal") element.style.setProperty("line-height", `${parseFloat(line) * 2}px`, "important");
    }
  });
}

async function inspect(page: Page, scope: Locator, rail: Locator, enlarged: boolean, info: TestInfo) {
  await attachViewport(page, info, `${enlarged ? "200pct" : "normal"}-last-tab-viewport`);
  const snapshot = await rail.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const tabs = [...element.querySelectorAll<HTMLElement>('[role="tab"]')];
    const clip = element.closest('[data-radix-scroll-area-viewport]') ?? element.parentElement!;
    const viewport = clip.getBoundingClientRect();
    return {
      height: bounds.height,
      clip: {top: viewport.top, bottom: viewport.bottom, height: viewport.height, scrollWidth: clip.scrollWidth, clientWidth: clip.clientWidth},
      tabs: tabs.map(tab => {
        const rect = tab.getBoundingClientRect();
        return {height: rect.height, top: rect.top, bottom: rect.bottom, line: parseFloat(getComputedStyle(tab).lineHeight), font: parseFloat(getComputedStyle(tab).fontSize)};
      }),
    };
  });
  const textAudit = await scope.evaluate(auditTextGeometry);
  await info.attach(`compact-tabs-${enlarged ? "200pct" : "normal"}-geometry`, {contentType: "application/json", body: JSON.stringify({snapshot, textAudit})});
  expect(textAudit, "Unchanged Range text containment audit").toMatchObject({issues: []});
  expect(snapshot.clip.scrollWidth).toBeGreaterThan(snapshot.clip.clientWidth);
  for (const tab of snapshot.tabs) {
    if (!enlarged) expect(tab.height, "Compact primitive trigger baseline").toBeCloseTo(25, 1);
    else expect(tab.height).toBeGreaterThanOrEqual(tab.line);
    expect(tab.top).toBeGreaterThanOrEqual(snapshot.clip.top - 1);
    expect(tab.bottom).toBeLessThanOrEqual(snapshot.clip.bottom + 1);
  }
  if (!enlarged) expect(snapshot.height, "Compact primitive rail baseline").toBeCloseTo(32, 1);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", page.viewportSize()!.width);
  return snapshot;
}

async function focusFits(tab: Locator) {
  await expect(tab).toBeFocused();
  await expect.poll(() => tab.evaluate(element => {
    const rail = element.closest('[role="tablist"]')!;
    const viewport = rail.closest('[data-radix-scroll-area-viewport]') ?? rail.parentElement!;
    const rect = element.getBoundingClientRect(), clip = viewport.getBoundingClientRect();
    return element.matches(":focus-visible") && rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
  })).toBe(true);
  // This is computed focus styling, not a screenshot/pixel contrast claim.
  expect(await tab.evaluate(element => {
    const style = getComputedStyle(element);
    return style.outlineStyle !== "none" || style.boxShadow !== "none";
  })).toBe(true);
}

for (const kind of ["configuration", "collection"] as const) {
  for (const width of [320, 390, 1440]) {
    for (const theme of ["light", "dark"]) {
      test(`synthetic compact ${kind} tabs at ${width}px ${theme}: default and enlarged keyboard rail`, async ({page}, info) => {
        const forbidden: string[] = [];
        await page.route(/\/(?:api|feed)(?:\/|$)/, route => {
          forbidden.push("blocked API/feed request");
          return route.abort();
        });
        await page.emulateMedia({colorScheme: theme as "light" | "dark"});
        await page.setViewportSize({width, height: 1000});
        await page.goto(`/tests/compact-tabs-sample/index.html?kind=${kind}&theme=${theme}`);
        await expect(page.locator("html")).toHaveClass(new RegExp(`(?:^|\\s)${theme}(?:\\s|$)`));
        await page.evaluate(() => document.fonts.ready);
        const scope = page.getByRole("region", {name: "Tab composition"});
        const rail = scope.getByRole("tablist");
        const tabs = rail.getByRole("tab");
        await expect(tabs.first()).toBeVisible();
        if (kind === "collection") await expect(scope.locator('[data-slot="scroll-area"]')).toHaveCount(1);
        await page.keyboard.press("Tab");
        await expect(page.getByRole("button", {name: "Keyboard starting point"})).toBeFocused();
        await page.keyboard.press("Tab");
        await focusFits(tabs.first());
        const evidence = [];
        for (const enlarged of [false, true]) {
          if (enlarged) {
            const before = await tabs.first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
            await scaleText(page);
            await expect.poll(() => tabs.first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(before * 2, 2);
          }
          // Traverse real roving-tabindex navigation and scrollIntoView handlers.
          await page.keyboard.press("Home");
          await focusFits(tabs.first());
          await attachViewport(page, info, `${enlarged ? "200pct" : "normal"}-first-tab-viewport`);
          for (let index = 1; index < await tabs.count(); index++) {
            await page.keyboard.press("ArrowRight");
            await focusFits(tabs.nth(index));
            await expect(tabs.nth(index)).toHaveAttribute("aria-selected", "true");
          }
          await page.keyboard.press("Home");
          await focusFits(tabs.first());
          await page.keyboard.press("End");
          await focusFits(tabs.last());
          evidence.push({enlarged, ...await inspect(page, scope, rail, enlarged, info)});
        }
        await info.attach("compact-tabs-native-geometry", {contentType: "application/json", body: JSON.stringify({kind, width, theme, simulation: "Computed font/line-height doubled; not native zoom", evidence})});
        expect(forbidden, "Synthetic sampler makes no API/feed requests").toEqual([]);
      });
    }
  }
}
