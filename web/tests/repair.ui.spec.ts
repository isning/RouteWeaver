import { openWorkspace, navigateWorkspace } from "./ui-session";
import { test, expect, type Page } from "@playwright/test";
// Publication opens access-bearing UI after explicit confirmation. Never retain
// traces or automatic screenshots; only the safe pre-publication business states
// below are deliberately captured.
test.use({ trace: "off", screenshot: "off" });

async function json(page: Page, path: string) {
  const r = await page.request.get("/api" + path);
  expect(r.ok()).toBe(true);
  return r.json();
}
async function fixture(page: Page, repeated = false) {
  await openWorkspace(page);
  await expect(
    page.getByRole("heading", { name: "我的订阅", exact: true }),
  ).toBeVisible();
  const headers = { "X-CSRF-Token": (await json(page, "/auth/me")).csrfToken };
  const key = Date.now().toString(36);
  const id = "repair-" + key;
  const sr = await page.request.post("/api/me/sources", {
    headers,
    data: {
      id: "source-" + key,
      name: "修复素材 " + key,
      kind: "text",
      applyMode: "manual",
      content:
        "socks5://one.example:1080#London\nsocks5://two.example:1080#Tokyo",
      enabled: true,
    },
  });
  expect(sr.ok()).toBe(true);
  const source = await sr.json();
  const ref = { kind: "endpoint", ref: source.snapshot.endpoints[1].id };
  const profile = {
    id,
    name: "日常分流 " + key,
    sourceIds: [source.id],
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    ir: {
      schemaVersion: "1.0",
      id,
      name: "日常分流 " + key,
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: repeated
        ? [{ id: "travel", name: "旅行", kind: "manual", members: [ref] }]
        : [],
      rules: repeated
        ? [
            {
              id: "first",
              match: { op: "domain-suffix", value: "one.example" },
              action: ref,
            },
            {
              id: "second",
              match: { op: "domain-suffix", value: "two.example" },
              action: ref,
            },
          ]
        : [],
      resources: [],
      defaultAction: repeated ? { kind: "direct" } : ref,
      runtime: { mixedPort: 7890 },
    },
  };
  expect(
    (
      await page.request.post("/api/me/profiles", { headers, data: profile })
    ).ok(),
  ).toBe(true);
  const outputs = [];
  for (const [label, adapterId, version] of [
    ["电脑", "mihomo", "1.19.32"],
    ["手机", "sing-box", "1.14.3"],
  ]) {
    const r = await page.request.post("/api/me/outputs", {
      headers,
      data: {
        id: id + "-" + outputs.length,
        name: label + " " + key,
        profileId: id,
        target: { adapterId, version },
        mode: "full",
      },
    });
    expect(r.ok()).toBe(true);
    const created = await r.json();
    outputs.push(
      (await json(page, "/me/outputs")).find((o: any) => o.id === created.id),
    );
  }
  await page.reload();
  await page.getByText("订阅素材", { exact: true }).click();
  await navigateWorkspace(page, "订阅来源");
  await page
    .getByRole("button", { name: "编辑 " + source.name, exact: true })
    .click();
  await page
    .getByLabel("节点链接或配置内容")
    .fill("socks5://one.example:1080#London");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: `应用更新 ${source.name}`, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `查看上次应用结果 ${source.name}`,
      exact: true,
    })
    .click();
  const receipt = page.getByRole("dialog", {
    name: "上次应用详情",
    exact: true,
  });
  await receipt
    .getByRole("link", { name: new RegExp("^查看配置 " + profile.name) })
    .click();
  await page
    .getByRole("article", { name: "分流配置 " + profile.name, exact: true })
    .getByRole("button", { name: "编辑配置", exact: true })
    .click();
  return { profile, outputs, source };
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function unchanged(page: Page, outputs: any[]) {
  const rows = await json(page, "/me/outputs");
  for (const item of outputs)
    expect(rows.find((r: any) => r.id === item.id)).toEqual(item);
}
async function saveAndResume(page: Page) {
  await page.getByRole("button", { name: "保存并检查", exact: true }).click();
}

test("real default repair retains selected existing client and requires fresh check and explicit publish", async ({
  page,
}, info) => {
  const { profile, outputs } = await fixture(page);
  await page.getByRole("button", { name: "检查发布", exact: true }).click();
  await page
    .getByRole("radio", { name: new RegExp("更新「" + outputs[1].name + "」") })
    .click();
  await page.getByRole("button", { name: "检查所选订阅", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "检查订阅更新「" + outputs[1].name + "」",
    exact: true,
  });
  const failure = dialog.getByRole("alert", {
    name: "无法检查：默认流量去向已不可用",
  });
  await expect(failure).toBeVisible();
  await unchanged(page, outputs);
  await failure.getByRole("button", { name: "调整默认流量去向" }).click();
  await expect(dialog).not.toBeVisible();
  const control = page.getByRole("combobox", {
    name: "默认流量行为",
    exact: true,
  });
  await expect(control).toBeFocused();
  await expect(control).toBeInViewport();
  await unchanged(page, outputs);
  await choose(page, "默认流量行为", "直连");
  await saveAndResume(page);
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", {
    name: "确认更新「" + outputs[1].name + "」",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await unchanged(page, outputs);
  await dialog
    .getByRole("button", { name: "预览此订阅更新", exact: true })
    .click();
  await expect(confirm).toBeEnabled();
  await unchanged(page, outputs);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("repaired-phone-ready-for-explicit-confirmation.png"),
    animations: "disabled",
  });
  await confirm.click();
  await expect(dialog).not.toBeVisible();
  const rows = await json(page, "/me/outputs");
  expect(rows.find((r: any) => r.id === outputs[0].id)).toEqual(outputs[0]);
  const changed = rows.find((r: any) => r.id === outputs[1].id);
  expect(changed.target).toEqual(outputs[1].target);
  expect(changed.revision).not.toBe(outputs[1].revision);
  expect(
    (await json(page, "/me/profiles")).find((p: any) => p.id === profile.id).ir
      .defaultAction,
  ).toEqual({ kind: "direct" });
});

