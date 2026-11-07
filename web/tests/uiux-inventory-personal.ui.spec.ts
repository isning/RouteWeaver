import { expect, test } from "./isolated-control-plane-fixture";
import { activate, Inventory, inviteOwner, names, read, seedPersonal, signIn } from "./uiux-inventory-helper";

test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const routes = [
  ["subscriptions", "我的订阅"], ["sources", "订阅来源"], ["collections", "节点集合"],
  ["resources", "规则资源"], ["templates", "模板与预设"], ["inbox", "消息"], ["account-security", "账号安全"],
] as const;

for (const width of [1440, 390]) for (const [route, title] of routes) {
  test(`UIUX inventory personal ${route} at ${width}px`, async ({ page, request, playwright, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const owner = await playwright.request.newContext({ baseURL });
    let inventory: Inventory | undefined;
    try {
      await inviteOwner(request, owner);
      await seedPersonal(request, owner, route);
      await signIn(page, baseURL, "user");
      inventory = new Inventory(page, info, "user", route);
      // Start observation before navigation so initial route reads are included.
      await page.goto(`/#${route}`);
      await inventory.heading(title);
      const content = page.locator(".route-content");
      switch (route) {
        case "subscriptions": {
          expect(await read(page.request, "/me/profiles")).toHaveLength(1);
          expect(await read(page.request, "/me/outputs")).toHaveLength(1);
          await expect(page.getByRole("group", { name: `客户端订阅 ${names.output}`, exact: true })).toBeVisible();
          await expect(content.getByText(names.profile, { exact: true })).toBeVisible();
          await inventory.capture("overview", "populated", "One real saved Profile and one published Output; service entitlement absent; access links never opened");
          const create = page.getByRole("button", { name: "新建分流配置", exact: true });
          await activate(page, create);
          await expect(page.getByLabel("配置名称", { exact: true })).toBeVisible();
          await inventory.capture("new-profile", "unsubmitted-task", "New local Profile editor; no save/check/publication request");
          await activate(page, page.getByRole("button", { name: "返回", exact: true }));
          await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
          await inventory.stable();
          await expect(create).toBeFocused();
          inventory.interactions.push("new local Profile: Enter open, named input visible, keyboard Return, original opener focus restored; no save");
          break;
        }
        case "sources": {
          expect(await read(page.request, "/me/sources")).toHaveLength(1);
          await expect(content.getByRole("button", { name: `${names.source} 文本导入`, exact: true })).toBeVisible();
          await inventory.capture("list", "populated", "One accepted text source with two credential-free documentation-address endpoints");
          await inventory.task(page.locator(".page-heading").getByRole("button", { name: "添加来源", exact: true }), "添加订阅来源", "add-source");
          break;
        }
        case "collections": {
          expect(await read(page.request, "/me/collections")).toHaveLength(1);
          await expect(content.getByText(names.collection, { exact: true })).toBeVisible();
          await inventory.capture("list", "populated", "One owned collection referencing the accepted two-endpoint source");
          await inventory.task(page.locator(".page-heading").getByRole("button", { name: "新建集合", exact: true }), "新建集合", "new-collection");
          break;
        }
        case "resources": {
          expect(await read(page.request, "/me/resources")).toHaveLength(1);
          await expect(content.getByText(names.resource, { exact: true })).toBeVisible();
          await inventory.capture("list", "populated", "One real accepted synthetic rule-file import; raw rule content not displayed");
          await inventory.task(page.getByRole("button", { name: "导入规则文件", exact: true }), "导入规则文件", "import-file");
          break;
        }
        case "templates": {
          expect(await read(page.request, "/templates")).toHaveLength(1);
          await expect(page.getByRole("heading", { name: names.template, exact: true })).toBeVisible();
          await expect(page.getByRole("tab", { name: "模板库", exact: true })).toHaveAttribute("aria-selected", "true");
          await inventory.capture("library", "populated", "One real administrator-published processing preset");
          await inventory.task(page.getByRole("button", { name: "查看并使用", exact: true }), names.template, "inspect-template");
          await inventory.tab("我的引用");
          expect(await read(page.request, "/me/template-bindings")).toHaveLength(1);
          await expect(content.getByText(names.template, { exact: true })).toBeVisible();
          await inventory.capture("my-bindings", "populated", "One real follow-mode binding on the owned collection; no update or publication performed");
          break;
        }
        case "inbox": {
          expect(await read(page.request, "/me/notifications")).toHaveLength(0);
          await expect(content.getByText("暂无消息", { exact: true })).toBeVisible();
          await inventory.capture("empty", "authoritative-empty", "Fresh ordinary user has no inbox items; daemon delivery/read-receipt journeys are outside this baseline");
          break;
        }
        case "account-security": {
          expect((await read(page.request, "/auth/sessions")).length).toBeGreaterThan(0);
          await expect(page.getByRole("heading", { name: "登录会话", exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { name: "账号恢复与退役", exact: true })).toHaveCount(0);
          await expect(page.getByRole("heading", { name: "管理员二次验证", exact: true })).toHaveCount(0);
          const current = page.getByLabel("当前密码", { exact: true });
          await current.focus();
          await expect(current).toBeFocused();
          await expect(current).toHaveValue("");
          await inventory.capture("ordinary-account", "configured", "Real ordinary-user self-service with current login sessions; admin recovery/MFA absent; all password inputs empty");
          inventory.interactions.push("ordinary-user security boundary asserted; current-password field focusable, no security operation submitted");
          break;
        }
      }
      inventory.finish();
    } finally {
      await inventory?.flush();
      await owner.dispose();
    }
  });
}
