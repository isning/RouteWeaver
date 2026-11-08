import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import {
  names,
  read,
  seedInfrastructure,
  signIn,
} from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Real HTTP against one fresh normal-CLI database per case. These are synthetic
// inventory records, not running nodes. Certificate paths are draft inputs;
// this journey does not generate certificates, supply keys, grant users or apply.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});

function responseFor(page: Page, path: string, method: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api${path}` &&
      response.request().method() === method,
  );
}

async function capture(
  page: Page,
  info: TestInfo,
  surface: Locator,
  label: string,
  width: number,
) {
  await settledTask(surface);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(
    await surface.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        element.scrollWidth <= element.clientWidth + 1
      );
    }),
  ).toBe(true);
  const path = info.outputPath(`tls-repair-${label}-${width}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(`TLS repair ${label} at ${width}px`, {
    path,
    contentType: "image/png",
  });
}

for (const width of [1440, 390]) {
  test(`repairs a real TLS refusal in context and rechecks the same unsaved line at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    await seedInfrastructure(page.request, true);
    const id = "uiux-inventory";
    const original = await read(
      page.request,
      `/published-routes/${id}/resolve`,
    );
    const mutations: { method: string; path: string; hasRevision: boolean }[] =
      [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.startsWith("/api/") &&
        !["GET", "HEAD"].includes(request.method())
      ) {
        // Do not capture bodies, UUIDs, private material or authorization headers.
        mutations.push({
          method: request.method(),
          path,
          hasRevision: !!request.headers()["if-match"],
        });
      }
    });
    await page.goto("/#published-routes");
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: `编辑 ${names.line}`,
      exact: true,
    });
    const name = editor.getByRole("textbox", { name: "线路名称", exact: true });
    const port = editor.getByRole("spinbutton", {
      name: "对外端口",
      exact: true,
    });
    const host = editor.getByRole("textbox", {
      name: "对外域名或 IP",
      exact: true,
    });
    const inspect = editor.getByRole("button", {
      name: "检查公开线路",
      exact: true,
    });
    await name.fill("保留的 TLS 公开线路草稿");
    await port.fill("+024443");
    await host.fill("tls-repair.example.test");
    const refusal = responseFor(page, "/published-routes/preview", "POST");
    await inspect.click();
    expect((await refusal).status()).toBe(422);
    await expect(
      editor.getByText("公网入口需要启用 TLS", { exact: true }),
    ).toBeVisible();
    const repairAction = editor.getByRole("button", {
      name: "就地修复 TLS",
      exact: true,
    });
    await repairAction.click();
    let repair = page.getByRole("dialog", {
      name: "修复公开线路 TLS",
      exact: true,
    });
    await settledTask(repair);
    await expect(editor).not.toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
      repair.getByText(names.deployment, { exact: true }),
    ).toBeVisible();
    await expect(
      repair.getByText(names.listener, { exact: true }),
    ).toBeVisible();
    await capture(page, info, repair, "steps", width);
    await repair
      .getByRole("button", { name: "返回公开线路", exact: true })
      .click();
    await settledTask(editor);
    await expect(repairAction).toBeFocused();
    await expect(name).toHaveValue("保留的 TLS 公开线路草稿");
    await expect(port).toHaveValue("+024443");
    await expect(host).toHaveValue("tls-repair.example.test");
    expect(mutations.map((value) => `${value.method} ${value.path}`)).toEqual([
      "POST /api/published-routes/preview",
    ]);

    await repairAction.click();
    repair = page.getByRole("dialog", {
      name: "修复公开线路 TLS",
      exact: true,
    });
    await repair
      .getByRole("button", { name: "配置入口 TLS", exact: true })
      .click();
    const endpointEditor = page.getByRole("dialog", {
      name: "编辑监听端点",
      exact: true,
    });
    await expect(repair).not.toBeVisible();
    await endpointEditor
      .getByRole("radio", { name: "TLS", exact: true })
      .click();
    await endpointEditor
      .getByRole("textbox", { name: "服务器名称（SNI）", exact: true })
      .fill("tls-repair.example.test");
    const impact = responseFor(page, `/managed-endpoints/${id}/impact`, "POST");
    await endpointEditor
      .getByRole("button", { name: "保存", exact: true })
      .click();
    expect((await impact).status()).toBe(200);
    const confirmEndpoint = page.getByRole("button", {
      name: "确认保存端点",
      exact: true,
    });
    await expect(confirmEndpoint).toBeVisible();
    expect(mutations.filter((value) => value.method === "PUT")).toHaveLength(0);
    const endpointSaved = responseFor(page, `/managed-endpoints/${id}`, "PUT");
    await confirmEndpoint.click();
    expect((await endpointSaved).status()).toBe(200);
    await settledTask(repair);
    await expect(
      repair.getByText("监听端点已保存，路径仍使用原有快照。", { exact: true }),
    ).toBeVisible();
    const savedEndpoint = await read(
      page.request,
      `/managed-endpoints/${id}/reveal`,
    );
    expect(savedEndpoint.connection.tls).toMatchObject({
      enabled: true,
      serverName: "tls-repair.example.test",
    });
    const oldPath = await read(
      page.request,
      `/server-deployments/${id}/reveal`,
    );
    expect(oldPath.ir.programs[0].listener.connection.tls?.enabled).not.toBe(
      true,
    );

    await repair
      .getByRole("button", { name: "更新路径 TLS", exact: true })
      .click();
    const comparison = page.getByRole("dialog", {
      name: `更新 ${names.listener} 的监听设置`,
      exact: true,
    });
    const adopt = comparison.getByRole("button", {
      name: "更新到草稿",
      exact: true,
    });
    await expect(adopt).toBeEnabled();
    expect(
      mutations.filter(
        (value) =>
          value.path === `/api/server-deployments/${id}` &&
          value.method === "PUT",
      ),
    ).toHaveLength(0);
    await adopt.click();
    const pathEditor = page.getByRole("dialog", {
      name: `编辑 ${names.deployment}`,
      exact: true,
    });
    await expect(comparison).not.toBeVisible();
    await pathEditor
      .getByRole("textbox", { name: "证书文件路径", exact: true })
      .fill("tls/fixture-certificate.pem");
    await pathEditor
      .getByRole("textbox", { name: "私钥文件路径", exact: true })
      .fill("tls/fixture-private-key.pem");
    const pathSaved = responseFor(page, `/server-deployments/${id}`, "PUT");
    await pathEditor
      .getByRole("button", { name: "保存草稿", exact: true })
      .click();
    expect((await pathSaved).status()).toBe(200);
    await settledTask(repair);
    await expect(
      repair.getByText("转发路径已保存，公开线路尚待重新检查。", {
        exact: true,
      }),
    ).toBeVisible();
    const savedPath = await read(
      page.request,
      `/server-deployments/${id}/reveal`,
    );
    expect(savedPath.ir.programs[0].listener.connection.tls.enabled).toBe(true);
    expect(savedPath.ir.programs[0].tls).toMatchObject({
      certificatePath: "tls/fixture-certificate.pem",
      keyPath: "tls/fixture-private-key.pem",
    });
    expect(Boolean(savedPath.ir.programs[0].tls.certificatePem)).toBe(false);
    expect(Boolean(savedPath.ir.programs[0].tls.privateKeyPem)).toBe(false);
    expect(
      mutations.filter(
        (value) => value.path === "/api/published-routes/preview",
      ),
    ).toHaveLength(1);

    const rechecked = responseFor(page, "/published-routes/preview", "POST");
    await repair
      .getByRole("button", { name: "返回并重新检查", exact: true })
      .click();
    expect((await rechecked).status()).toBe(200);
    await settledTask(editor);
    await expect(inspect).toBeFocused();
    await expect(name).toHaveValue("保留的 TLS 公开线路草稿");
    await expect(port).toHaveValue("+024443");
    await expect(host).toHaveValue("tls-repair.example.test");
    await expect(
      editor.getByRole("combobox", { name: "服务器转发路径", exact: true }),
    ).toHaveText(names.deployment);
    await expect(
      editor.getByLabel("公开线路转发路径", { exact: true }),
    ).toHaveText(names.listener);
    await expect(
      editor.getByText("路径检查完成", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByRole("button", { name: "保存公开线路", exact: true }),
    ).toBeEnabled();
    await expect(
      editor.getByText("公网入口需要启用 TLS", { exact: true }),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/#published-routes$/);
    await capture(page, info, editor, "same-draft-rechecked", width);

    const unchanged = await read(
      page.request,
      `/published-routes/${id}/resolve`,
    );
    expect(unchanged).toMatchObject({
      name: original.name,
      publicHost: original.publicHost,
      publicPort: original.publicPort,
      endpointIds: original.endpointIds,
      deploymentId: original.deploymentId,
    });
    expect(mutations.map((value) => `${value.method} ${value.path}`)).toEqual([
      "POST /api/published-routes/preview",
      `POST /api/managed-endpoints/${id}/impact`,
      `PUT /api/managed-endpoints/${id}`,
      `PUT /api/server-deployments/${id}`,
      "POST /api/published-routes/preview",
    ]);
    expect(
      mutations
        .filter((value) => value.method === "PUT")
        .every((value) => value.hasRevision),
    ).toBe(true);
    const state = await read(page.request, `/agent/instances/${id}/state`);
    expect(state.phase).toBe("unregistered");
    expect(state.desired).toBeUndefined();
    expect(state.state?.observed).toBeUndefined();
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
    await info.attach("tls-repair-result", {
      contentType: "application/json",
      body: JSON.stringify({
        width,
        endpointReviewed: true,
        snapshotAdopted: true,
        pathSaved: true,
        publicDraftRechecked: true,
        publicLineSaved: false,
        nodeApplied: false,
        certificateMaterialProvided: false,
      }),
    });
  });
}
