import { expect, test as base, type Page } from "@playwright/test";
import { openWorkspace, navigateWorkspace } from "./ui-session";
import { sourceRowAction } from "./source-row-actions";
import type { Source } from "../src/types";

type RecoveryJourney = {
  headers: Record<string, string>;
  owned: Set<string>;
  assertParentsUnchanged: () => Promise<void>;
};
async function read(page: Page, path: string) {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), "Synthetic read succeeds").toBe(true);
  return response.json();
}
const test = base.extend<{ journey: RecoveryJourney }>({
  journey: async ({ page }, use, info) => {
    await openWorkspace(page);
    const headers = { "X-CSRF-Token": (await read(page, "/auth/me")).csrfToken };
    const owned = new Set<string>();
    const profiles = JSON.stringify(await read(page, "/me/profiles"));
    const outputs = JSON.stringify(await read(page, "/me/outputs"));
    const parentWrites: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET" && /^\/api\/me\/(profiles|outputs|collections)(?:\/|$)/.test(path))
        parentWrites.push(request.method());
    });
    try {
      await use({
        headers, owned,
        assertParentsUnchanged: async () => {
          expect(parentWrites, "Source recovery never writes a containing draft or subscription").toEqual([]);
          // Boolean comparisons avoid dumping any existing account fixture in diagnostics.
          expect(JSON.stringify(await read(page, "/me/profiles")) === profiles).toBe(true);
          expect(JSON.stringify(await read(page, "/me/outputs")) === outputs).toBe(true);
        },
      });
    } finally {
      const primaryFailure = info.status !== info.expectedStatus;
      try {
        if (page.isClosed()) {
          if (!primaryFailure) throw new Error("Cleanup page closed unexpectedly.");
        } else {
          await page.unrouteAll({ behavior: "wait" });
          for (const id of owned) {
            const response = await page.request.delete(`/api/me/sources/${encodeURIComponent(id)}`, { headers });
            expect(response.ok(), "Remove owned synthetic source").toBe(true);
          }
        }
      } catch {
        // Do not replace the failed journey with a closed-page cleanup failure.
        // On success, cleanup remains required and reports no private payload.
        if (!primaryFailure) throw new Error("Owned synthetic source cleanup did not complete.");
      }
    }
  },
});

