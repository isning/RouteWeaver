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
for (const width of [1440, 390, 320]) {
  test(`route sheet groups its nodes and preserves cancellation at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: string[] = [];
    await page.route("**/api/**", async (route) => {
      requests.push(route.request().url());
      await route.abort();
    });
    await page.goto(`${origin}/tests/route-sheet-sample/index.html`);
    const sheet = page.getByRole("dialog", {
      name: "编辑 香港 → 东京 → 洛杉矶",
      exact: true,
    });
    await settledTask(sheet);
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
    const collapsed = info.outputPath(`route-sheet-${width}.png`);
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
    expect(requests).toEqual([]);
  });
}
