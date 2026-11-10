import { expect, test } from "@playwright/test";
import { navigateWorkspace } from "./ui-session";
import { settledTask } from "./ui-settled-task";

// Actual App session interruption and native history acceptance, synthetic HTTP.
// Offline conceals the editor, so this does not force a hidden Save or claim to
// reproduce the editor-boundary save/dispose dispatch race covered by DOM tests.
test.use({ trace: "off", screenshot: "off", video: "off" });
for (const width of [390, 1440]) {
  test(`collection survives offline concealment then native Back discards only its edit at ${width}px`, async ({
    page, context,
  }, info) => {
    const base = info.project.use.baseURL;
    if (!base || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
      throw new Error("Controlled collection navigation requires loopback");
    const origin = new URL(base).origin;
    const collection = {
      id: "travel", name: "旅行集合", revisionToken: "opened-r1",
      sources: [], steps: [],
    };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "owner", name: "Owner", role: "user" },
        csrfToken: "synthetic",
      },
      "/api/me/sources": [],
      "/api/me/collections": [collection],
    };
    const writes: string[] = [], unexpected: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith("/api/") && request.method() !== "GET")
        writes.push(`${request.method()} ${url.pathname}`);
    });
    await page.route("**/*", (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push("external request");
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/") && request.method() === "GET")
        return route.continue();
      if (request.method() === "GET" && url.pathname in fixtures)
        return route.fulfill({ json: fixtures[url.pathname] });
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 503, json: { message: "Unexpected controlled request" } });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#sources");
    const sourceHeading = page.getByRole("heading", { name: "订阅来源", exact: true, level: 1 });
    await expect(sourceHeading).toBeVisible();
    await navigateWorkspace(page, "节点集合");
    await expect(page).toHaveURL(/#collections$/);
    await page.getByRole("button", { name: /旅行集合.*编辑集合/ }).click();
    const editor = page.getByRole("dialog").filter({ has: page.getByLabel("集合名称", { exact: true }) });
    const field = editor.getByLabel("集合名称", { exact: true });
    await field.fill("离线前的本地修改");
    await settledTask(editor);
    const workspace = page.locator("[data-session-workspace]");
    try {
      await context.setOffline(true);
      await expect(workspace).toHaveAttribute("hidden", "");
      await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "保存集合", exact: true })).not.toBeVisible();
      expect(writes).toEqual([]);
      await context.setOffline(false);
      await expect(workspace).not.toHaveAttribute("hidden", "");
      await expect(workspace).not.toHaveAttribute("inert", "");
      await expect(field).toBeVisible();
      await expect(field).toHaveValue("离线前的本地修改");
      await expect(field).toBeEditable();
      expect(writes).toEqual([]);

      await page.goBack();
      const decision = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
      await expect(decision).toBeVisible();
      await settledTask(decision);
      await expect(decision).toContainText("离开会放弃尚未保存的内容");
      await decision.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
      await expect(decision).toHaveCount(0);
      await expect(editor).toHaveCount(0);
      await expect(sourceHeading).toBeVisible();
      await expect(page).toHaveURL(/#sources$/);
      await navigateWorkspace(page, "节点集合");
      await page.getByRole("button", { name: /旅行集合.*编辑集合/ }).click();
      await expect(field).toHaveValue(collection.name);
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
      await info.attach("collection-session-navigation", {
        contentType: "application/json",
        body: JSON.stringify({ width, offlineConcealed: true, reconnectRetained: true,
          nativeBackDiscarded: true, reopenedOriginal: true, writeCount: writes.length,
          scope: "Actual App with controlled HTTP; not the editor dispatch race" }),
      });
    } finally {
      await context.setOffline(false);
    }
  });
}
