import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { headers, read, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Real isolated HTTP persistence with synthetic inventory. No live runtime
// enrollment, validation/application request, mocked API or external traffic.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});

async function capture(
  page: Page,
  info: TestInfo,
  editor: Locator,
  target: Locator,
  name: string,
) {
  await target.scrollIntoViewIfNeeded();
  await settledTask(editor);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await editor.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return (
        box.left >= -1 &&
        box.right <= innerWidth + 1 &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
  ).toBe(true);
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(
    await target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return !!hit && element.contains(hit);
    }),
  ).toBe(true);
  const path = info.outputPath(`${name}-${page.viewportSize()!.width}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`conditional policy edits preserve connector and rule identity through real save at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    const csrf = await headers(page.request);
    const instance = {
      id: "policy-core",
      hostId: "policy-server",
      name: "Policy core",
      adapterId: "routeweaver/sing-box",
      version: "1.14.4",
    };
    const listener = {
      id: "policy-entry",
      instanceId: instance.id,
      name: "条件转发入口",
      connection: {
        protocol: "socks",
        host: "127.0.0.1",
        port: 23180,
        username: "fixture",
        password: "synthetic-listener-only",
      },
    };
    const deployment = {
      id: "conditional-policy",
      name: "按域名转发",
      status: "draft",
      diagnostics: [],
      ir: {
        schemaVersion: "1.0",
        id: "conditional-policy",
        topologyRevision: "policy-original",
        programs: [
          {
            instance,
            listener,
            egress: [],
            resources: [
              {
                id: "rules-file",
                name: "保留的域名资源",
                revision: "r1",
                digest: `sha256:${"a".repeat(64)}`,
                format: "sing-box-source",
                formatVersion: 3,
                location: "remote",
                url: "https://rules.example.invalid/list.json",
                updatePolicy: "follow",
                intervalSeconds: 3600,
              },
            ],
            connectors: [
              {
                id: "transit",
                connection: {
                  protocol: "socks",
                  host: "127.0.0.1",
                  port: 23181,
                  username: "fixture",
                  password: "synthetic-transit-only",
                },
              },
              {
                id: "exit",
                via: "transit",
                connection: {
                  protocol: "socks",
                  host: "127.0.0.1",
                  port: 23182,
                  username: "fixture",
                  password: "synthetic-exit-only",
                },
              },
            ],
            rules: [
              {
                id: "selected-domain",
                match: {
                  op: "domain-suffix",
                  value: "selected.example.invalid",
                },
                action: { kind: "forward", ref: "exit" },
              },
              {
                id: "blocked-domain",
                match: { op: "domain", value: "blocked.example.invalid" },
                action: { kind: "reject" },
              },
              {
                id: "resource-rule",
                match: { op: "resource", value: "rules-file" },
                action: { kind: "direct" },
              },
            ],
            defaultAction: { kind: "reject" },
          },
        ],
      },
    };
    for (const [path, data] of [
      [
        "/hosts",
        { id: "policy-server", name: "策略服务器", address: "127.0.0.1" },
      ],
      ["/core-instances", instance],
      ["/managed-endpoints", listener],
      ["/server-deployments", deployment],
    ] as const) {
      const response = await page.request.post(`/api${path}`, {
        headers: csrf,
        data,
      });
      expect(response.status(), `Create synthetic ${path}`).toBe(200);
    }
    const before = await read(
      page.request,
      "/server-deployments/conditional-policy/reveal",
    );
    const mutations: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.startsWith("/api/") &&
        !["GET", "HEAD"].includes(request.method())
      )
        mutations.push(`${request.method()} ${path}`);
    });
    await page.goto("/#routes");
    await page
      .getByRole("button", { name: "编辑转发路径 按域名转发", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "编辑 按域名转发",
      exact: true,
    });
    await expect(
      editor.getByRole("tab", { name: "图形编辑", exact: true }),
    ).toHaveCount(0);
    const destination = editor.getByRole("combobox", {
      name: "条件转发入口 默认去向",
      exact: true,
    });
    await expect(destination).toContainText("拒绝连接");
    await capture(page, info, editor, destination, "policy-default-action");
    await destination.focus();
    await page.keyboard.press("Enter");
    const search = page.getByRole("combobox", {
      name: "搜索选项",
      exact: true,
    });
    await expect(search).toBeFocused();
    await search.fill("exit");
    await expect(
      page.getByRole("option", { name: "转发至连接器 exit", exact: true }),
    ).toBeVisible();
    await search.press("Enter");
    await expect(destination).toContainText("转发至连接器 exit");
    await expect(destination).toBeFocused();
    expect(mutations).toEqual([]);
    await page.keyboard.press("Escape");
    const discard = page.getByRole("alertdialog", {
      name: "放弃尚未保存的转发路径修改？",
      exact: true,
    });
    await discard
      .getByRole("button", { name: "继续编辑", exact: true })
      .click();
    await expect(destination).toContainText("转发至连接器 exit");
    for (const section of ["默认去向", "条件规则", "用户入口", "连接器"]) {
      await expect(
        editor.getByRole("region", {
          name: `条件转发入口的${section}`,
          exact: true,
        }),
      ).toBeVisible();
    }
    await expect(
      editor.getByRole("combobox", {
        name: "条件转发入口 规则 3 去向",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      editor.getByText("该条件尚未提供去向表单，请在完整 JSON 中修改。", {
        exact: true,
      }),
    ).toBeVisible();
    for (const [index, option] of ["拒绝连接", "直连"].entries()) {
      const action = editor.getByRole("combobox", {
        name: `条件转发入口 规则 ${index + 1} 去向`,
        exact: true,
      });
      await action.focus();
      await page.keyboard.press("Enter");
      await expect(search).toBeFocused();
      await search.fill(option);
      await expect(
        page.getByRole("option", { name: option, exact: true }),
      ).toBeVisible();
      await search.press("Enter");
      await expect(action).toContainText(option);
    }
    await capture(
      page,
      info,
      editor,
      editor.getByRole("combobox", {
        name: "条件转发入口 规则 2 去向",
        exact: true,
      }),
      "policy-rule-action",
    );
    const condition = editor.getByRole("textbox", { name: "条件转发入口 规则 1 条件值", exact: true });
    await condition.fill("updated.example.invalid");
    await capture(page, info, editor, condition, "policy-leaf-condition");
    const cidrType = editor.getByRole("combobox", { name: "条件转发入口 规则 2 条件类型", exact: true });
    await cidrType.focus();
    await page.keyboard.press("Enter");
    await search.fill("IP 网段");
    await search.press("Enter");
    const cidr = editor.getByRole("textbox", { name: "条件转发入口 规则 2 条件值", exact: true });
    await cidr.fill("192.0.2.0/33");
    await expect(cidr).toHaveAttribute("aria-invalid", "true");
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await cidr.fill("2001:db8::7/32");
    await expect(cidr).toHaveAttribute("aria-invalid", "false");
    await capture(page, info, editor, cidr, "policy-ipv6-condition");
    const connectors = editor.getByRole("region", {
      name: "条件转发入口的连接器",
      exact: true,
    });
    await connectors.getByText("连接器路径", { exact: true }).click();
    await expect(connectors).toContainText("127.0.0.1:23181 → 127.0.0.1:23182");
    await expect(editor).not.toContainText(
      /synthetic-listener-only|synthetic-transit-only|synthetic-exit-only/,
    );
    await capture(
      page,
      info,
      editor,
      connectors.getByText("经由连接器 transit", { exact: true }),
      "policy-connector-dependencies",
    );
    const connectorHost = editor.getByRole("textbox", { name: "条件转发入口 连接器 2 地址", exact: true });
    await connectorHost.fill("");
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await connectorHost.fill("127.0.0.2");
    const upstream = editor.getByRole("combobox", { name: "条件转发入口 连接器 2 上游连接器", exact: true });
    await upstream.focus();
    await page.keyboard.press("Enter");
    await search.fill("无上游连接器");
    await search.press("Enter");
    await capture(page, info, editor, connectorHost, "policy-connector-host");
    const connectionTrigger = editor.getByRole("button", { name: "条件转发入口 连接器 1 编辑连接参数", exact: true });
    await connectionTrigger.click();
    let connectionDialog = page.getByRole("dialog", { name: "编辑连接参数", exact: true });
    await expect(editor).toBeHidden();
    await connectionDialog.getByRole("spinbutton", { name: "端口", exact: true }).fill("");
    await connectionDialog.getByRole("button", { name: "采用连接参数", exact: true }).click();
    await expect(connectionDialog).toBeVisible();
    await connectionDialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("alertdialog", { name: "放弃连接参数修改？", exact: true }).getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(connectionTrigger).toBeFocused();
    await connectionTrigger.click();
    connectionDialog = page.getByRole("dialog", { name: "编辑连接参数", exact: true });
    const connectionPort = connectionDialog.getByRole("spinbutton", { name: "端口", exact: true });
    await expect(connectionPort).toHaveValue("23181");
    await connectionPort.fill("24181");
    await capture(page, info, connectionDialog, connectionPort, "policy-connector-connection");
    await connectionDialog.getByRole("button", { name: "采用连接参数", exact: true }).click();
    await expect(editor).toBeVisible();
    const addConnector = editor.getByRole("button", { name: "条件转发入口 新增连接器", exact: true });
    await addConnector.click();
    let addition = page.getByRole("dialog", { name: "新增连接器", exact: true });
    await addition.getByRole("button", { name: "取消", exact: true }).click();
    await expect(addConnector).toBeFocused();
    await addConnector.click();
    addition = page.getByRole("dialog", { name: "新增连接器", exact: true });
    await addition.getByRole("textbox", { name: "连接地址", exact: true }).fill("127.0.0.3");
    await addition.getByRole("button", { name: "添加到草稿", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "条件转发入口 连接器 3 地址", exact: true })).toHaveValue("127.0.0.3");
    await expect(editor.getByRole("button", { name: "条件转发入口 连接器 2 删除连接器", exact: true })).toBeDisabled();
    const removeConnector = editor.getByRole("button", { name: "条件转发入口 连接器 3 删除连接器", exact: true });
    await removeConnector.click();
    const removeReview = page.getByRole("alertdialog", { name: "删除连接器 connector-1？", exact: true });
    await removeReview.getByRole("button", { name: "保留连接器", exact: true }).click();
    await removeConnector.click();
    await removeReview.getByRole("button", { name: "删除连接器", exact: true }).click();
    await expect(editor.getByRole("textbox", { name: "条件转发入口 连接器 2 地址", exact: true })).toBeFocused();
    await addConnector.click();
    addition = page.getByRole("dialog", { name: "新增连接器", exact: true });
    await addition.getByRole("textbox", { name: "连接地址", exact: true }).fill("127.0.0.4");
    await addition.getByRole("button", { name: "添加到草稿", exact: true }).click();
    await capture(page, info, editor, editor.getByRole("textbox", { name: "条件转发入口 连接器 3 地址", exact: true }), "policy-connector-added");
    const consequence = editor.getByText("仅保存草稿，检查与应用需另行操作。", {
      exact: true,
    });
    await capture(page, info, editor, consequence, "policy-save-consequence");
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/server-deployments/conditional-policy" &&
        response.request().method() === "PUT",
    );
    await editor.getByRole("button", { name: "保存草稿", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(editor).toBeHidden();
    const after = await read(
      page.request,
      "/server-deployments/conditional-policy/reveal",
    );
    expect(after.ir.programs).toEqual([
      {
        ...before.ir.programs[0],
        defaultAction: { kind: "forward", ref: "exit" },
        connectors: [
          { ...before.ir.programs[0].connectors[0], connection: { ...before.ir.programs[0].connectors[0].connection, port: 24181 } },
          { id: "exit", connection: { ...before.ir.programs[0].connectors[1].connection, host: "127.0.0.2" } },
          { id: "connector-1", connection: { protocol: "socks", host: "127.0.0.4", port: 1080 } },
        ],
        rules: [
          { ...before.ir.programs[0].rules[0], match: { ...before.ir.programs[0].rules[0].match, value: "updated.example.invalid" }, action: { kind: "reject" } },
          { ...before.ir.programs[0].rules[1], match: { ...before.ir.programs[0].rules[1].match, op: "ip-cidr", value: "2001:db8::7/32" }, action: { kind: "direct" } },
          before.ir.programs[0].rules[2],
        ],
      },
    ]);
    expect(after.ir.topologyRevision).not.toBe(before.ir.topologyRevision);
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
    expect(mutations).toEqual([
      "PUT /api/server-deployments/conditional-policy",
    ]);

    const listDeployment = structuredClone(deployment);
    listDeployment.id = "editable-rule-list";
    listDeployment.name = "编辑规则顺序";
    listDeployment.ir.id = "editable-rule-list";
    listDeployment.ir.programs[0].rules = listDeployment.ir.programs[0].rules.slice(0, 2);
    listDeployment.ir.programs[0].resources = [];
    expect((await page.request.post("/api/server-deployments", { headers: csrf, data: listDeployment })).status()).toBe(200);
    const listBefore = await read(page.request, "/server-deployments/editable-rule-list/reveal");
    mutations.length = 0;
    await page.reload();
    await page.getByRole("button", { name: "编辑转发路径 编辑规则顺序", exact: true }).click();
    const listEditor = page.getByRole("dialog", { name: "编辑 编辑规则顺序", exact: true });
    await listEditor.getByRole("button", { name: "条件转发入口 新增规则", exact: true }).click();
    await expect(listEditor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await listEditor.getByRole("textbox", { name: "条件转发入口 规则 3 条件值", exact: true }).fill("new.example.invalid");
    await listEditor.getByRole("button", { name: "条件转发入口 规则 3 上移", exact: true }).click();
    await expect(listEditor.getByRole("textbox", { name: "条件转发入口 规则 2 条件值", exact: true })).toHaveValue("new.example.invalid");
    await listEditor.getByRole("button", { name: "条件转发入口 删除规则 3", exact: true }).click();
    const deletion = page.getByRole("alertdialog", { name: "删除规则 3？", exact: true });
    await expect(deletion).toContainText("后续规则");
    await deletion.getByRole("button", { name: "保留规则", exact: true }).click();
    await listEditor.getByRole("button", { name: "条件转发入口 删除规则 3", exact: true }).click();
    await deletion.getByRole("button", { name: "删除规则", exact: true }).click();
    await expect(listEditor.getByRole("combobox", { name: "条件转发入口 规则 2 条件类型", exact: true })).toBeFocused();
    await capture(page, info, listEditor, listEditor.getByRole("textbox", { name: "条件转发入口 规则 2 条件值", exact: true }), "policy-rule-list");
    const listSaved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/server-deployments/editable-rule-list" && response.request().method() === "PUT");
    await listEditor.getByRole("button", { name: "保存草稿", exact: true }).click();
    expect((await listSaved).status()).toBe(200);
    await expect(listEditor).toBeHidden();
    const listAfter = await read(page.request, "/server-deployments/editable-rule-list/reveal");
    expect(listAfter.ir.programs).toEqual([{
      ...listBefore.ir.programs[0],
      rules: [listBefore.ir.programs[0].rules[0], { id: "rule-1", match: { op: "domain", value: "new.example.invalid" }, action: { kind: "reject" } }],
    }]);
    expect(mutations).toEqual(["PUT /api/server-deployments/editable-rule-list"]);
  });
}


