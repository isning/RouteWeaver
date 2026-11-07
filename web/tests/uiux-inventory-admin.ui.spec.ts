import { expect, test } from "./isolated-control-plane-fixture";
import { activate, Inventory, inviteOwner, names, read, seedAdmin, seedPersonal, signIn } from "./uiux-inventory-helper";

test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const routes = [
  ["published-routes", "线路"], ["routes", "转发路径"], ["servers", "服务器"], ["fleet", "执行任务"],
  ["users", "用户"], ["services", "服务方案"], ["activity", "变更记录"], ["settings", "平台设置"],
  ["nodes", "连接端点"], ["legacy-routes", "链路配置"], ["notifications", "公告与通知"],
  // Supplemental ROLE views of existing personal routes, not extra main routes.
  ["account-security", "账号安全"], ["templates", "模板与预设"],
] as const;

for (const width of [1440, 390]) for (const [route, title] of routes) {
  test(`UIUX inventory admin ${route} at ${width}px`, async ({ page, request, playwright, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const owner = await playwright.request.newContext({ baseURL });
    let inventory: Inventory | undefined;
    try {
      const userId = await inviteOwner(request, owner);
      await seedAdmin(request, route, userId);
      if (route === "templates") await seedPersonal(request, request, route);
      await signIn(page, baseURL, "admin");
      inventory = new Inventory(page, info, "admin", route);
      // Start observation before navigation so initial route reads are included.
      await page.goto(`/#${route}`);
      await inventory.heading(title);
      const content = page.locator(".route-content");
      // Responsive action targets repeat the object name. Assert the identity
      // control/cell in its named row, not either occurrence of visible text.
      const objectRow = (name: string) => content.getByRole("row").filter({
        has: page.getByRole("group", { name: `${name} 的操作`, exact: true }),
      });
      const primary = (name: string) => page.locator(".page-heading").getByRole("button", { name, exact: true });
      switch (route) {
        case "published-routes": {
          expect(await read(page.request, "/published-routes")).toHaveLength(1);
          await expect(objectRow(names.line).getByRole("button", { name: names.line, exact: true })).toBeVisible();
          await inventory.capture("draft-list", "populated", "One saved published-route draft on a real managed-Xray path; no registered Agent, applied state, user provisioning or live traffic");
          await inventory.task(primary("配置公开线路"), "配置公开线路", "new-line");
          break;
        }
        case "routes": {
          expect(await read(page.request, "/server-deployments")).toHaveLength(1);
          await expect(objectRow(names.deployment).getByRole("button", { name: names.deployment, exact: true })).toBeVisible();
          await inventory.capture("draft-list", "populated", "One saved real server-deployment draft; unregistered runtime, no validation/application");
          await inventory.task(primary("新建转发路径"), "新建转发路径", "new-path");
          break;
        }
        case "servers": {
          expect(await read(page.request, "/hosts")).toHaveLength(1);
          await expect(content.getByText(names.host, { exact: true })).toBeVisible();
          await inventory.capture("hosts", "populated", "One loopback synthetic host registered as inventory only; observations remain unknown");
          await inventory.task(primary("添加服务器"), "添加服务器", "add-host");
          await inventory.tab("核心实例 1");
          expect(await read(page.request, "/core-instances")).toHaveLength(1);
          await expect(content.getByRole("button", { name: `${names.core} 26.3.27-rw1`, exact: true })).toBeVisible();
          await inventory.capture("core-instances", "populated", "One configured managed-Xray core instance, not enrolled or running");
          await inventory.task(primary("添加核心实例"), "添加核心实例", "add-core");
          await inventory.tab("监听端点 1");
          expect(await read(page.request, "/managed-endpoints")).toHaveLength(1);
          await expect(objectRow(names.listener).getByRole("cell", { name: names.listener, exact: true })).toBeVisible();
          await inventory.capture("managed-listeners", "populated", "One configured VLESS listener, masked by production presentation; no reveal endpoint or live listening socket");
          await inventory.task(primary("添加监听端点"), "添加监听端点", "add-listener");
          break;
        }
        case "fleet": {
          expect(await read(page.request, "/admin/fleet-batches")).toHaveLength(0);
          await expect(content.getByText("暂无批量变更", { exact: true })).toBeVisible();
          await inventory.capture("empty-history", "authoritative-empty", "Normal bootstrap has no batch changes and no infrastructure; no fake planned/executed/succeeded task");
          await inventory.task(primary("计划变更"), "计划批量变更", "plan-change");
          break;
        }
        case "users": {
          const state = await read(page.request, "/state");
          expect(state.users.some((user: { id: string }) => user.id === userId)).toBe(true);
          expect(await read(page.request, "/user-groups")).toHaveLength(1);
          await expect(objectRow(names.account).getByRole("button", { name: names.account, exact: true })).toBeVisible();
          await expect(objectRow(names.group).getByRole("cell", { name: names.group, exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { name: "用户组", exact: true })).toBeVisible();
          await inventory.capture("users-and-groups", "populated", "Real invited user plus one group applied through real policy preview/revision; user groups are a section, not a tab");
          await inventory.task(primary("添加用户"), "添加用户", "add-user");
          await inventory.task(primary("邀请用户"), "邀请用户", "invite-user");
          await inventory.task(page.getByRole("button", { name: "新建用户组", exact: true }), "新建用户组", "new-group");
          break;
        }
        case "services": {
          expect(await read(page.request, "/services")).toHaveLength(1);
          await expect(objectRow(names.service).getByRole("cell", { name: names.service, exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { name: "线路扣量倍率", exact: true })).toBeVisible();
          expect(await read(page.request, "/rates")).toHaveLength(0);
          await inventory.capture("plans-and-rates", "populated", "One real service plan; authoritative empty rate history, no grant or renewal submitted");
          await inventory.task(primary("新建方案"), "新建服务方案", "new-plan");
          break;
        }
        case "activity": {
          expect((await read(page.request, "/audit")).length).toBeGreaterThan(0);
          expect((await read(page.request, "/state")).revisions).toHaveLength(0);
          await expect(page.getByRole("heading", { name: "操作审计", exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { name: "链路配置生成记录", exact: true })).toBeVisible();
          await expect(content.getByText("还没有配置记录", { exact: true })).toBeVisible();
          await inventory.capture("audit-and-config-history", "populated", "Real invite/service audit rows; authoritative empty configuration history. Two sections, not tabs; no raw generated config captured");
          break;
        }
        case "settings": {
          await read(page.request, "/settings");
          await expect(page.getByRole("heading", { name: "订阅域名", exact: true })).toBeVisible();
          await expect(page.getByRole("tab", { name: "基本设置", exact: true })).toHaveAttribute("aria-selected", "true");
          await inventory.capture("basic-and-domain", "configured", "Normal bootstrap platform settings and authoritative subscription-domain state; no external domain check");
          const edit = page.getByRole("button", { name: "编辑平台名称", exact: true });
          await activate(page, edit);
          await expect(page.getByLabel("平台名称", { exact: true })).toBeFocused();
          await inventory.capture("edit-platform-name", "unsubmitted-task", "Inline platform-name editor opened, unchanged and not saved");
          await activate(page, page.getByRole("button", { name: "取消名称修改", exact: true }));
          await expect(edit).toBeFocused();
          inventory.interactions.push("platform name: Enter open, input focus, unchanged keyboard Cancel, opener focus restored");
          await inventory.tab("账号安全");
          await expect(page.getByRole("heading", { name: "管理员二次验证", exact: true })).toBeVisible();
          await inventory.capture("security-tab", "configured", "Platform settings security tab is administrator MFA setup entry, distinct from ordinary-user account security; setup not started, no secret/QR");
          await inventory.tab("备份与恢复");
          await expect(page.getByRole("heading", { name: "完整加密备份", exact: true })).toBeVisible();
          await expect(page.getByRole("heading", { name: "恢复备份", exact: true })).toBeVisible();
          await inventory.capture("backup-tab", "configured", "Real backup/restore entry, no export/import/restore or password entered");
          await inventory.task(page.getByRole("button", { name: "创建加密备份", exact: true }), "创建加密备份", "create-backup");
          break;
        }
        case "nodes": {
          expect((await read(page.request, "/state")).nodes).toHaveLength(1);
          await expect(content.getByRole("button", { name: `${names.node} 未设置地区`, exact: true })).toBeVisible();
          await inventory.capture("list", "populated", "One credential-free documentation-address endpoint; no probe/connection, health unknown");
          await inventory.task(primary("添加端点"), "添加端点", "add-endpoint");
          break;
        }
        case "legacy-routes": {
          expect((await read(page.request, "/state")).routes).toHaveLength(1);
          await expect(content.getByRole("button", { name: `${names.legacy} 单端点链路`, exact: true })).toBeVisible();
          await inventory.capture("list", "populated", "One saved legacy chain referencing a synthetic endpoint; no validation or native application");
          await inventory.task(primary("新建链路配置"), "新建链路配置", "new-legacy-chain");
          break;
        }
        case "notifications": {
          expect(await read(page.request, "/admin/announcements")).toHaveLength(1);
          await expect(objectRow(names.announcement).getByRole("cell", { name: names.announcement, exact: true })).toBeVisible();
          await inventory.capture("announcements", "populated", "One real disabled future announcement; no notification scheduled for sending");
          await inventory.task(page.getByRole("button", { name: "创建公告", exact: true }), "创建公告", "new-announcement");
          await inventory.tab("提醒与渠道");
          const channels = await read(page.request, "/admin/notification-settings");
          expect(channels.email.enabled).toBe(false);
          expect(channels.webhook.enabled).toBe(false);
          await expect(page.getByRole("heading", { name: "提醒与发送渠道", exact: true })).toBeVisible();
          await inventory.capture("channels", "configured", "Real notification defaults; email/webhook disabled, no credentials and no send/check submission");
          await inventory.tab("发送记录");
          expect(await read(page.request, "/admin/notifications/outbox")).toHaveLength(0);
          await expect(content.getByText("暂无发送记录", { exact: true })).toBeVisible();
          await inventory.capture("outbox", "authoritative-empty", "Real empty outbox, not a fabricated success/delivery fixture");
          break;
        }
        case "templates": {
          expect(await read(page.request, "/templates")).toHaveLength(1);
          await expect(page.getByRole("heading", { name: names.template, exact: true })).toBeVisible();
          await expect(primary("发布模板")).toBeVisible();
          await inventory.capture("admin-library", "populated", "Supplemental administrator template-author role: one shared preset and owned collection; distinct from ordinary-user library");
          await inventory.task(primary("发布模板"), "发布共享模板", "author-template");
          break;
        }
        case "account-security": {
          expect((await read(page.request, "/admin/accounts")).length).toBeGreaterThan(1);
          await expect(page.getByRole("heading", { name: "账号恢复与退役", exact: true })).toBeVisible();
          await inventory.capture("admin-account", "configured", "Supplemental admin role view; own-account forms and real invited-user recovery list, no mutations");
          await inventory.task(page.getByRole("button", { name: `管理 ${names.account}`, exact: true }), `管理 ${names.account} 的账号`, "recovery-settled");
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
