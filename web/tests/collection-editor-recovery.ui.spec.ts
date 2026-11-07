import type { Locator, Page, TestInfo } from "@playwright/test";
import type { Collection, PipelineStep } from "../src/types";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import {
  collectionEditorRecoveryFixture,
  legacyCollectionEditorFixture,
  recipe,
  type CollectionRevision,
} from "./collection-editor-recovery-backend";
import { settledTask } from "./ui-settled-task";

// Actual browser -> built UI -> isolated normal control plane. No fulfilled API
// responses. Only a failed read and a held read interrupt real HTTP transport.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

const conflictTitle = "集合或来源已变化";
const retainedCopy = "当前输入已保留，不能覆盖新版本。";
const confirmationTitle = "放弃当前修改并读取最新集合？";
const consequence = "这会替换集合名称、来源选择、顺序和处理步骤。已保存的来源和已发布订阅不会改变。";

function sourceGroup(editor: Locator, name: string) {
  return editor.getByRole("group", { name: new RegExp(`^\\d+\\. ${name} 来源处理`) });
}

async function sourceStage(editor: Locator, name: string) {
  const group = sourceGroup(editor, name);
  const disclosure = group.getByRole("button", { name: new RegExp(`^\\d+\\. ${name} 来源处理`) });
  if ((await disclosure.getAttribute("aria-expanded")) !== "true") await disclosure.click();
  return group.getByRole("group", { name: "来源处理", exact: true });
}

async function assertSteps(stage: Locator, steps: PipelineStep[]) {
  await expect(stage.getByRole("switch")).toHaveCount(steps.length);
  for (const [index, step] of steps.entries()) {
    const enabled = stage.getByRole("switch", { name: `启用步骤 ${index + 1}`, exact: true });
    if (step.enabled) await expect(enabled).toBeChecked();
    else await expect(enabled).not.toBeChecked();
    if (step.kind === "rename")
      await expect(stage.getByLabel(`步骤 ${index + 1} 命名模板`, { exact: true })).toHaveValue(step.template!);
    if (step.kind === "override") {
      await expect(stage.getByLabel("覆盖地区", { exact: true })).toHaveValue(step.override!.region!);
      await expect(stage.getByLabel("覆盖端口", { exact: true })).toHaveValue(String(step.override!.port));
    }
  }
}

async function assertVisibleRecipe(
  editor: Locator,
  value: Collection,
  sources: Array<{ id: string; name: string }>,
) {
  await expect(editor.getByLabel("集合名称", { exact: true })).toHaveValue(value.name);
  await expect(editor.getByRole("button", { name: /^\d+\. .+ 来源处理/ })).toHaveCount(value.sources.length);
  for (const [index, source] of value.sources.entries()) {
    const name = sources.find((item) => item.id === source.sourceId)!.name;
    await expect(editor.getByRole("button", { name: new RegExp(`^${index + 1}\\. ${name} 来源处理`) })).toBeVisible();
    await assertSteps(await sourceStage(editor, name), source.steps);
  }
  await assertSteps(editor.getByRole("group", { name: "合并后处理", exact: true }), value.steps);
}

async function previewRecipe(page: Page, editor: Locator) {
  const response = page.waitForResponse((value) =>
    value.request().method() === "POST" &&
    new URL(value.url()).pathname === "/api/me/collections/preview");
  await editor.getByRole("button", { name: "预览处理结果", exact: true }).click();
  const preview = await response;
  expect(preview.status(), "Real backend accepts the local processing preview").toBe(200);
  await expect(editor.getByText("逐阶段预览", { exact: true })).toBeVisible();
  return recipe(preview.request().postDataJSON());
}

