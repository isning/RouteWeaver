import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { settledTask } from "./ui-settled-task";

// Component-only visual/interaction review. Synthetic props, no control-plane
// requests. This supplements, and never substitutes for, native backend tests.
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: {} },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string")
    throw new Error("Missing sampler address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});
for (const theme of ["light", "dark"] as const) for (const width of [1440, 390, 320]) {
  test(`route sheet groups its nodes and preserves cancellation at ${width}px in ${theme}`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 900 });
    const requests: string[] = [];
    await page.route("**/api/**", async (route) => {
      requests.push(route.request().url());
      await route.abort();
    });
    await page.goto(`${origin}/tests/route-sheet-sample/index.html`);
    await expect(page.locator("html")).toHaveClass(new RegExp(`(^| )${theme}( |$)`));
    const sheet = page.getByRole("dialog", {
      name: "编辑 香港 → 东京 → 洛杉矶",
      exact: true,
    });
    await settledTask(sheet);
    await expect(sheet).toHaveAttribute("data-task-scroll", "body");
    const workspace = sheet.getByRole("region", {
      name: "路径编排",
      exact: true,
    });
    await expect(
      workspace.getByRole("list", { name: "代理链" }).getByRole("listitem"),
    ).toHaveCount(3);
    expect(
      await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    for (const control of await workspace.getByRole("button").all()) {
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const collapsed = info.outputPath(`route-sheet-${theme}-${width}.png`);
    await page.screenshot({ path: collapsed });
    await info.attach("Synthetic route sheet overview", {
      path: collapsed,
      contentType: "image/png",
    });
    await sheet
      .getByRole("button", { name: "配置第 1 跳 香港监听", exact: true })
      .click();
    await expect(
      sheet.getByRole("combobox", { name: "第 1 跳服务器", exact: true }),
    ).toBeVisible();
    expect(
      await sheet.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    const expanded = info.outputPath(`route-sheet-expanded-${width}.png`);
    await page.screenshot({ path: expanded });
    await info.attach("Synthetic route sheet configuration", {
      path: expanded,
      contentType: "image/png",
    });
    await sheet
      .getByRole("textbox", { name: "转发路径名称" })
      .fill("待保存路径");
    await sheet.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "继续编辑", exact: true })
      .click();
    await expect(
      sheet.getByRole("textbox", { name: "转发路径名称" }),
    ).toHaveValue("待保存路径");
    if (width === 320) {
      // Keep the original normal-height review above, then exercise the same
      // route editor with one reachable scroller in a short viewport.
      await page.setViewportSize({ width, height: 320 });
      await expect(sheet).toHaveAttribute("data-task-scroll", "task");
      const body = sheet.locator("[data-task-overlay-body]");
      expect(await body.evaluate((node) => getComputedStyle(node).overflowY)).toBe("visible");
      expect((await body.boundingBox())!.height).toBeGreaterThan(200);
      const save = sheet.getByRole("button", { name: "保存草稿", exact: true });
      await save.focus();
      await expect(save).toBeFocused();
      await expect(save).toBeInViewport({ ratio: 1 });
      const name = sheet.getByRole("textbox", { name: "转发路径名称" });
      await name.focus();
      await expect(name).toBeFocused();
      await expect(name).toBeInViewport({ ratio: 1 });
      await sheet.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("alertdialog")
        .getByRole("button", { name: "继续编辑", exact: true }).click();
      await expect(name).toHaveValue("待保存路径");
      await page.setViewportSize({ width, height: 900 });
      await expect(sheet).toHaveAttribute("data-task-scroll", "body");
    }
    expect(requests).toEqual([]);
  });
}
