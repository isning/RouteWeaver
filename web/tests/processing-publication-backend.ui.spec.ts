import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { processingPublicationFixture } from "./processing-publication-backend";
import type { Locator } from "@playwright/test";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("real processing editor → stage comparison → saved recipe → selected feed publication", async ({
  page,
  playwright,
  baseURL,
}) => {
  requireLoopback(baseURL);
  const admin = await playwright.request.newContext({ baseURL });
  try {
    const f = await processingPublicationFixture(admin, page.request);
    await page.goto("/#collections");
    await page.getByRole("button", { name: /处理旅程集合.*编辑集合/ }).click();
    const sheet = page.getByRole("dialog", {
      name: "处理旅程集合",
      exact: true,
    });
    await sheet
      .getByRole("button", { name: /1\. 处理旅程来源 来源处理/ })
      .click();
    const source = sheet.getByRole("group", { name: "来源处理", exact: true });
    const merged = sheet.getByRole("group", {
      name: "合并后处理",
      exact: true,
    });
    const add = async (stage: Locator, name: string) => {
      await stage
        .getByRole("combobox", { name: "添加处理步骤", exact: true })
        .click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    await add(source, "字段覆盖");
    await source.getByLabel("覆盖地区", { exact: true }).fill("DE");
    await source.getByLabel("覆盖端口", { exact: true }).fill("2080");
    await add(merged, "去除重复连接");
    await add(merged, "字段覆盖");
    await merged.getByLabel("覆盖端口", { exact: true }).fill("3080");
    const previewResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/me/collections/preview") &&
        r.request().method() === "POST",
    );
    await sheet
      .getByRole("button", { name: "预览处理结果", exact: true })
      .click();
    const response = await previewResponse;
    expect(response.status()).toBe(200);
    const preview = await response.json();
    expect(preview.endpoints).toHaveLength(1);
    expect(preview.endpoints[0]).toMatchObject({
      region: "DE",
      connection: { port: 3080 },
    });
    expect(
      preview.endpoints[0].provenance.map(
        (r: { endpointId: string }) => r.endpointId,
      ),
    ).toEqual(f.accepted.snapshot.endpoints.map((r: { id: string }) => r.id));
    const recipe = response.request().postDataJSON();
    const firstStage = preview.stages.find(
      (s: { stepId: string }) => s.stepId === recipe.sources[0].steps[0].id,
    );
    expect(firstStage.endpoints).toHaveLength(2);
    expect(firstStage.endpoints[0].connection.port).toBe(2080);
    expect(
      preview.stages.find(
        (s: { stepId: string }) => s.stepId === recipe.steps[0].id,
      ).removedIds,
    ).toEqual([f.accepted.snapshot.endpoints[1].id]);
    await expect(sheet.getByText("逐阶段预览", { exact: true })).toBeVisible();
    await f.unchanged();
    const savedResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/me/collections/${f.id}`) &&
        r.request().method() === "PUT",
    );
    await sheet.getByRole("button", { name: "保存集合", exact: true }).click();
    expect((await savedResponse).status()).toBe(200);
    await expect(sheet).toHaveCount(0);
    await f.unchanged();
    await page.getByRole("button", { name: /处理旅程集合.*编辑集合/ }).click();
    await sheet
      .getByRole("button", { name: /1\. 处理旅程来源 来源处理/ })
      .click();
    await expect(source.getByLabel("覆盖端口", { exact: true })).toHaveValue(
      "2080",
    );
    await expect(merged.getByLabel("覆盖端口", { exact: true })).toHaveValue(
      "3080",
    );
    await sheet.getByRole("button", { name: "关闭", exact: true }).click();
    await page.goto("/#subscriptions");
    const row = page.getByRole("group", {
      name: "客户端订阅 处理待更新订阅",
      exact: true,
    });
    const review = page.getByRole("dialog", {
      name: "检查订阅更新「处理待更新订阅」",
      exact: true,
    });
    await row.getByRole("button", { name: "检查更新", exact: true }).click();
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "取消", exact: true }).click();
    await f.unchanged();
    await row.getByRole("button", { name: "检查更新", exact: true }).click();
    const published = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/outputs/${f.outputs[0].id}/publish`) &&
        r.request().method() === "POST",
    );
    await review
      .getByRole("button", { name: "确认更新「处理待更新订阅」", exact: true })
      .click();
    expect((await published).status()).toBe(200);
    const delivered = JSON.parse(await f.feed(0));
    expect(delivered.proxies).toHaveLength(1);
    expect(delivered.proxies[0]).toMatchObject({
      server: "proxy.example.test",
      port: 3080,
    });
    expect(await f.feed(1)).toBe(f.before[1]);
    expect(await f.readSource()).toEqual(f.sourceBefore);
  } finally {
    await admin.dispose();
  }
});
