import { test, expect } from "@playwright/test";

test("rule editor keeps aligned columns, responsive controls and actual rule ordering", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/tests/rules-sample/");
      await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
      await page.getByRole("tab", { name: "分流规则", exact: true }).click();
      const rules = page.locator(".rule-card");
      await expect(rules).toHaveCount(2);
      await rules.first().scrollIntoViewIfNeeded();
      const layout = await rules.first().evaluate(row => {
        const boxes = [...row.children].map(child => {
          const { x, y, width } = child.getBoundingClientRect(); return { x, y, width };
        });
        return { columns: getComputedStyle(row).gridTemplateColumns.split(" ").length, boxes };
      });
      expect(layout.columns).toBe(width === 1280 ? 4 : 1);
      if (width === 1280) {
        expect(Math.abs(layout.boxes[2].y - layout.boxes[3].y)).toBeLessThan(1);
        const header = await rules.first().locator("..").locator(":scope > div").first().evaluate(el =>
          [...el.children].map(child => child.getBoundingClientRect().x));
        expect(layout.boxes[0].x).toBeCloseTo(header[0], 0);
        expect(layout.boxes[2].x).toBeCloseTo(header[1], 0);
        expect(layout.boxes[3].x).toBeCloseTo(header[2], 0);
        expect(layout.boxes[1].x).toBeCloseTo(header[3], 0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`rules-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.getByRole("button", { name: "下移规则 1", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "规则匹配值" }).first()).toHaveValue("10.0.0.0/8");
  await page.getByRole("button", { name: "删除规则 1", exact: true }).click();
  await expect(page.locator(".rule-card")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "规则匹配值" })).toHaveValue("example.com");
  expect(errors).toEqual([]);
});
