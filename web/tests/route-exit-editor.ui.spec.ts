import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { openWorkspace } from "./ui-session";
import { surfaceMotionState } from "./ui-surface-stability";

// Browser interaction evidence only: inventory, planner and receipt are deliberate
// synthetic HTTP responses. This suite proves neither backend forwarding nor apply.
test.use({ trace: "off", screenshot: "off" });
test.afterEach(async ({ page }, info) => {
  const focus = await page.evaluate(() => {
    const node = document.activeElement;
    return {
      documentFocused: document.hasFocus(),
      tag: node?.tagName,
      role: node?.getAttribute("role"),
      label: node?.getAttribute("aria-label"),
      text: node?.tagName === "BUTTON" ? node.textContent : undefined,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
        (dialog) => ({
          label: dialog.getAttribute("aria-label"),
          hidden: dialog.getAttribute("aria-hidden"),
        }),
      ),
    };
  });
  const path = info.outputPath("terminal-focus.json");
  await writeFile(path, JSON.stringify(focus, null, 2));
  await info.attach("terminal-focus", {
    contentType: "application/json",
    path,
  });
});
async function installFixture(page: Page, loseFirstCommit = false) {
  const hosts = ["fra", "old", "new"].map((id) => ({
    id,
    name: id === "new" ? "英国二号" : id.toUpperCase(),
    address: `${id}.example.invalid`,
  }));
  const instances = hosts.map((host) => ({
    id: `${host.id}-core`,
    hostId: host.id,
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  }));
  const endpoints = instances.map((instance, index) => ({
    id: `${hosts[index].id}-endpoint`,
    instanceId: instance.id,
    name: hosts[index].name,
    connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
  }));
  const deployment = {
    id: "exit-ui-deployment",
    name: "FRA 转发路径",
    revisionToken: "deployment-before",
    status: "draft",
    diagnostics: [],
    ir: {
      id: "exit-ui-deployment",
      schemaVersion: "1.0",
      topologyRevision: "topology",
      programs: instances.slice(0, 2).map((instance, index) => ({
        instance,
        listener: endpoints[index],
        egress: [],
        rules: [],
        resources: [],
      })),
    },
  };
  const route = {
    id: "exit-ui-line",
    name: "英国线路",
    revisionToken: "route-before",
    deploymentId: deployment.id,
    endpointIds: [endpoints[0].id, endpoints[1].id],
    publicHost: "fra.example.invalid",
    publicPort: 443,
    status: "effective",
    diagnostics: [],
  };
  const review = {
    routeId: route.id,
    routeName: route.name,
    reviewToken: "review-token",
    before: {
      endpointId: "old-endpoint",
      name: "OLD",
      host: "old.example.invalid",
      port: 443,
      protocol: "vless",
      security: "none",
      transport: "tcp",
    },
    after: {
      endpointId: "new-endpoint",
      name: "英国二号",
      host: "new.example.invalid",
      port: 443,
      protocol: "vless",
      security: "none",
      transport: "tcp",
    },
    affectedUsers: 2,
    addedProgram: true,
    isolatedConnector: true,
    legacyNormalized: true,
    nativeChecked: false,
    publicEntryPreserved: true,
    credentialsPreserved: true,
    oldProgramRetained: true,
    securityChanges: [],
    applicationReadiness: { state: "requires-apply-check" },
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const commits: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (intercept) => {
    const request = intercept.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    if (request.method() !== "GET" && !path.startsWith("/auth/"))
      writes.push({ path, body: request.postDataJSON() });
    const data: Record<string, unknown> = {
      "/hosts": hosts,
      "/core-instances": instances,
      "/managed-endpoints": endpoints,
      "/links": [],
      "/server-deployments": [deployment],
      "/published-routes": [route],
      [`/published-routes/${route.id}/resolve`]: route,
    };
    if (path === "/published-routes/preview")
      return intercept.fulfill({ json: route });
    if (request.method() === "PUT" && path === `/published-routes/${route.id}`)
      return intercept.fulfill({
        status: 409,
        json: { message: "changed elsewhere" },
      });
    if (path.endsWith("/retarget/preview"))
      return intercept.fulfill({ json: review });
    if (path.endsWith("/retarget")) {
      const body = request.postDataJSON();
      commits.push(body);
      if (loseFirstCommit && commits.length === 1)
        return intercept.abort("failed");
      return intercept.fulfill({
        json: {
          operationId: body.operationId,
          routeId: route.id,
          status: "draft-saved",
          routeRevision: "route-after",
          deploymentRevision: "deployment-after",
        },
      });
    }
    if (Object.hasOwn(data, path))
      return intercept.fulfill({ json: data[path] });
    if (path.includes("/reveal") || path.includes("/apply"))
      throw new Error(`Retarget must not request ${path}`);
    return intercept.continue();
  });
  return { writes, commits };
}
async function openEditor(page: Page) {
  await page.goto("/#published-routes");
  await page.getByRole("button", { name: "英国线路", exact: true }).click();
  await page.getByRole("button", { name: "更换出口", exact: true }).click();
  await expect(
    page.getByRole("dialog", {
      name: "英国线路",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  // Only the top modal is exposed to assistive technology; the route context
  // remains mounted underneath and is restored on dismissal.
  await expect(
    page.getByRole("dialog", { name: "英国线路", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "更换「英国线路」的出口", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("combobox", { name: "新出口服务器" }),
  ).toBeVisible();
}

test("keyboard selects a real endpoint and reviews a draft, then safely returns to its route", async ({
  page,
}, info) => {
  await openWorkspace(page);
  const { writes } = await installFixture(page);
  await openEditor(page);
  const server = page.getByRole("combobox", { name: "新出口服务器" });
  await server.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("英国二号");
  await page.keyboard.press("Enter");
  const endpoint = page.getByRole("combobox", { name: "新出口端点" });
  await endpoint.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const check = page.getByRole("button", { name: "检查变更", exact: true });
  await expect(check).toBeEnabled();
  await check.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "核对草稿变更" }),
  ).toBeFocused();
  await expect(page.getByText("影响此线路的 2 位关联用户")).toBeVisible();
  await expect(
    page.getByText(
      "保存后需单独应用，不会重新发布订阅；应用生效后，使用此入口的已有客户端也会改用新出口。",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("synthetic-draft-review-desktop.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "更换出口", exact: true }),
  ).toBeFocused();
  expect(writes.map((write) => write.path)).toEqual([
    "/published-routes/exit-ui-line/retarget/preview",
  ]);
});

test.describe("390px touch", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  test("tap review, safely dismiss an unknown save and replay the identical operation", async ({
    page,
  }, info) => {
    await openWorkspace(page);
    const { commits } = await installFixture(page, true);
    await page.goto("/#published-routes");
    await page.getByRole("button", { name: "英国线路", exact: true }).tap();
    await page.getByRole("button", { name: "更换出口", exact: true }).tap();
    await page.getByRole("combobox", { name: "新出口服务器" }).tap();
    await page.getByText("英国二号", { exact: true }).last().tap();
    await page.getByRole("combobox", { name: "新出口端点" }).tap();
    await page
      .getByText("英国二号 · vless:443 · xray", { exact: true })
      .last()
      .tap();
    const check = page.getByRole("button", { name: "检查变更", exact: true });
    expect((await check.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await check.tap();
    await expect(
      page.getByRole("heading", { name: "核对草稿变更" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("synthetic-draft-review-touch.png"),
    });
    const save = page.getByRole("button", {
      name: "保存出口草稿",
      exact: true,
    });
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await save.tap();
    await expect(
      page.getByRole("button", { name: "核对保存结果" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "继续选择出口" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "返回线路", exact: true }).tap();
    await expect(
      page.getByRole("dialog", { name: "英国线路", exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("dialog", { name: "更换「英国线路」的出口", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "继续「英国线路」出口变更" }).tap();
    await page.getByRole("button", { name: "核对保存结果" }).tap();
    await expect(
      page.getByRole("button", { name: "更换出口", exact: true }),
    ).toBeVisible();
    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual(commits[0]);
  });
});

test("stale full-editor draft cannot overwrite a newer route; confirmation returns focus after closing", async ({
  page,
}) => {
  await openWorkspace(page);
  const { writes } = await installFixture(page);
  await page.goto("/#published-routes");
  const edit = page.getByRole("button", { name: "编辑", exact: true });
  await edit.click();
  await page.getByRole("textbox", { name: "线路名称" }).fill("未保存的名称");
  await page.getByRole("button", { name: "检查公开线路", exact: true }).click();
  await page.getByRole("button", { name: "保存公开线路", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存公开线路", exact: true }),
  ).toBeDisabled();
  const discard = page.getByRole("button", {
    name: "放弃修改并返回",
    exact: true,
  });
  await discard.focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("alertdialog", {
    name: "放弃当前修改并返回？",
  });
  await expect(
    confirmation.getByRole("button", { name: "保留当前输入" }),
  ).toBeFocused();
  await expect
    .poll(() => confirmation.evaluate(surfaceMotionState))
    .toMatchObject({ preparing: false, running: false, opacity: "1" });
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(discard).toBeFocused();
  await expect(page.getByRole("textbox", { name: "线路名称" })).toHaveValue(
    "未保存的名称",
  );
  await page.keyboard.press("Escape");
  const ordinaryGuard = page.getByRole("alertdialog", {
    name: "放弃未保存的公开线路修改？",
    exact: true,
  });
  await expect(ordinaryGuard).toBeVisible();
  await ordinaryGuard
    .getByRole("button", { name: "继续编辑", exact: true })
    .click();
  await expect(ordinaryGuard).not.toBeVisible();
  await expect(discard).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => confirmation.evaluate(surfaceMotionState))
    .toMatchObject({ preparing: false, running: false, opacity: "1" });
  await confirmation.getByRole("button", { name: "放弃修改并返回" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "线路名称" })).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect(
    writes.filter((write) => write.path === "/published-routes/exit-ui-line"),
  ).toHaveLength(1);
});
