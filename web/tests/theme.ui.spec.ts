import { test, expect } from "@playwright/test";
import { settledTask } from "./ui-settled-task";
for (const width of [1280, 390]) {
  test(`appearance follows system and persists explicit choice at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/tests/theme-sample/");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    const card = page.getByRole("region", { name: "Card", exact: true });
    const node = page.getByText("Entry", { exact: true });
    await expect(node).toBeVisible();
    const colors = await card.evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      text: getComputedStyle(el).color,
    }));
    await expect(node).toHaveCSS("background-color", colors.background);
    await expect(node).toHaveCSS("color", colors.text);
    await page.getByRole("button", { name: "Notify", exact: true }).click();
    await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute(
      "data-sonner-theme",
      "dark",
    );
    await page.getByLabel("外观").selectOption("light");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.reload();
    await expect(page.getByLabel("外观")).toHaveValue("light");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    await page.getByLabel("外观").selectOption("system");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

// Synthetic-only native evidence. Never inspect storage, API bodies or user data.
for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 390]) {
    test(`graph semantics and controls in ${theme} at ${width}px`, async ({ page }, info) => {
      const apiRequests: string[] = [];
      await page.route("**/api/**", async (route) => {
        apiRequests.push("unexpected API request");
        await route.abort();
      });
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/tests/theme-sample/");
      await expect(page.locator("html")).toHaveClass(new RegExp(`(^| )${theme}( |$)`));
      await expect(page.getByLabel("外观")).toHaveValue("system");
      const canvas = page.locator(".react-flow");
      const edge = page.getByRole("group", { name: "Entry to Exit", exact: true });
      const path = edge.locator(".react-flow__edge-path");
      await expect(path).toBeVisible();
      const tokens = await canvas.evaluate((el) => {
        const probe = document.createElement("span");
        el.append(probe);
        const color = (name: string) => {
          probe.style.color = `var(${name})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          primary: color("--primary"), mutedForeground: color("--muted-foreground"),
          popover: color("--popover"), popoverForeground: color("--popover-foreground"),
        };
        probe.remove();
        return result;
      });
      await expect(path).toHaveCSS("stroke", tokens.mutedForeground);
      const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
      const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });
      const fitView = page.getByRole("button", { name: "Fit view", exact: true });
      // Move away before testing resting-state colors (not hover colors).
      await page.mouse.move(0, 0);
      for (const control of [zoomIn, zoomOut, fitView]) {
        await expect(control).toHaveCSS("background-color", tokens.popover);
        await expect(control).toHaveCSS("color", tokens.popoverForeground);
      }
      await settledTask(canvas);
      const screenshot = info.outputPath(`theme-${theme}-${width}-original.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      await info.attach("Original synthetic theme", { path: screenshot, contentType: "image/png" });
      const readZoom = () => page.locator(".react-flow__viewport").evaluate((el) =>
        new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
      const initialZoom = await readZoom();
      await zoomOut.click();
      await expect.poll(readZoom).toBeLessThan(initialZoom);
      const zoomedOut = await readZoom();
      await zoomIn.click();
      await expect.poll(readZoom).toBeGreaterThan(zoomedOut);
      await fitView.click();
      await expect.poll(async () => Math.abs((await readZoom()) - initialZoom)).toBeLessThan(0.01);
      // Traverse the real tab order, including wraparound from the controls.
      // A bounded search fails rather than bypassing reachability with focus().
      let keyboardSteps = 0;
      while (!(await edge.evaluate((el) => document.activeElement === el)) && keyboardSteps < 20) {
        await page.keyboard.press("Tab");
        keyboardSteps++;
      }
      await expect(edge).toBeFocused();
      expect(await edge.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
      await page.keyboard.press("Enter");
      await expect(edge).toHaveClass(/selected/);
      await expect(path).toHaveCSS("stroke", tokens.primary);
      const selectedStroke = await path.evaluate((el) => getComputedStyle(el).stroke);
      await settledTask(canvas);
      const selectedScreenshot = info.outputPath(`theme-${theme}-${width}-selected.png`);
      await page.screenshot({ path: selectedScreenshot, fullPage: false });
      await info.attach("Keyboard-selected synthetic edge", { path: selectedScreenshot, contentType: "image/png" });
      await page.keyboard.press("Escape");
      await expect(edge).not.toHaveClass(/selected/);
      await expect(path).toHaveCSS("stroke", tokens.mutedForeground);
      const ledger = await page.evaluate(() => {
        const selectors = {
          canvas: ".react-flow", node: '.react-flow__node[data-id="one"]',
          edge: ".react-flow__edge-path", controls: ".react-flow__controls",
        };
        return Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
          const el = document.querySelector(selector)!;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return [name, {
            color: style.color, background: style.backgroundColor, stroke: style.stroke,
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          }];
        }));
      });
      await info.attach("Synthetic color and geometry ledger", {
        body: JSON.stringify({ theme, viewport: { width, height: 850 }, tokens,
          selectedStroke, keyboardSteps, initialZoom, zoomedOut, restoredZoom: await readZoom(), surfaces: ledger }, null, 2),
        contentType: "application/json",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(apiRequests).toEqual([]);
    });
  }
}
