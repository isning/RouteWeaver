import { test, expect } from "@playwright/test";
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
