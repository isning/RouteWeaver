import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { headers, read, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Real isolated HTTP persistence, with synthetic administrator connectors only.
// Never import a tenant source, enroll an agent, or apply to a running core.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
async function choose(page: Page, control: Locator, query: string) {
  await control.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
  await search.fill(query);
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(page.getByRole("listbox", { includeHidden: true })).toHaveCount(0);
}
async function hopAction(editor: Locator, hop: number, label: string) {
  await editor.getByRole("button", { name: `第 ${hop} 跳更多操作`, exact: true }).click();
  // shadcn renders the menu in the workspace portal, outside the editor dialog.
  const menu = editor.page().getByRole("menu", { name: `第 ${hop} 跳更多操作`, exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
}
async function configure(editor: Locator, hop: number) {
  const trigger = editor.getByRole("button", { name: new RegExp(`^配置第 ${hop} 跳 `) });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}
for (const width of [1440, 390, 320]) {
  test(`one mixed chain inserts and edits existing external proxies at ${width}px`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    const csrf = await headers(page.request);
    const programs = [];
    for (const [index, id] of ["a", "b"].entries()) {
      const instance = { id: `${id}-core`, hostId: id,
        adapterId: index === 0 ? "routeweaver/managed-xray" : "routeweaver/xray",
        version: index === 0 ? "26.3.27-rw1" : "26.10.31" };
      const listener = { id, instanceId: instance.id, name: `${id} 监听`,
        connection: index === 0
          ? { protocol: "vless", host: "127.0.0.1", port: 23080, uuid: "00000000-0000-4000-8000-000000000099" }
          : { protocol: "socks", host: "127.0.0.1", port: 23080 + index, username: "fixture", password: "synthetic-only" } };
      for (const [path, data] of [
        ["/hosts", { id, name: `${id} 服务器`, address: "127.0.0.1" }],
        ["/core-instances", instance], ["/managed-endpoints", listener],
      ] as const) {
        const response = await page.request.post(`/api${path}`, { headers: csrf, data });
        expect(response.status(), `Create synthetic ${path}`).toBe(200);
      }
      programs.push({ instance, listener, egress: [], rules: [], resources: [], defaultAction: { kind: "direct" } });
    }
    const deployment = { id: "mixed-chain", name: "混合代理链", status: "draft", diagnostics: [],
      ir: { schemaVersion: "1.0", id: "mixed-chain", topologyRevision: "one", programs: [
        { ...programs[0], defaultAction: { kind: "forward", ref: "bridge-b" }, connectors: [
          { id: "bridge-b", connection: programs[1].listener.connection },
          ...["proxy-x", "proxy-y"].map((id, index) => ({ id, connection: {
            protocol: "socks", host: `${id}.example.invalid`, port: 24080 + index,
            username: "synthetic-admin", password: "synthetic-secret",
          } })),
        ] }, { ...programs[1], connectors: [{ id: "proxy-z", connection: {
          protocol: "socks", host: "proxy-z.example.invalid", port: 24082,
          username: "synthetic-admin", password: "synthetic-secret",
        } }] },
      ] } };
    expect((await page.request.post("/api/server-deployments", { headers: csrf, data: deployment })).status()).toBe(200);
    const mutations: string[] = [];
    const privateSourceReads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) mutations.push(`${request.method()} ${path}`);
      if (/^\/api\/(?:me\/)?(?:sources|subscriptions|imports)(?:\/|$)/.test(path)) privateSourceReads.push(path);
    });
    await page.goto("/#routes");
    await page.getByRole("button", { name: "编辑转发路径 混合代理链", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑 混合代理链", exact: true });
    const summary = editor.getByRole("region", { name: "路径摘要", exact: true });
    const save = editor.getByRole("button", { name: "保存草稿", exact: true });
    await expect(summary).toContainText("a 监听 → b 监听 → 目标");
    await expect(editor.getByRole("region", { name: "最终出口", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("tab", { name: "图形编辑", exact: true })).toHaveCount(0);
    const insert = editor.getByRole("button", { name: "第 1 跳更多操作", exact: true });
    await hopAction(editor, 1, "在第 1 跳后插入下一跳");
    await expect(save).toBeDisabled();
    await choose(page, editor.getByRole("combobox", { name: "第 2 跳类型", exact: true }), "外部代理");
    await editor.getByRole("button", { name: "取消添加", exact: true }).click();
    await expect(insert).toBeFocused();
    await expect(summary).toContainText("a 监听 → b 监听 → 目标");
    await hopAction(editor, 1, "在第 1 跳后插入下一跳");
    await choose(page, editor.getByRole("combobox", { name: "第 2 跳类型", exact: true }), "外部代理");
    await choose(page, editor.getByRole("combobox", { name: "第 2 跳外部代理", exact: true }), "proxy-x");
    await expect(editor.getByRole("button", { name: "配置第 2 跳 proxy-x", exact: true })).toBeFocused();
    await hopAction(editor, 2, "在第 2 跳后插入下一跳");
    await choose(page, editor.getByRole("combobox", { name: "第 3 跳类型", exact: true }), "外部代理");
    await choose(page, editor.getByRole("combobox", { name: "第 3 跳外部代理", exact: true }), "proxy-y");
    await expect(summary).toContainText("a 监听 → proxy-x → proxy-y → b 监听 → 目标");
    await expect(editor.getByRole("list", { name: "代理链", exact: true }).getByRole("listitem")).toHaveCount(4);
    await editor.getByRole("button", { name: "第 3 跳更多操作", exact: true }).click();
    const thirdHopMenu = page.getByRole("menu", { name: "第 3 跳更多操作", exact: true });
    await expect(thirdHopMenu.getByRole("menuitem", { name: "下移第 3 跳", exact: true })).toBeDisabled();
    await expect(editor).not.toContainText("example.invalid");
    await expect(editor).not.toContainText("synthetic-secret");
    await thirdHopMenu.getByRole("menuitem", { name: "上移第 3 跳", exact: true }).click();
    await expect(summary).toContainText("a 监听 → proxy-y → proxy-x → b 监听 → 目标");
    await hopAction(editor, 2, "下移第 2 跳");
    await expect(summary).toContainText("a 监听 → proxy-x → proxy-y → b 监听 → 目标");
    await configure(editor, 2);
    const readOnly = editor.getByRole("button", { name: "第 2 跳连接参数只读原因", exact: true });
    await expect(editor.getByRole("button", { name: "编辑第 2 跳外部代理连接参数", exact: true })).toHaveCount(0);
    await expect(editor.getByText("此监听关联用户入口或托管计量，连接器仅供查看。", { exact: true })).toHaveCount(0);
    await readOnly.click();
    await expect(page.getByText("此监听关联用户入口或托管计量，连接器仅供查看。", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(readOnly).toBeFocused();
    await expect(editor.getByText("此监听关联用户入口或托管计量，连接器仅供查看。", { exact: true })).toHaveCount(0);
    await editor.getByRole("button", { name: "添加下一跳", exact: true }).click();
    await choose(page, editor.getByRole("combobox", { name: "第 5 跳类型", exact: true }), "外部代理");
    await choose(page, editor.getByRole("combobox", { name: "第 5 跳外部代理", exact: true }), "proxy-z");
    await expect(summary).toContainText("a 监听 → proxy-x → proxy-y → b 监听 → proxy-z → 目标");
    await expect(editor.getByRole("list", { name: "代理链", exact: true }).getByRole("listitem")).toHaveCount(5);
    await configure(editor, 5);
    const edit = editor.getByRole("button", { name: "编辑第 5 跳外部代理连接参数", exact: true });
    await edit.click();
    const connection = page.getByRole("dialog", { name: "编辑连接参数", exact: true });
    await connection.getByRole("textbox", { name: "连接地址", exact: true }).fill("edited-proxy.example.invalid");
    await connection.getByRole("button", { name: "取消", exact: true }).click();
    const discard = page.getByRole("alertdialog", { name: "放弃连接参数修改？", exact: true });
    await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(connection).toBeHidden();
    await expect(edit).toBeFocused();
    await edit.click();
    await expect(connection.getByRole("textbox", { name: "连接地址", exact: true })).toHaveValue("proxy-z.example.invalid");
    await connection.getByRole("textbox", { name: "连接地址", exact: true }).fill("edited-proxy.example.invalid");
    await connection.getByRole("button", { name: "采用连接参数", exact: true }).click();
    await expect(connection).toBeHidden();
    await expect(edit).toBeFocused();
    await expect(summary).toContainText("a 监听 → proxy-x → proxy-y → b 监听 → proxy-z → 目标");
    for (const trigger of await editor.locator(".hop-summary[aria-expanded='true']").all()) await trigger.click();
    await editor.getByRole("textbox", { name: "转发路径名称", exact: true }).scrollIntoViewIfNeeded();
    await settledTask(editor);
    await expect(editor.getByText("仅保存草稿，检查与应用需另行操作。", { exact: true })).toHaveCount(0);
    // The overview keeps identity and sequence visible; configuration expands on demand.
    const rows = editor.getByRole("list", { name: "代理链", exact: true }).getByRole("listitem");
    for (const row of await rows.all()) {
      const bounds = await row.boundingBox();
      expect(bounds!.height).toBeLessThanOrEqual(100);
      for (const control of await row.getByRole("button").all()) {
        const target = await control.boundingBox();
        expect(target!.width).toBeGreaterThanOrEqual(44);
        expect(target!.height).toBeGreaterThanOrEqual(44);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const screenshot = info.outputPath(`mixed-chain-${width}.png`);
    await page.screenshot({ path: screenshot });
    await info.attach("ordered mixed chain", { path: screenshot, contentType: "image/png" });
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/server-deployments/mixed-chain" && response.request().method() === "PUT");
    await save.click();
    expect((await saved).status()).toBe(200);
    await expect(editor).toBeHidden();
    const revealed = await read(page.request, "/server-deployments/mixed-chain/reveal");
    expect(revealed.ir.programs.map((program: { listener: { id: string } }) => program.listener.id)).toEqual(["a", "b"]);
    const first = revealed.ir.programs[0];
    expect(first.defaultAction).toEqual({ kind: "forward", ref: "bridge-b" });
    expect(first.connectors.find((item: { id: string }) => item.id === "bridge-b").via).toBe("proxy-y");
    expect(first.connectors.find((item: { id: string }) => item.id === "proxy-y").via).toBe("proxy-x");
    expect(first.connectors.find((item: { id: string }) => item.id === "proxy-x").connection).toMatchObject({ host: "proxy-x.example.invalid", password: "synthetic-secret" });
    expect(revealed.ir.programs[1].defaultAction).toEqual({ kind: "forward", ref: "proxy-z" });
    expect(revealed.ir.programs[1].connectors.find((item: { id: string }) => item.id === "proxy-z").connection).toMatchObject({ host: "edited-proxy.example.invalid", password: "synthetic-secret" });
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
    expect(mutations).toEqual(["PUT /api/server-deployments/mixed-chain"]);

    // Continue the user task: publish the whole saved mixed path as an
    // independent-user offering, without flattening it to managed listeners.
    await page.goto("/#published-routes");
    await page.locator(".page-heading").getByRole("button", { name: "配置公开线路", exact: true }).click();
    const line = page.getByRole("dialog", { name: "配置公开线路", exact: true });
    await line.getByLabel("线路名称", { exact: true }).fill("完整混合线路");
    await choose(page, line.getByRole("combobox", { name: "服务器转发路径", exact: true }), "混合代理链");
    await expect(line.getByLabel("公开线路转发路径", { exact: true })).toContainText("a 监听 → 外部代理 proxy-x → 外部代理 proxy-y → b 监听 → 外部代理 proxy-z");
    await expect(line.getByRole("button", { name: /调整公开范围/ })).toHaveCount(0);
    await expect(line.getByLabel("对外域名或 IP", { exact: true })).toHaveValue("127.0.0.1");
    const expectedHops = [
      { kind: "managed", endpointId: "a" },
      { kind: "connector", connectorId: "proxy-x" },
      { kind: "connector", connectorId: "proxy-y" },
      { kind: "managed", endpointId: "b" },
      { kind: "connector", connectorId: "proxy-z" },
    ];
    const previewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/published-routes/preview" && response.request().method() === "POST");
    await line.getByRole("button", { name: "检查公开线路", exact: true }).click();
    const preview = await previewResponse;
    expect(preview.status()).toBe(200);
    expect(preview.request().postDataJSON()).toMatchObject({ deploymentId: "mixed-chain", endpointIds: ["a", "b"], hops: expectedHops });
    const saveLine = line.getByRole("button", { name: "保存公开线路", exact: true });
    await expect(saveLine).toBeEnabled();
    expect(await read(page.request, "/published-routes")).toEqual([]);
    const savedLineResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/published-routes" && response.request().method() === "POST");
    await saveLine.click();
    const savedLine = await savedLineResponse;
    expect(savedLine.status()).toBe(200);
    expect(savedLine.request().postDataJSON()).toEqual(preview.request().postDataJSON());
    await expect(line).toBeHidden();
    const lines = await read(page.request, "/published-routes");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: "完整混合线路", deploymentId: "mixed-chain", endpointIds: ["a", "b"], hops: expectedHops });
    expect(lines[0].savedPath.hops.map((hop: { kind: string; endpointId?: string; connectorId?: string }) =>
      hop.kind === "managed" ? { kind: hop.kind, endpointId: hop.endpointId } : { kind: hop.kind, connectorId: hop.connectorId })).toEqual(expectedHops);
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
    expect(privateSourceReads).toEqual([]);
    expect(mutations).toEqual([
      "PUT /api/server-deployments/mixed-chain", "POST /api/published-routes/preview", "POST /api/published-routes",
    ]);
  });
}
