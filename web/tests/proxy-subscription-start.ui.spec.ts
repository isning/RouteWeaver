import type { Locator } from "@playwright/test";
import { test as isolatedTest, expect } from "./isolated-control-plane-fixture";
import { settledTask } from "./ui-settled-task";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";

const test = isolatedTest.extend({
  page: async ({ page }, use) => {
    try { await use(page); } finally { await page.close(); }
  },
});
test.use({ trace: "off", screenshot: "off", video: "off" });

test("existing proxy task imports a source and explicitly publishes a named client subscription", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("routeweaver");
  await page.getByLabel("密码", { exact: true }).fill("local-demo-password");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await waitForConfirmedWorkspace(page);
  const publicationWrites: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/me\/outputs(?:\/[^/]+\/publish)?$/.test(path)) publicationWrites.push(path);
  });
  const capture = async (state: string, surface: Locator) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await surface.scrollIntoViewIfNeeded();
      await settledTask(surface);
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-sonner-toast]:visible")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const name = `proxy-subscription-${state}-${width}.png`;
      const path = info.outputPath(name);
      await page.screenshot({ path, mask: [page.getByRole("textbox", { name: "订阅链接", exact: true }), page.locator(".qr-container")], animations: "disabled" });
      await info.attach(name, { path, contentType: "image/png" });
    }
  };
  const start = page.getByRole("button", { name: "用已有代理生成订阅", exact: true });
  await expect(start).toBeVisible();
  await capture("choose-task", start);
  await start.click();
  await expect(page.getByRole("heading", { name: "订阅来源", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "添加来源", exact: true }).first().click();
  const importer = page.getByRole("dialog", { name: "添加订阅来源", exact: true });
  await importer.getByLabel("来源名称", { exact: true }).fill("我的伦敦代理");
  await importer.getByLabel("节点链接或配置内容", { exact: true }).fill("socks5://192.0.2.40:1080#London%20Work");
  await importer.getByRole("button", { name: "导入来源", exact: true }).click();
  await expect(importer).toHaveCount(0);
  const accepted = page.getByRole("region", { name: "继续设置订阅", exact: true });
  await expect(accepted).toContainText("已导入「我的伦敦代理」");
  await expect(accepted).toContainText("1 个连接");
  expect(publicationWrites).toEqual([]);
  await accepted.getByRole("button", { name: "继续设置订阅", exact: true }).click();
  await expect(page.getByRole("heading", { name: "新建分流配置", level: 1 })).toBeVisible();
  await page.getByRole("textbox", { name: "配置名称", exact: true }).fill("工作代理分流");
  await expect(page.getByRole("combobox", { name: "使用的订阅来源", exact: true }).locator("xpath=ancestor::label")).toContainText("我的伦敦代理");
  const traffic = page.getByRole("combobox", { name: "默认流量行为", exact: true });
  await expect(traffic).toHaveText("直连");
  await expect(page.getByText("1 个有效连接", { exact: true })).toBeVisible();
  await traffic.click();
  await page.getByRole("option", { name: "London Work", exact: true }).click();
  await expect(traffic).toContainText("London Work");
  await capture("selected-proxy", page.locator(".profile-traffic-task"));
  await page.getByRole("button", { name: "保存并检查", exact: true }).click();
  const client = page.getByRole("dialog", { name: "新增客户端订阅", exact: true });
  await client.getByLabel("订阅名称", { exact: true }).fill("工作电脑 sing-box");
  await client.getByLabel("目标客户端", { exact: true }).click();
  await page.getByRole("option", { name: "sing-box 1.14.3", exact: true }).click();
  await client.getByRole("button", { name: "检查发布内容", exact: true }).click();
  const publish = client.getByRole("button", { name: "创建并发布「工作电脑 sing-box」", exact: true });
  await expect(publish).toBeEnabled();
  expect(publicationWrites).toEqual([]);
  await capture("named-client-review", client);
  await publish.click();
  const result = page.getByRole("dialog", { name: "获取「工作电脑 sing-box」", exact: true });
  await expect(result).toBeVisible();
  expect(publicationWrites).toEqual(["/api/me/outputs"]);
  await capture("named-client-result", result);
  const profiles = await (await page.request.get("/api/me/profiles")).json();
  expect(profiles).toHaveLength(1);
  expect(profiles[0].sourceIds).toHaveLength(1);
  expect(profiles[0].ir.defaultAction.kind).toBe("endpoint");
  const outputs = await (await page.request.get("/api/me/outputs")).json();
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toMatchObject({ name: "工作电脑 sing-box", profileId: profiles[0].id, status: "published", target: { adapterId: "sing-box", version: "1.14.3" } });
});