async function capture(page: Page, surface: Locator, info: TestInfo, name: string) {
  await settledTask(surface);
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false,
    mask: [page.locator('input, textarea, pre, code, canvas, a[href*="/feed/"]')] });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`real collection conflict preserves the whole local recipe until confirmed reload and fresh save at ${width}px`, async ({
    page, playwright, baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const admin = await playwright.request.newContext({ baseURL });
    const concurrent = await playwright.request.newContext({ baseURL });
    let release = () => {};
    try {
      const f = await collectionEditorRecoveryFixture(admin, page.request, concurrent);
      const path = `/api/me/collections/${f.id}`;
      const browserWrites: string[] = [];
      let detailReads = 0;
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "GET" && pathname === path) detailReads++;
        if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) &&
          /^\/api\/me\/(sources|collections|profiles|outputs)(?:\/|$)/.test(pathname) &&
          !pathname.endsWith("/preview")) browserWrites.push(`${request.method()} ${pathname}`);
      });
      await page.goto("/#collections");
      await page.getByRole("button", { name: /待恢复集合.*编辑集合/ }).click();
      // Title follows the edited name. Locate the task by its unique labeled
      // field rather than retaining an obsolete accessible title.
      const editor = page.getByRole("dialog").filter({ has: page.getByLabel("集合名称", { exact: true }) });
      const save = editor.getByRole("button", { name: "保存集合", exact: true });
      const reload = editor.getByRole("button", { name: "读取最新集合", exact: true, includeHidden: true });
      const confirmation = page.getByRole("alertdialog", { name: confirmationTitle, exact: true });
      const accept = confirmation.getByRole("button", { name: "放弃修改并读取", exact: true });
      const cancel = confirmation.getByRole("button", { name: "保留当前输入", exact: true });
      await assertVisibleRecipe(editor, f.initial, f.sources);

      const local = structuredClone(f.initial);
      local.name = "本地未保存集合";
      await editor.getByLabel("集合名称", { exact: true }).fill(local.name);
      for (const [index, source] of f.sources.entries()) {
        const stage = await sourceStage(editor, source.name);
        const template = `Local ${index} {name}`;
        const port = 2201 + index;
        await stage.getByLabel("步骤 1 命名模板", { exact: true }).fill(template);
        await stage.getByLabel("覆盖端口", { exact: true }).fill(String(port));
        local.sources[index].steps[0].template = template;
        local.sources[index].steps[1].override!.port = port;
      }
      const merged = editor.getByRole("group", { name: "合并后处理", exact: true });
      await merged.getByLabel("步骤 1 命名模板", { exact: true }).fill("Local merged {name}");
      await merged.getByLabel("覆盖端口", { exact: true }).fill("2500");
      await merged.getByRole("switch", { name: "启用步骤 3", exact: true }).click();
      local.steps[0].template = "Local merged {name}";
      local.steps[1].override!.port = 2500;
      local.steps[2].enabled = true;
      expect(await previewRecipe(page, editor)).toEqual(local);

      const newest = await f.advance();
      const rejection = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === path);
      await save.click();
      const rejected = await rejection;
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "COLLECTION_DRAFT_CHANGED" });
      expect(rejected.request().headers()["if-match"]).toBe(f.opened.revisionToken);
      expect(rejected.request().postDataJSON()).not.toHaveProperty("revisionToken");
      expect(recipe(rejected.request().postDataJSON())).toEqual(local);
      await expect(editor.getByText(conflictTitle, { exact: true })).toBeVisible();
      await expect(editor.getByText(retainedCopy, { exact: true })).toBeVisible();
      await expect(save).toBeDisabled();
      await assertVisibleRecipe(editor, local, f.sources);
      expect(await f.read()).toEqual(newest);
      await f.unchangedDependencies();
      await reload.scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-conflict-${width}`);

      const readsBeforeDecision = detailReads;
      await reload.click();
      await expect(confirmation).toContainText(consequence);
      await expect(cancel).toBeFocused();
      await capture(page, confirmation, info, `collection-reload-decision-${width}`);
      await cancel.click();
      await expect(confirmation).toHaveCount(0);
      await expect(reload).toBeFocused();
      await assertVisibleRecipe(editor, local, f.sources);
      expect(await previewRecipe(page, editor)).toEqual(local);
      expect(detailReads, "Cancel grants no fresh read or draft replacement").toBe(readsBeforeDecision);
      expect(await f.read()).toEqual(newest);

      // Fail exactly one requested real read. No replacement success payload
      // or artificial API error response can conceal backend behavior.
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        await route.abort("failed");
      }, { times: 1 });
      const failed = page.waitForEvent("requestfailed", { predicate: (request) => request.method() === "GET" && new URL(request.url()).pathname === path });
      await reload.click();
      await accept.click();
      await failed;
      await expect(confirmation).toHaveCount(0);
      await expect(editor.getByText("无法连接服务。请检查网络后重试，当前输入已保留。", { exact: true })).toBeVisible();
      await expect(reload).toBeEnabled();
      await expect(save).toBeDisabled();
      await assertVisibleRecipe(editor, local, f.sources);
      expect(await previewRecipe(page, editor)).toEqual(local);
      expect(await f.read()).toEqual(newest);
      expect(browserWrites).toEqual([`PUT ${path}`]);

      // Hold the next GET before it reaches the server. The confirmed decision
      // closes first; its owning editor then blocks another action or dismissal.
      let entered = () => {};
      const held = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        entered();
        await gate;
        await route.continue();
      }, { times: 1 });
      const freshResponse = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === path);
      const readsBeforeReload = detailReads;
      // Role/name and label locators can stop matching inside an inert fieldset.
      // Identify active controls first, then inspect the same DOM nodes while busy.
      // The sheet title remains outside its inert fieldset.
      const pendingEditor = page.getByRole("dialog", { name: local.name, exact: true });
      const pendingReload = pendingEditor.locator("button").filter({ hasText: /^\s*读取最新集合\s*$/ });
      const pendingSource = pendingEditor.locator("button").filter({ hasText: /^\s*添加来源\s*$/ });
      const pendingName = pendingEditor.locator("label").filter({ hasText: /^\s*集合名称\s*$/ }).locator("input");
      const identities = [
        [pendingEditor, await editor.elementHandle()] as const,
        [pendingReload, await reload.elementHandle()] as const,
        [pendingSource, await editor.getByRole("button", { name: "添加来源", exact: true }).elementHandle()] as const,
        [pendingName, await editor.getByLabel("集合名称", { exact: true }).elementHandle()] as const,
      ];
      await reload.click();
      await accept.click();
      await held;
      try {
        await expect(confirmation).toHaveCount(0);
        for (const [control, identity] of identities) {
          await expect(control).toHaveCount(1);
          expect(await control.evaluate((element, original) => element === original, identity)).toBe(true);
        }
        await expect(pendingEditor).toHaveAttribute("aria-busy", "true");
        await expect(pendingReload).toBeDisabled();
        await expect(pendingReload).toHaveAttribute("aria-busy", "true");
        await expect(pendingEditor.getByRole("button", { name: "保存集合", exact: true })).toBeDisabled();
        await expect(pendingName).toBeDisabled();
        await expect(pendingSource).toBeDisabled();
        await expect(pendingEditor.getByRole("button", { name: "关闭", exact: true })).toHaveCount(0);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        await page.keyboard.press("Escape");
        await expect(pendingEditor).toBeVisible();
        await expect(confirmation).toHaveCount(0);
        expect(detailReads).toBe(readsBeforeReload + 1);
        expect(browserWrites).toEqual([`PUT ${path}`]);
        // A deliberately busy task cannot use settledTask. Capture the actual
        // held state explicitly, with the same private-input masks as other shots.
        const pendingPath = info.outputPath(`collection-reload-pending-${width}.png`);
        await page.screenshot({ path: pendingPath, fullPage: false,
          mask: [page.locator('input, textarea, pre, code, canvas, a[href*="/feed/"]')] });
        await info.attach(`collection-reload-pending-${width}`, { path: pendingPath, contentType: "image/png" });
      } finally { release(); }
      const fresh = await freshResponse;
      expect(fresh.status()).toBe(200);
      const reloaded = (await fresh.json()) as CollectionRevision;
      expect(reloaded).toEqual(newest);
      await expect(confirmation).toHaveCount(0);
      await expect(editor.getByLabel("集合名称", { exact: true })).toBeFocused();
      await expect(editor.getByText(conflictTitle, { exact: true })).toHaveCount(0);
      await expect(editor.getByText("逐阶段预览", { exact: true })).toHaveCount(0);
      await expect(reload).toHaveCount(0);
      await expect(save).toBeEnabled();
      await assertVisibleRecipe(editor, f.latest, f.sources);
      await editor.getByLabel("集合名称", { exact: true }).scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-reloaded-${width}`);
      expect(await previewRecipe(page, editor)).toEqual(f.latest);
      await merged.scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-reloaded-processing-${width}`);
      expect(await f.read()).toEqual(newest);
      await f.unchangedDependencies();

      const finalRecipe = { ...f.latest, name: "读取后保存集合" };
      await editor.getByLabel("集合名称", { exact: true }).fill(finalRecipe.name);
      const savedResponse = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === path);
      await save.click();
      const saved = await savedResponse;
      expect(saved.status()).toBe(200);
      expect(saved.request().headers()["if-match"]).toBe(reloaded.revisionToken);
      expect(saved.request().postDataJSON()).not.toHaveProperty("revisionToken");
      expect(recipe(saved.request().postDataJSON())).toEqual(finalRecipe);
      await expect(editor).toHaveCount(0);
      const final = await f.read();
      expect(recipe(final)).toEqual(finalRecipe);
      expect(final.revisionToken).not.toBe(reloaded.revisionToken);
      expect(browserWrites).toEqual([`PUT ${path}`, `PUT ${path}`]);
      await f.unchangedDependencies();
      // Explicit close after reopening uses the new complete baseline and must
      // not resurrect the discarded local input or a false unsaved warning.
      await page.getByRole("button", { name: /读取后保存集合.*编辑集合/ }).click();
      await assertVisibleRecipe(editor, finalRecipe, f.sources);
      await editor.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await concurrent.dispose();
      await admin.dispose();
    }
  });
}

test("legacy null collection and source-step slices survive real stale-editor recovery", async ({
  page, playwright, baseURL,
}, info) => {
  requireLoopback(baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await playwright.request.newContext({ baseURL });
  const concurrent = await playwright.request.newContext({ baseURL });
  try {
    const f = await legacyCollectionEditorFixture(admin, page.request, concurrent);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/#collections");
    const editor = page.getByRole("dialog").filter({ has: page.getByLabel("集合名称", { exact: true }) });
    const save = editor.getByRole("button", { name: "保存集合", exact: true });
    const merged = editor.getByRole("group", { name: "合并后处理", exact: true });
    const addLocalStep = async (stage: Locator) => {
      await stage.getByRole("combobox", { name: "添加处理步骤", exact: true }).click();
      await page.getByRole("option", { name: "去除重复连接", exact: true }).click();
      await expect(stage.getByRole("switch", { name: "启用步骤 1", exact: true })).toBeChecked();
    };
    for (const [index, record] of f.records.entries()) {
      const path = `/api/me/collections/${record.initial.id}`;
      const open = page.getByRole("button", { name: new RegExp(`${record.initial.name}.*编辑集合`) });
      // Both original records contain real JSON null arrays. Opening and an
      // unchanged close must treat them as empty without creating a dirty draft.
      await open.click();
      await assertVisibleRecipe(editor, record.normalized, [f.source]);
      await editor.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await open.click();
      await editor.getByLabel("集合名称", { exact: true }).fill("本地旧版集合修改");
      await addLocalStep(merged);
      if (record.normalized.sources.length)
        await addLocalStep(await sourceStage(editor, f.source.name));
      const newest = await f.advance(record);
      const rejection = page.waitForResponse((response) =>
        response.request().method() === "PUT" && new URL(response.url()).pathname === path);
      await save.click();
      const rejected = await rejection;
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "COLLECTION_DRAFT_CHANGED" });
      expect(rejected.request().headers()["if-match"]).toBe(record.revisionToken);
      await expect(editor.getByLabel("集合名称", { exact: true })).toHaveValue("本地旧版集合修改");
      await expect(merged.getByRole("switch")).toHaveCount(1);
      if (record.normalized.sources.length)
        await expect((await sourceStage(editor, f.source.name)).getByRole("switch")).toHaveCount(1);
      expect(await f.read(record.initial.id)).toEqual(newest);
      await expect(save).toBeDisabled();

      const freshResponse = page.waitForResponse((response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname === path);
      await editor.getByRole("button", { name: "读取最新集合", exact: true }).click();
      await page.getByRole("alertdialog", { name: confirmationTitle, exact: true })
        .getByRole("button", { name: "放弃修改并读取", exact: true }).click();
      const fresh = await freshResponse;
      expect(fresh.status()).toBe(200);
      expect(await fresh.json()).toEqual(newest);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(editor.getByLabel("集合名称", { exact: true })).toBeFocused();
      const normalized = { ...record.normalized, name: newest.name as string };
      await assertVisibleRecipe(editor, normalized, [f.source]);
      await expect(save).toBeEnabled();
      await expect(editor.getByRole("button", { name: "读取最新集合", exact: true })).toHaveCount(0);
      await editor.getByLabel("集合名称", { exact: true }).scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-legacy-null-reloaded-${index}-390`);

      const finalRecipe = { ...normalized, name: `${record.initial.name}恢复后保存` };
      await editor.getByLabel("集合名称", { exact: true }).fill(finalRecipe.name);
      const savedResponse = page.waitForResponse((response) =>
        response.request().method() === "PUT" && new URL(response.url()).pathname === path);
      await save.click();
      const saved = await savedResponse;
      expect(saved.status()).toBe(200);
      expect(saved.request().headers()["if-match"]).toBe(newest.revisionToken);
      expect(saved.request().postDataJSON()).not.toHaveProperty("revisionToken");
      expect(recipe(saved.request().postDataJSON())).toEqual(finalRecipe);
      await expect(editor).toHaveCount(0);
      expect(recipe(await f.read(record.initial.id))).toEqual(finalRecipe);
    }
    expect(errors, "Legacy null slices never crash collection list or editor").toEqual([]);
  } finally {
    await concurrent.dispose();
    await admin.dispose();
  }
});
