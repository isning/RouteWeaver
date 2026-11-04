import { test, expect } from "@playwright/test";

// Actual narrow UI, synthetic read-only API. No collection is deleted by this case.
test.use({ trace: "off", screenshot: "off", video: "off" });
test("collection dependency decision remains readable and returns keyboard focus at 320", async ({ page }, info) => {
  const base = info.project.use.baseURL;
  if (!base || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Controlled layout requires loopback");
  const name = "欧洲与亚太区域共同使用的节点集合";
  const unexpected: string[] = [];
  const fixtures: Record<string, unknown> = {
    "/auth/me": { user: { id: "owner", name: "Owner", role: "user" }, csrfToken: "fixture" },
    "/me/sources": [],
    "/me/collections": [{ id: "collection", name, sources: [], steps: [] }],
    "/me/collections/collection/dependencies": { collection: { id: "collection", name }, deletable: false, profiles: [{ id: "daily", name: "日常浏览与工作分流配置" }, { id: "backup", name: "跨区域备用配置" }] },
  };
  await page.route("**/*", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(base).origin) { unexpected.push("external request"); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = url.pathname.slice(4);
    if (request.method() !== "GET" || !(key in fixtures)) {
      unexpected.push(`${request.method()} ${key}`);
      return route.fulfill({ status: 503, json: { message: "Unexpected controlled request" } });
    }
    return route.fulfill({ json: fixtures[key] });
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/#collections");
  const card = page.getByRole("article", { name, exact: true });
  const opener = card.getByRole("button", { name: `删除集合 ${name}` });
  const edit = card.getByRole("button", { name: new RegExp(`${name}.*编辑集合`) });
  await expect(edit).toBeVisible();
  await expect(opener).toHaveText("删除");
  const cardBox = await card.boundingBox(), editBox = await edit.boundingBox(), deleteBox = await opener.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(editBox).not.toBeNull();
  expect(deleteBox).not.toBeNull();
  expect(deleteBox!.y).toBeGreaterThanOrEqual(cardBox!.y);
  expect(deleteBox!.y + deleteBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height);
  expect(Math.abs(editBox!.y - deleteBox!.y)).toBeLessThanOrEqual(1);
  expect(editBox!.x + editBox!.width).toBeLessThanOrEqual(deleteBox!.x);
  await page.screenshot({ path: info.outputPath("collection-card-actions-320.png") });
  for (let attempt = 0; attempt < 2; attempt++) {
    await opener.click();
    const dialog = page.getByRole("dialog", { name: `删除集合「${name}」？` });
    await expect(dialog.getByText("日常浏览与工作分流配置", { exact: true })).toBeVisible();
    await expect(dialog.getByText("跨区域备用配置", { exact: true })).toBeVisible();
    await expect(dialog.getByText("只删除此集合及其处理步骤，不会删除订阅来源、配置或客户端订阅。此操作无法撤销。")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "删除集合", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "保留集合" })).toBeFocused();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (attempt === 0) await page.screenshot({ path: info.outputPath("collection-delete-dependencies-320.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
  }
  expect(unexpected).toEqual([]);
});
