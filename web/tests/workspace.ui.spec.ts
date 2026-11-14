import { openWorkspace, navigateWorkspace } from "./ui-session";
import { test, expect } from "@playwright/test";
test("imports directly into a configuration, retains a failed source, and saves only the draft", async ({
  page,
}, testInfo) => {
  const suffix = Date.now().toString(36);
  const sourceName = `UI source ${suffix}`;
  const profileName = `UI work ${suffix}`;
  await openWorkspace(page);
  await navigateWorkspace(page, "我的订阅");
  await page.getByRole("button", { name: /^(设置订阅|新建分流配置)$/ }).click();
  await page.getByLabel("配置名称", { exact: true }).fill(profileName);
  await page.getByRole("button", { name: /^(?:loading )?添加来源$/ }).click();
  const sourceDialog = page.getByRole("dialog", {
    name: "添加订阅来源",
    exact: true,
  });
  await expect(sourceDialog).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "订阅来源", exact: true }),
  ).toHaveCount(0);
  await sourceDialog.getByLabel("来源名称").fill(sourceName);
  await sourceDialog.getByLabel("节点链接或配置内容").fill("not-a-valid-node");
  await sourceDialog
    .getByRole("button", { name: "导入来源", exact: true })
    .click();
  await expect(
    sourceDialog.getByText("输入已保存，导入未完成", { exact: true }),
  ).toBeVisible();
  await expect(sourceDialog.getByLabel("来源名称")).toHaveValue(sourceName);
  await expect(sourceDialog.getByLabel("节点链接或配置内容")).toHaveValue(
    "not-a-valid-node",
  );
  await sourceDialog
    .getByLabel("节点链接或配置内容")
    .fill("socks5://london.example:1080#London");
  await sourceDialog
    .getByRole("button", { name: "导入来源", exact: true })
    .click();
  await expect(sourceDialog).not.toBeVisible();
  const inputs = page.getByRole("region", { name: "连接与流量", exact: true });
  await expect(inputs).toContainText(sourceName);
  await expect(inputs.getByText("1 个有效连接", { exact: true })).toBeVisible();
  await expect(
    inputs.locator(".default-route [role='combobox']"),
  ).toContainText("直连");
  await expect(
    inputs.getByText("已导入的连接尚未用于分流。", { exact: true }),
  ).toBeVisible();
  const sources = await (await page.request.get("/api/me/sources")).json();
  const source = sources.find(
    (item: { name: string }) => item.name === sourceName,
  );
  expect(source.snapshot.endpoints).toHaveLength(1);
  const beforeSave = await (await page.request.get("/api/me/profiles")).json();
  expect(
    beforeSave.some((item: { name: string }) => item.name === profileName),
  ).toBe(false);
  await page.getByRole("tab", { name: "检查与预览", exact: true }).click();
  await page.getByRole("button", { name: "预览配置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "生成结果", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "草稿配置预览", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  const savedProfiles = await (
    await page.request.get("/api/me/profiles")
  ).json();
  const saved = savedProfiles.find(
    (item: { name: string }) => item.name === profileName,
  );
  expect(saved.sourceIds).toEqual([source.id]);
  const outputs = await (await page.request.get("/api/me/outputs")).json();
  expect(
    outputs.filter(
      (item: { profileId: string }) => item.profileId === saved.id,
    ),
  ).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath("direct-source-draft-desktop.png"),
    fullPage: true,
  });
});
test("mobile navigation and cancellation preserve a useful return path", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await navigateWorkspace(page, "我的订阅");
  await page.getByRole("button", { name: "打开导航" }).click();
  await navigateWorkspace(page, "我的订阅");
  await page.getByRole("button", { name: /^(设置订阅|新建分流配置)$/ }).click();
  await page
    .getByLabel("配置名称", { exact: true })
    .fill("Unsaved mobile draft");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true }),
  ).toBeVisible();
  const discard = page.getByRole("alertdialog", {
    name: "放弃未保存的修改？",
    exact: true,
  });
  const keepEditing = discard.getByRole("button", {
    name: "继续编辑",
    exact: true,
  });
  await expect(keepEditing).toBeFocused();
  for (const action of [
    keepEditing,
    discard.getByRole("button", { name: "放弃修改", exact: true }),
  ]) {
    await expect(action).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () => (await action.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: testInfo.outputPath("discard-default-cancel-mobile.png"),
    animations: "disabled",
  });
  await keepEditing.click();
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
    "Unsaved mobile draft",
  );
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: "test-results/profile-mobile.png",
    fullPage: true,
  });
});
test("administrator edits an ordered route without dragging", async ({
  page,
}) => {
  await openWorkspace(page);
  await navigateWorkspace(page, "我的订阅");
  await page.getByText("网络资源", { exact: true }).click();
  await navigateWorkspace(page, "转发路径");
  await expect(
    page.getByRole("heading", { name: "转发路径", exact: true }),
  ).toBeVisible();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "新建转发路径", exact: true })
    .click();
  await page.getByLabel("转发路径名称", { exact: true }).fill("Keyboard route");
  await expect(page.getByRole("tab", { name: "顺序编辑" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "图形编辑" }).click();
  await page.getByRole("tab", { name: "顺序编辑" }).click();
  await expect(page.getByLabel("转发路径名称", { exact: true })).toHaveValue(
    "Keyboard route",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("alertdialog", {
      name: "放弃尚未保存的转发路径修改？",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "转发路径", exact: true }),
  ).toBeVisible();
});