for (const width of [1440, 390]) {
  test(`lost source creation cannot overwrite a newer version and recovery preserves its parent draft at ${width}px`, async ({ page, journey }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await navigateWorkspace(page, "节点集合");
    await page.getByRole("button", { name: "新建集合", exact: true }).first().click();
    const parentName = `Unsaved collection ${Date.now().toString(36)}`;
    const parent = page.getByRole("dialog", { name: "新建集合", exact: true });
    await parent.getByLabel("集合名称", { exact: true }).fill(parentName);
    await parent.getByRole("button", { name: "添加来源", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "添加订阅来源", exact: true });
    const sourceName = `Recovery source ${Date.now().toString(36)}`;
    const originalContent = "socks5://original.example:1080#Original";
    await editor.getByLabel("来源名称").fill(sourceName);
    await editor.getByLabel("节点链接或配置内容").fill(originalContent);
    let created: Source | undefined;
    let createAttempts = 0;
    const creationGuards: Array<string | undefined> = [];
    await page.route("**/api/me/sources", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      createAttempts++;
      creationGuards.push(route.request().headers()["if-none-match"]);
      if (createAttempts > 1) return route.continue();
      // Only delivery is lost: the real control plane owns parsing and commit.
      const response = await route.fetch();
      expect(response.ok(), "Initial synthetic source really commits").toBe(true);
      created = await response.json();
      journey.owned.add(created!.id);
      await route.abort("failed");
    });
    await editor.getByRole("button", { name: "导入来源", exact: true }).click();
    await expect(editor.getByText("尚未确认输入是否保存", { exact: true })).toBeVisible();
    expect(created !== undefined).toBe(true);
    const id = created!.id;
    const latestInput = { id, name: `${sourceName} current`, kind: "text", enabled: true,
      content: "socks5://current.example:1081#Current", revision: created!.revision };
    const update = await page.request.put(`/api/me/sources/${id}`, { headers: journey.headers, data: latestInput });
    expect(update.ok(), "Concurrent synthetic source edit succeeds").toBe(true);
    const newer = await update.json();
    const retry = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/me/sources" && response.request().method() === "POST");
    await editor.getByRole("button", { name: "导入来源", exact: true }).click();
    expect((await retry).status()).toBe(412);
    expect(creationGuards).toEqual(["*", "*"]);
    const preserved = await read(page, `/me/sources/${id}/reveal`);
    expect(preserved.revision === newer.revision && preserved.content === latestInput.content).toBe(true);
    await expect(editor.getByLabel("节点链接或配置内容")).toHaveValue(originalContent);
    await editor.getByRole("button", { name: "读取最新来源", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "放弃当前修改并读取最新来源？", exact: true });
    await confirmation.getByRole("button", { name: "保留当前输入", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(editor.getByLabel("节点链接或配置内容")).toHaveValue(originalContent);
    await editor.getByRole("button", { name: "读取最新来源", exact: true }).click();
    await confirmation.getByRole("button", { name: "放弃修改并读取", exact: true }).click();
    const recovered = page.getByRole("dialog", { name: "编辑来源", exact: true });
    await expect(recovered.getByLabel("节点链接或配置内容")).toHaveValue(latestInput.content);
    await expect(recovered.getByLabel("来源名称")).toBeFocused();
    await expect(recovered.getByText("尚未确认输入是否保存", { exact: true })).toHaveCount(0);
    await recovered.screenshot({ path: info.outputPath(`source-recovered-${width}.png`), animations: "disabled",
      mask: [recovered.getByLabel("节点链接或配置内容")] });
    expect(await recovered.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await recovered.getByLabel("来源名称").fill(`${sourceName} fresh`);
    const finalWrite = page.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/me/sources/${id}`);
    await recovered.getByRole("button", { name: "导入来源", exact: true }).click();
    expect((await finalWrite).postDataJSON().revision === newer.revision).toBe(true);
    await expect(recovered).toHaveCount(0);
    await expect(parent.getByLabel("集合名称", { exact: true })).toHaveValue(parentName);
    await expect(parent.getByText(`当前集合已选择来源「${sourceName} fresh」。`, { exact: true })).toBeVisible();
    await journey.assertParentsUnchanged();
  });

  test(`stale source edits require a confirmed full reload before a fresh save at ${width}px`, async ({ page, journey }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const suffix = Date.now().toString(36);
    const id = `source-edit-recovery-${width}-${suffix}`;
    const name = `Stale source ${suffix}`;
    const input = { id, name, kind: "text", enabled: false, content: "Original synthetic text", applyMode: "auto" };
    const response = await page.request.post("/api/me/sources", { headers: journey.headers, data: input });
    expect(response.ok()).toBe(true);
    journey.owned.add(id);
    const initial = await response.json();
    await navigateWorkspace(page, "订阅来源");
    await page.getByRole("textbox", { name: "搜索来源", exact: true }).fill(name);
    await (await sourceRowAction(page, "编辑", name)).click();
    const editor = page.getByRole("dialog", { name: "编辑来源", exact: true });
    await expect(editor.getByLabel("节点链接或配置内容")).toHaveValue(input.content);
    await editor.getByLabel("来源名称").fill("Local unsaved name");
    const current = { ...input, kind: "url", content: undefined, url: "https://synthetic.example/current-feed",
      name: `${name} current`, applyMode: "manual", revision: initial.revision };
    const changed = await page.request.put(`/api/me/sources/${id}`, { headers: journey.headers, data: current });
    expect(changed.ok()).toBe(true);
    const latest = await changed.json();
    const conflict = page.waitForResponse((value) => value.request().method() === "PUT" && new URL(value.url()).pathname === `/api/me/sources/${id}`);
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(editor.getByText("来源已变化，当前输入已保留。", { exact: true })).toBeVisible();
    await expect(editor.getByLabel("来源名称")).toHaveValue("Local unsaved name");
    await editor.screenshot({ path: info.outputPath(`source-conflict-${width}.png`), animations: "disabled",
      mask: [editor.getByLabel("节点链接或配置内容")] });
    await editor.getByRole("button", { name: "读取最新来源", exact: true }).click();
    await page.getByRole("alertdialog", { name: "放弃当前修改并读取最新来源？", exact: true })
      .getByRole("button", { name: "放弃修改并读取", exact: true }).click();
    await expect(editor.getByLabel("订阅地址")).toHaveValue(current.url);
    await expect(editor.getByLabel("来源名称")).toBeFocused();
    await expect(editor.getByRole("combobox", { name: "更新应用方式", exact: true })).toHaveText("手动应用");
    await editor.getByLabel("来源名称").fill(`${name} fresh`);
    const write = page.waitForRequest((value) => value.method() === "PUT" && new URL(value.url()).pathname === `/api/me/sources/${id}`);
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    const payload = (await write).postDataJSON();
    expect(payload.revision === latest.revision && payload.url === current.url && payload.content === undefined).toBe(true);
    await expect(editor).toHaveCount(0);
    await journey.assertParentsUnchanged();
  });
}
