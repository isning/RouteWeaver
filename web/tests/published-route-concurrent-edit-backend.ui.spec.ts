import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { headers, names, read, seedInfrastructure, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Real HTTP CAS against a fresh normal-CLI database. All records are synthetic;
// no route execution, enrollment, native process, principals or live nodes.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

async function capture(page: Page, info: TestInfo, surface: Locator, width: number) {
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await surface.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  const path = info.outputPath(`concurrent-line-review-${width}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(`Concurrent line choices at ${width}px`, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`recovers a real conflicting public line without losing local input at ${width}px`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    await seedInfrastructure(page.request, true);
    await page.goto("/#published-routes");
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog", { name: `编辑 ${names.line}`, exact: true });
    await settledTask(editor);
    await editor.getByRole("textbox", { name: "线路名称", exact: true }).fill("我保留的公开线路名称");
    await editor.getByRole("spinbutton", { name: "对外端口", exact: true }).fill("24443");
    const original = await read(page.request, "/published-routes/uiux-inventory/resolve");
    const concurrent = {
      id: original.id, name: "另一处更新的公开线路", deploymentId: original.deploymentId,
      endpointIds: original.endpointIds, publicHost: "127.0.0.2", publicPort: 25443,
    };
    const updated = await page.request.put("/api/published-routes/uiux-inventory", {
      headers: { ...await headers(page.request), "If-Match": original.revisionToken }, data: concurrent,
    });
    expect(updated.status()).toBe(200);
    const reviewed = await updated.json();
    expect(reviewed.revisionToken).not.toBe(original.revisionToken);
    const browserWrites: { method: string; token: string | undefined; data: unknown }[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/published-routes/uiux-inventory" && request.method() === "PUT")
        browserWrites.push({ method: request.method(), token: request.headers()["if-match"], data: request.postDataJSON() });
    });
    await editor.getByRole("button", { name: "检查公开线路", exact: true }).click();
    await editor.getByRole("button", { name: "保存公开线路", exact: true }).click();
    const compare = editor.getByRole("button", { name: "读取最新版本并比较", exact: true });
    await expect(compare).toBeVisible();
    expect(browserWrites).toHaveLength(1);
    await compare.click();
    let review = page.getByRole("dialog", { name: "比较公开线路修改", exact: true });
    await settledTask(review);
    await review.getByRole("group", { name: "线路名称", exact: true }).getByRole("radio", { name: "使用最新版本", exact: true }).click();
    await review.getByRole("button", { name: "取消比较", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(compare).toBeFocused();
    await expect(editor.getByRole("textbox", { name: "线路名称", exact: true })).toHaveValue("我保留的公开线路名称");
    await expect(editor.getByRole("spinbutton", { name: "对外端口", exact: true })).toHaveValue("24443");
    await compare.click();
    review = page.getByRole("dialog", { name: "比较公开线路修改", exact: true });
    const proceed = review.getByRole("button", { name: "使用所选内容继续编辑", exact: true });
    await expect(proceed).toBeDisabled();
    const nameGroup = review.getByRole("group", { name: "线路名称", exact: true });
    const addressGroup = review.getByRole("group", { name: "对外地址与端口", exact: true });
    await nameGroup.getByRole("radio", { name: "使用最新版本", exact: true }).click();
    await expect(proceed).toBeDisabled();
    await addressGroup.getByRole("radio", { name: "保留当前输入", exact: true }).click();
    await capture(page, info, review, width);
    await proceed.click();
    await expect(review).toHaveCount(0);
    await expect(editor.getByRole("textbox", { name: "线路名称", exact: true })).toBeFocused();
    await expect(editor.getByRole("button", { name: "保存公开线路", exact: true })).toHaveCount(0);
    expect(browserWrites).toHaveLength(1);
    expect((await read(page.request, "/published-routes/uiux-inventory/resolve")).publicPort).toBe(25443);
    await editor.getByRole("button", { name: "检查公开线路", exact: true }).click();
    await editor.getByRole("button", { name: "保存公开线路", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "另一处更新的公开线路", exact: true })).toBeVisible();
    expect(browserWrites).toHaveLength(2);
    expect(browserWrites[1]).toEqual({ method: "PUT", token: reviewed.revisionToken, data: {
      id: "uiux-inventory", name: "另一处更新的公开线路", deploymentId: "uiux-inventory", endpointIds: ["uiux-inventory"], publicHost: "127.0.0.1", publicPort: 24443,
    } });
    const saved = await read(page.request, "/published-routes/uiux-inventory/resolve");
    expect(saved.name).toBe("另一处更新的公开线路");
    expect(saved.publicPort).toBe(24443);
    expect(saved.revisionToken).not.toBe(reviewed.revisionToken);
    expect(await read(page.request, "/admin/fleet-batches")).toEqual([]);
  });
}
