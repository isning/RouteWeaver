import type { Locator } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { demoPassword, signInAPI } from "./account-security-backend";
import { names, seedInfrastructure, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Public UI against a fresh normal-CLI database per test. These are inventory
// readability checks, not runtime validation, application or traffic evidence.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function completeSingleLine(element: Locator, text: string, surface: Locator) {
  await expect(element).toHaveText(text);
  await element.scrollIntoViewIfNeeded();
  await settledTask(surface);
  await expect(element).toBeInViewport({ ratio: 1 });
  const layout = await element.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const bounds = node.getBoundingClientRect();
    const rects = Array.from(range.getClientRects());
    return {
      lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
      contained: rects.every((rect) =>
        rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 &&
        rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
      ),
      ellipsis: getComputedStyle(node).textOverflow,
    };
  });
  // These short names fit intact on one line each. Longer names may wrap.
  expect(layout.lines).toBe(1);
  expect(layout.contained).toBe(true);
  expect(layout.ellipsis).not.toBe("ellipsis");
}

for (const width of [390, 1440]) {
  test(`forwarding path retains readable listener and server identity at ${width}px`, async ({ page, request, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await signInAPI(request, "routeweaver", demoPassword);
    await seedInfrastructure(request);
    await signIn(page, baseURL, "admin");
    await page.goto("/#routes");
    const table = page.getByRole("table");
    await expect(table).toHaveAccessibleDescription("共 1 条转发路径");
    await expect(table.getByRole("columnheader", { name: "监听与转发", exact: true })).toBeVisible();
    const row = table.getByRole("row").filter({
      has: page.getByRole("button", { name: names.deployment, exact: true }),
    });
    await expect(row.getByRole("cell")).toHaveCount(6);
    const forwarding = row.getByRole("region", { name: `${names.listener}的转发`, exact: true });
    await expect(forwarding.getByText("直连", { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const surface = page.locator(".route-content");
    await completeSingleLine(forwarding.getByText(names.listener, { exact: true }), names.listener, surface);
    await completeSingleLine(forwarding.getByText(names.host, { exact: true }), names.host, surface);
    if (width === 390) {
      await expect(page.getByRole("region", { name: "表格滚动区域", exact: true })).toHaveAttribute("tabindex", "0");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`forwarding-identity-${width}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(`forwarding-identity-${width}`, {
      path: screenshot, contentType: "image/png",
    });
  });

  test(`connection endpoint totals keep the page vocabulary through filtering at ${width}px`, async ({ page, request, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await signInAPI(request, "routeweaver", demoPassword);
    const created = await request.post("/api/nodes", {
      headers: { "X-CSRF-Token": session.csrfToken },
      data: { id: "identity-endpoint", name: names.node, protocol: "socks", host: "192.0.2.40", port: 1080, status: "unknown" },
    });
    expect(created.ok()).toBe(true);
    await signIn(page, baseURL, "admin");
    await page.goto("/#nodes");
    await expect(page.getByRole("heading", { name: "连接端点", exact: true })).toBeVisible();
    const table = page.getByRole("table");
    await expect(table).toHaveAccessibleDescription("共 1 个连接端点");
    await expect(page.getByText("共 1 个连接端点", { exact: true })).toBeVisible();
    const search = page.getByRole("textbox", { name: "搜索连接端点", exact: true });
    await search.fill("没有匹配的端点");
    await expect(table).toHaveAccessibleDescription(/找到 0 个连接端点\s*共 1 个连接端点/);
    await search.fill("");
    await expect(table).toHaveAccessibleDescription("共 1 个连接端点");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await table.scrollIntoViewIfNeeded();
    await settledTask(page.locator(".route-content"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`endpoint-count-${width}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach(`endpoint-count-${width}`, {
      path: screenshot, contentType: "image/png",
    });
  });
}
