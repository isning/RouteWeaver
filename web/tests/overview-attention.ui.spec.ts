import { test, expect } from "@playwright/test";

test("attention panel keeps its reference hierarchy in both themes and narrow enlarged text", async ({
  page,
}, info) => {
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const fixtures: Record<string, unknown> = {
      "/api/me/sources": [
        {
          id: "source",
          name: "演示来源",
          enabled: true,
          refreshStatus: "failed",
        },
      ],
      "/api/me/resources": [
        {
          id: "resource",
          name: "演示规则",
          canRefresh: true,
          refreshStatus: "failed",
        },
      ],
      "/api/me/profiles": [],
      "/api/me/outputs": [],
      "/api/me/actions": {
        items: [
          {
            id: "output:o",
            kind: "output-changed",
            title: "演示订阅有改动待发布",
            description: "查看变更后再发布。",
            href: "#subscriptions?output=o",
            priority: "normal",
          },
        ],
        partial: false,
        uncheckedOutputs: [],
      },
    };
    if (route.request().method() !== "GET" || !(path in fixtures)) {
      unexpected.push(path);
      await route.abort();
      return;
    }
    await route.fulfill({ json: fixtures[path] });
  });
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/tests/attention-sample/");
      await page.evaluate((theme) => {
        document.documentElement.className = theme;
        document.documentElement.style.colorScheme = theme;
      }, theme);
      const panel = page.getByRole("region", { name: /需要你处理/ });
      await expect(
        panel.getByRole("button", { name: "检查订阅" }),
      ).toBeVisible();
      await expect(panel.locator("li")).toHaveCount(3);
      await expect(panel.locator(".lucide-file-input")).toBeVisible();
      await expect(panel.locator(".lucide-file-warning")).toBeVisible();
      await expect(panel.locator(".lucide-circle-alert")).toBeVisible();
      if (width === 320)
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const button of await panel.getByRole("button").all()) {
        await button.focus();
        await expect(button).toBeInViewport({ ratio: 1 });
      }
      const path = info.outputPath(`attention-${theme}-${width}.png`);
      await page.screenshot({ path, fullPage: true, animations: "disabled" });
      await info.attach(`Attention ${theme} ${width}`, {
        path,
        contentType: "image/png",
      });
    }
  }
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});
