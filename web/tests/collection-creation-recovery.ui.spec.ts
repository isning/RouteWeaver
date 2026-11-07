import type { Locator, Page, TestInfo } from "@playwright/test";
import type { Collection, PipelineStep } from "../src/types";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { collectionEditorRecoveryFixture, recipe, type CollectionRevision } from "./collection-editor-recovery-backend";
import { settledTask } from "./ui-settled-task";

// All successes come from the isolated normal server. The first creation really
// commits; only its response is lost. Subsequent interruptions abort/hold reads.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });
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
  test(`lost real creation response cannot overwrite a concurrent collection at ${width}px`, async ({ page, playwright, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const admin = await playwright.request.newContext({ baseURL });
    const concurrent = await playwright.request.newContext({ baseURL });
    let release = () => {};
    try {
      // This fixture signs page.request into the browser's own cookie jar and
      // independently signs concurrent in. It also snapshots two real sources,
      // an unrelated existing profile and its published synthetic delivery for
      // invariance checks. This delivery does not depend on the new collection.
      const f = await collectionEditorRecoveryFixture(admin, page.request, concurrent);
      const session = await (await concurrent.get("/api/auth/me")).json();
      const writes: string[] = [];
      let detailReads = 0;
      let path = "";
      const collectionPath = "/api/me/collections";
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "GET" && pathname === path) detailReads++;
        if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) &&
          /^\/api\/me\/(sources|collections|profiles|outputs)(?:\/|$)/.test(pathname) &&
          !pathname.endsWith("/preview")) writes.push(`${request.method()} ${pathname}`);
      });
      await page.goto("/#collections");
      await page.getByRole("button", { name: "新建集合", exact: true }).click();
      const editor = page.getByRole("dialog").filter({ has: page.getByLabel("集合名称", { exact: true }) });
      const save = editor.getByRole("button", { name: "保存集合", exact: true });
      const reload = editor.getByRole("button", { name: "读取最新集合", exact: true });
      const confirmation = page.getByRole("alertdialog", { name: confirmationTitle, exact: true });
      const accept = confirmation.getByRole("button", { name: "放弃修改并读取", exact: true });
      const cancel = confirmation.getByRole("button", { name: "保留当前输入", exact: true });
      await editor.getByLabel("集合名称", { exact: true }).fill("创建响应丢失的集合");
      await editor.getByRole("combobox", { name: "订阅来源", exact: true }).click();
      for (const source of f.sources)
        await page.getByRole("option", { name: new RegExp(source.name) }).click();
      await page.keyboard.press("Escape");
      const addStep = async (stage: Locator, name: string) => {
        await stage.getByRole("combobox", { name: "添加处理步骤", exact: true }).click();
        await page.getByRole("option", { name, exact: true }).click();
      };
      for (const [index, source] of f.sources.entries()) {
        const stage = await sourceStage(editor, source.name);
        await addStep(stage, "重新命名");
        await stage.getByLabel("步骤 1 命名模板", { exact: true }).fill(`Local ${index} {name}`);
        await addStep(stage, "字段覆盖");
        await stage.getByLabel("覆盖地区", { exact: true }).fill(index ? "FR" : "US");
        await stage.getByLabel("覆盖端口", { exact: true }).fill(String(2201 + index));
      }
      const merged = editor.getByRole("group", { name: "合并后处理", exact: true });
      await addStep(merged, "重新命名");
      await merged.getByLabel("步骤 1 命名模板", { exact: true }).fill("Local merged {name}");
      await addStep(merged, "字段覆盖");
      await merged.getByLabel("覆盖地区", { exact: true }).fill("GB");
      await merged.getByLabel("覆盖端口", { exact: true }).fill("2500");
      await addStep(merged, "去除重复连接");
      await merged.getByRole("switch", { name: "启用步骤 3", exact: true }).click();
      const local = await previewRecipe(page, editor);
      expect(local.id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
      expect(local.sources.map((source) => source.sourceId)).toEqual(f.sources.map((source) => source.id));
      expect(local.sources.map((source) => source.steps.map((step) => step.kind))).toEqual([
        ["rename", "override"], ["rename", "override"],
      ]);
      expect(local.steps.map((step) => step.kind)).toEqual(["rename", "override", "deduplicate"]);
      expect(local.name).toBe("创建响应丢失的集合");
      for (const [index, source] of local.sources.entries()) {
        expect(source.steps).toMatchObject([
          { kind: "rename", enabled: true, template: `Local ${index} {name}` },
          { kind: "override", enabled: true, override: { region: index ? "FR" : "US", port: 2201 + index } },
        ]);
      }
      expect(local.steps).toMatchObject([
        { kind: "rename", enabled: true, template: "Local merged {name}" },
        { kind: "override", enabled: true, override: { region: "GB", port: 2500 } },
        { kind: "deduplicate", enabled: false },
      ]);
      // domain.ProcessingStep stores Filter and Override as Go value structs,
      // so encoding/json emits {} for these fields even when the browser omitted
      // them. Build the expected server representation, preserving every supplied
      // field. Do not normalize responses or the original local/retry payload.
      const wireStep = (step: PipelineStep): PipelineStep => ({
        ...step, filter: step.filter ?? {}, override: step.override ?? {},
      });
      const persisted: Collection = {
        ...local,
        sources: local.sources.map((source) => ({
          ...source, steps: source.steps.map(wireStep),
        })),
        steps: local.steps.map(wireStep),
      };
      path = `${collectionPath}/${local.id}`;
      const read = async () => {
        const response = await concurrent.get(path);
        expect(response.status()).toBe(200);
        return await response.json() as CollectionRevision;
      };

      let committed: CollectionRevision | undefined;
      await page.route(`**${collectionPath}`, async (route) => {
        expect(route.request().method()).toBe("POST");
        expect(route.request().headers()["if-none-match"]).toBe("*");
        expect(route.request().headers()["if-match"]).toBeUndefined();
        expect(recipe(route.request().postDataJSON())).toEqual(local);
        // route.fetch performs the genuine authenticated create, with no fulfilled
        // fake success. Abort only after the server acknowledged persistence.
        const actual = await route.fetch();
        expect(actual.status()).toBe(200);
        committed = await actual.json() as CollectionRevision;
        expect(recipe(committed)).toEqual(persisted);
        expect(committed.revisionToken).toBeTruthy();
        expect(await read()).toEqual(committed);
        await route.abort("failed");
      }, { times: 1 });
      const lost = page.waitForEvent("requestfailed", { predicate: (request) =>
        request.method() === "POST" && new URL(request.url()).pathname === collectionPath });
      await save.click();
      await lost;
      await expect(editor.getByText("集合保存结果尚未确认", { exact: true })).toBeVisible();
      await expect(save).toBeEnabled();
      await assertVisibleRecipe(editor, local, f.sources);
      expect(committed).toBeDefined();
      expect(await read()).toEqual(committed);
      expect(detailReads, "Lost response never silently adopts server state").toBe(0);
      await reload.scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-create-uncertain-${width}`);

      // Preserve step identities while changing values/order so stale numeric
      // input buffers and partial adoption cannot satisfy the recovery assertions.
      const latest = structuredClone(persisted);
      latest.name = "其他会话更新的新集合";
      latest.sources.reverse();
      for (const [index, source] of latest.sources.entries()) {
        source.steps[0].template = `Latest ${index} {name}`;
        source.steps[1].override = { region: index ? "DE" : "JP", port: 3201 + index };
        source.steps.reverse();
        source.steps[1].enabled = false;
      }
      latest.steps[0].template = "Latest merged {name}";
      latest.steps[1].override = { region: "CA", port: 3500 };
      latest.steps.reverse();
      const changed = await concurrent.put(path, {
        headers: { "X-CSRF-Token": session.csrfToken, "If-Match": committed!.revisionToken },
        data: latest,
      });
      expect(changed.status()).toBe(200);
      const newest = await changed.json() as CollectionRevision;
      expect(recipe(newest)).toEqual(latest);
      expect(newest.revisionToken).not.toBe(committed!.revisionToken);
      const rejectedResponse = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === collectionPath);
      await save.click();
      const rejected = await rejectedResponse;
      expect(rejected.status()).toBe(412);
      expect(await rejected.json()).toMatchObject({ code: "COLLECTION_CREATION_CONFLICT" });
      expect(rejected.request().headers()["if-none-match"]).toBe("*");
      expect(rejected.request().headers()["if-match"]).toBeUndefined();
      expect(recipe(rejected.request().postDataJSON())).toEqual(local);
      expect(rejected.request().postDataJSON()).not.toHaveProperty("revisionToken");
      await expect(editor.getByText("集合创建发生冲突", { exact: true })).toBeVisible();
      await expect(editor.getByText("此前保存结果尚未确认。当前输入已保留，不能覆盖已保存的集合。", { exact: true })).toBeVisible();
      await expect(save).toBeEnabled();
      await assertVisibleRecipe(editor, local, f.sources);
      expect(await read()).toEqual(newest);
      expect(detailReads).toBe(0);
      const inventory = await concurrent.get(collectionPath);
      expect(inventory.status()).toBe(200);
      expect((await inventory.json() as Collection[]).map((item) => item.id).sort()).toEqual([f.id, local.id].sort());
      await f.unchangedDependencies();
      await reload.scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-create-conflict-${width}`);
      await reload.click();
      await expect(confirmation).toContainText(consequence);
      await expect(cancel).toBeFocused();
      await capture(page, confirmation, info, `collection-create-read-decision-${width}`);
      await cancel.click();
      await expect(confirmation).toHaveCount(0);
      await expect(reload).toBeFocused();
      await assertVisibleRecipe(editor, local, f.sources);
      expect(await previewRecipe(page, editor)).toEqual(local);
      expect(detailReads).toBe(0);
      expect(await read()).toEqual(newest);

      await page.route(`**${path}`, (route) => route.abort("failed"), { times: 1 });
      const failed = page.waitForEvent("requestfailed", { predicate: (request) =>
        request.method() === "GET" && new URL(request.url()).pathname === path });
      await reload.click();
      await accept.click();
      await failed;
      await expect(confirmation).toHaveCount(0);
      await expect(editor.getByText("无法连接服务。请检查网络后重试，当前输入已保留。", { exact: true })).toBeVisible();
      await expect(reload).toBeEnabled();
      await expect(save).toBeEnabled();
      await assertVisibleRecipe(editor, local, f.sources);
      expect(await previewRecipe(page, editor)).toEqual(local);
      expect(await read()).toEqual(newest);
      expect(writes).toEqual([`POST ${collectionPath}`, `POST ${collectionPath}`]);

      let entered = () => {};
      const held = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**${path}`, async (route) => {
        expect(route.request().method()).toBe("GET");
        entered();
        await gate;
        await route.continue();
      }, { times: 1 });
      const freshResponse = page.waitForResponse((response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname === path);
      const readsBeforeReload = detailReads;
      // New creation keeps its task title until the explicit read succeeds.
      // Capture active semantic identities before inert hides fieldset labels.
      const pendingEditor = page.getByRole("dialog", { name: "新建集合", exact: true });
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
        await expect(pendingName).toBeDisabled();
        await expect(pendingSource).toBeDisabled();
        await expect(pendingEditor.getByRole("button", { name: "保存集合", exact: true })).toBeDisabled();
        await expect(pendingEditor.getByRole("button", { name: "关闭", exact: true })).toHaveCount(0);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        await page.keyboard.press("Escape");
        await expect(pendingEditor).toBeVisible();
        await expect(confirmation).toHaveCount(0);
        expect(detailReads).toBe(readsBeforeReload + 1);
        expect(writes).toEqual([`POST ${collectionPath}`, `POST ${collectionPath}`]);
        expect(await read()).toEqual(newest);
        const screenshot = info.outputPath(`collection-create-read-pending-${width}.png`);
        await page.screenshot({ path: screenshot, fullPage: false,
          mask: [page.locator('input, textarea, pre, code, canvas, a[href*="/feed/"]')] });
        await info.attach(`collection-create-read-pending-${width}`, { path: screenshot, contentType: "image/png" });
      } finally { release(); }
      const fresh = await freshResponse;
      expect(fresh.status()).toBe(200);
      expect(await fresh.json()).toEqual(newest);
      await expect(editor.getByLabel("集合名称", { exact: true })).toBeFocused();
      await expect(reload).toHaveCount(0);
      await expect(save).toBeEnabled();
      await expect(editor.getByText("逐阶段预览", { exact: true })).toHaveCount(0);
      await assertVisibleRecipe(editor, latest, f.sources);
      expect(await previewRecipe(page, editor)).toEqual(latest);
      expect(await read()).toEqual(newest);
      expect(writes, "Reading adopts a complete recipe but never writes or publishes").toEqual([
        `POST ${collectionPath}`, `POST ${collectionPath}`,
      ]);
      await f.unchangedDependencies();
      await editor.getByLabel("集合名称", { exact: true }).scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-create-read-complete-${width}`);
      await merged.scrollIntoViewIfNeeded();
      await capture(page, editor, info, `collection-create-read-processing-${width}`);

      const finalRecipe = { ...latest, name: "读取后明确保存的新集合" };
      await editor.getByLabel("集合名称", { exact: true }).fill(finalRecipe.name);
      const savedResponse = page.waitForResponse((response) =>
        response.request().method() === "PUT" && new URL(response.url()).pathname === path);
      await save.click();
      const saved = await savedResponse;
      expect(saved.status()).toBe(200);
      expect(saved.request().headers()["if-match"]).toBe(newest.revisionToken);
      expect(saved.request().headers()["if-none-match"]).toBeUndefined();
      expect(saved.request().postDataJSON()).not.toHaveProperty("revisionToken");
      expect(recipe(saved.request().postDataJSON())).toEqual(finalRecipe);
      await expect(editor).toHaveCount(0);
      const final = await read();
      expect(recipe(final)).toEqual(finalRecipe);
      expect(final.revisionToken).not.toBe(newest.revisionToken);
      expect(writes).toEqual([`POST ${collectionPath}`, `POST ${collectionPath}`, `PUT ${path}`]);
      await f.unchangedDependencies();
      await page.getByRole("button", { name: /读取后明确保存的新集合.*编辑集合/ }).click();
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
