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
          await expect(page.getByRole("row", { name: `客户端订阅 ${names.output}`, exact: true })).toBeVisible();
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
          const evidence = inventory;
          await inventory.task(page.locator(".page-heading").getByRole("button", { name: "添加来源", exact: true }), "添加订阅来源", "add-source", async (dialog) => {
            if (width !== 390) return;
            const mode = dialog.getByRole("combobox", { name: "更新应用方式", exact: true });
            const enabled = dialog.getByRole("switch", { name: "启用来源", exact: true });
            await evidence.tabTo(dialog, mode);
            await expect(mode).toHaveText("自动应用");
            await evidence.tabTo(dialog, enabled);
            await expect(enabled).toBeChecked();
            await expect(dialog.getByRole("textbox", { name: "来源名称", exact: true })).toHaveValue("");
            await expect(dialog.getByRole("textbox", { name: "节点链接或配置内容", exact: true })).toHaveValue("");
            const completion = dialog.getByRole("group", { name: "来源导入确认", exact: true });
            for (const target of [mode, enabled,
              dialog.getByText("首次导入立即可用。后续更新按此方式应用到来源，不会自动发布订阅。", { exact: true }),
              completion,
              completion.getByText("订阅信息由平台解析并加密保存，仅供你的账号使用。", { exact: true }),
              completion.getByRole("button", { name: "取消", exact: true }),
              completion.getByRole("button", { name: "导入来源", exact: true }),
            ]) await evidence.inView(target);
            await evidence.capture("add-source-lower", "unsubmitted-task", "Native Tab reached unchanged auto-update mode and enabled switch; complete update/publication consequence and privacy/Cancel/Import region visible inside their actual clips; source name/content remain empty", dialog);
            evidence.interactions.push("Source lower frame: native Tab to update mode and enabled switch, unchanged values, full consequence/privacy/completion geometry; no file selection, edits or import");
          });
          if (width === 390) {
            const viewport = content.getByRole("region", { name: "表格滚动区域", exact: true });
            const row = content.getByRole("row").filter({ has: page.getByRole("group", { name: `${names.source} 的操作`, exact: true }) });
            const updated = viewport.getByRole("columnheader", { name: "最近更新", exact: true });
            // Resolve the cell from its real semantic column, not an arbitrary row index.
            const updatedCell = row.getByRole("cell").nth(await updated.evaluate((element) => (element as HTMLTableCellElement).cellIndex));
            await expect(updatedCell).not.toHaveText("");
            await inventory.wheelColumns(viewport, [updated, updatedCell, row.getByRole("cell", { name: "已导入", exact: true })]);
            await inventory.capture("list-updated", "populated", "Real horizontal wheel reveals the accepted source status and full last-update column/cell; original left-side identity capture retained");
            const actions = row.getByRole("group", { name: `${names.source} 的操作`, exact: true });
            await inventory.wheelColumns(viewport, [actions]);
            await inventory.inView(actions.getByText(names.source, { exact: true }));
            await inventory.inView(actions.getByRole("button", { name: `更多操作 ${names.source}`, exact: true }));
            await inventory.capture("list-actions", "populated", "Real horizontal wheel reveals the named source action group and More action without opening the menu or refreshing the source");
            inventory.interactions.push("Source table: real horizontal wheel, settled native scroll, full status/update and named action geometry in separate frames; no action activated");
          }
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
          const resourceRow = content.getByRole("row").filter({
            has: page.getByRole("group", { name: `${names.resource} 的操作`, exact: true }),
          });
          await expect(resourceRow.getByRole("button", { name: names.resource, exact: true })).toBeVisible();
          await inventory.capture("list", "populated", "One real accepted synthetic rule-file import; raw rule content not displayed");
          await inventory.task(page.getByRole("button", { name: "导入规则文件", exact: true }), "导入规则文件", "import-file");
          if (width === 390) {
            const viewport = content.getByRole("region", { name: "表格滚动区域", exact: true });
            const delivery = resourceRow.getByRole("cell").filter({ has: page.getByText("随配置打包", { exact: true }) });
            const visibility = resourceRow.getByRole("cell", { name: "私有", exact: true });
            await inventory.wheelColumns(viewport, [viewport.getByRole("columnheader", { name: "文件交付", exact: true }), delivery, visibility]);
            await inventory.capture("list-delivery", "populated", "Real horizontal wheel reveals the complete accepted-file delivery/size and private visibility cells; no file bytes or download URL exposed");
            const actions = resourceRow.getByRole("group", { name: `${names.resource} 的操作`, exact: true });
            await inventory.wheelColumns(viewport, [actions]);
            await inventory.inView(actions.getByText(names.resource, { exact: true }));
            await inventory.inView(actions.getByRole("button", { name: "替换文件", exact: true }));
            await inventory.capture("list-actions", "populated", "Real horizontal wheel reveals the exact resource identity and Replace File action; replacement is not opened or submitted");
            inventory.interactions.push("Resource table: real horizontal wheel, settled native scroll, full delivery/visibility and named replacement action geometry in separate frames");
          }
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
          const row = content.getByRole("row").filter({ has: page.getByRole("button", { name: `检查更新 ${names.collection}`, exact: true }) });
          const actions = row.getByRole("group", { name: `${names.collection} 使用 ${names.template} 的操作`, exact: true });
          const action = actions.getByRole("button", { name: `检查更新 ${names.collection}`, exact: true });
          if (width === 390) {
            const viewport = content.getByRole("region", { name: "表格滚动区域", exact: true });
            const mode = row.getByRole("cell", { name: "跟随版本", exact: true });
            const version = row.getByRole("cell", { name: "v1", exact: true });
            await inventory.wheelColumns(viewport, [mode, version]);
            await inventory.inView(viewport.getByRole("columnheader", { name: "当前版本", exact: true }));
            await inventory.capture("my-bindings-version", "populated", "Real horizontal wheel reveals unchanged follow mode and applied v1");
            await inventory.wheelColumns(viewport, [actions]);
            await inventory.inView(actions.getByText(`${names.collection} 使用 ${names.template}`, { exact: true }));
            await inventory.inView(action);
            await inventory.capture("my-bindings-actions", "populated", "Real horizontal wheel reveals full target and template context beside Check Update; no inspection/update request activated");
            inventory.interactions.push("Template reference table: real horizontal wheel, full mode/version then full target/template/action geometry; no check-update request or mutation");
          } else {
            await inventory.inView(row.getByText(names.collection, { exact: true }));
            await inventory.inView(row.getByText(names.template, { exact: true }));
            await inventory.inView(action);
          }
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