test("repeated missing reference focuses the exact second rule and group without changing saved intent", async ({
  page,
}, info) => {
  const { profile, outputs } = await fixture(page, true);
  const warning = page.getByRole("alert", { name: "部分流量去向当前不可用" });
  await expect(warning).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await warning
    .getByRole("button", { name: "调整规则 2 的去向", exact: true })
    .click();
  const rule = page.getByRole("combobox", {
    name: "规则 2 的流量去向",
    exact: true,
  });
  await expect(rule).toBeFocused();
  await expect(rule).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole("tab", { name: "分流规则", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: info.outputPath("second-rule-repair-mobile.png"),
    animations: "disabled",
  });
  const overflow = await page.locator("body").evaluate((body) =>
    Array.from(body.querySelectorAll("*"))
      .map((el) => ({
        tag: el.tagName,
        cls: el.className,
        left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right,
        width: el.getBoundingClientRect().width,
      }))
      .filter((el) => el.right > innerWidth + 1 && el.width > 1),
  );
  await info.attach("overflow-elements", {
    body: JSON.stringify(overflow),
    contentType: "application/json",
  });
  await expect.soft(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.setViewportSize({ width: 320, height: 844 });
  await warning
    .getByRole("button", { name: "调整规则 2 的去向", exact: true })
    .click();
  await expect(rule).toBeFocused();
  await expect(rule).toBeInViewport({ ratio: 1 });
  await expect.soft(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
  await page.screenshot({
    path: info.outputPath("second-rule-repair-320.png"),
    animations: "disabled",
  });
  await warning
    .getByRole("button", { name: "调整策略组「旅行」的成员", exact: true })
    .click();
  const group = page.getByRole("combobox", {
    name: "策略组「旅行」的固定成员",
    exact: true,
  });
  await expect(group).toBeFocused();
  await expect(group).toBeInViewport({ ratio: 1 });
  await expect.soft(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
  await page.screenshot({
    path: info.outputPath("group-repair-320.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("tab", { name: "检查与预览", exact: true }).click();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/me/profiles/preview") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "预览配置", exact: true }).click();
  const r = await response;
  expect(r.status()).toBe(400);
  expect((await r.json()).validation.location).toEqual({
    kind: "group",
    id: "travel",
  });
  const failure = page.getByRole("alert", {
    name: "无法检查：策略组「旅行」有不可用成员",
  });
  await failure
    .getByRole("button", { name: "调整策略组「旅行」的成员", exact: true })
    .click();
  await expect(group).toBeFocused();
  await unchanged(page, outputs);
  const saved = (await json(page, "/me/profiles")).find(
    (p: any) => p.id === profile.id,
  );
  expect(saved.ir.rules).toEqual(profile.ir.rules);
  expect(saved.ir.groups).toEqual(profile.ir.groups);
});

test("new client repair retains name target and output content without creating until confirmation", async ({
  page,
}, info) => {
  const { outputs } = await fixture(page);
  const name = "出差手机";
  await page.getByRole("button", { name: "检查发布", exact: true }).click();
  await page
    .getByRole("radio", { name: "创建新的客户端订阅", exact: true })
    .click();
  await page.getByRole("button", { name: "检查所选订阅", exact: true }).click();
  let dialog = page.getByRole("dialog", {
    name: "新增客户端订阅",
    exact: true,
  });
  await dialog.getByRole("textbox", { name: "订阅名称" }).fill(name);
  await choose(page, "目标客户端", "sing-box 1.14.3");
  await choose(page, "输出内容", "纯节点输出");
  await dialog
    .getByRole("button", { name: "检查发布内容", exact: true })
    .click();
  const failure = dialog.getByRole("alert", {
    name: "无法检查：默认流量去向已不可用",
  });
  await expect(failure).toBeVisible();
  const before = await json(page, "/me/outputs");
  await failure.getByRole("button", { name: "调整默认流量去向" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "默认流量行为", exact: true }),
  ).toBeFocused();
  await choose(page, "默认流量行为", "直连");
  await saveAndResume(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "订阅名称" })).toHaveValue(
    name,
  );
  await expect(
    dialog.getByText("sing-box 1.14.3", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("纯节点输出", { exact: true })).toBeVisible();
  const create = dialog.getByRole("button", {
    name: "创建并发布「" + name + "」",
    exact: true,
  });
  await expect(create).toHaveCount(0);
  const check = dialog.getByRole("button", {
    name: "检查发布内容",
    exact: true,
  });
  await expect(check).toBeEnabled();
  expect(await json(page, "/me/outputs")).toEqual(before);
  await check.click();
  await expect(create).toBeEnabled();
  expect(await json(page, "/me/outputs")).toEqual(before);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("new-client-repair-choices-retained.png"),
    animations: "disabled",
  });
  await create.click();
  await expect(dialog).not.toBeVisible();
  const after = await json(page, "/me/outputs");
  expect(after).toHaveLength(before.length + 1);
  const created = after.find((r: any) => r.name === name);
  expect(created.target).toEqual({ adapterId: "sing-box", version: "1.14.3" });
  expect(created.mode).toBe("nodes-only");
  await unchanged(page, outputs);
});
