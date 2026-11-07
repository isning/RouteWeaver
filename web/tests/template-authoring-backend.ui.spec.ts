import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { authoringNames as names, authoringTarget, templateAuthoringFixture } from "./template-authoring-backend";
import { settledTask } from "./ui-settled-task";

// Real built UI and normal CLI, with isolated synthetic accounts/data. Only a
// single extraction transport is interrupted; no fulfilled API response, direct
// database edit, external feed, native parser or live-node operation is involved.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const reviewLabel = "我已检查内容，确认可以供工作空间用户使用";
const privacyNotice = "连接和资源地址已替换成绑定位置。请检查名称、规则和 DNS 地址，不要公开私人信息。";

function responseFor(page: Page, path: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api${path}` && response.request().method() === "POST");
}
async function choose(page: Page, control: Locator, text: string) {
  await control.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
  await expect(search).toBeFocused();
  await search.fill(text);
  const option = page.getByRole("option");
  await expect(option).toHaveCount(1);
  await expect(option).toContainText(text);
  await search.press("Enter");
  await expect(control).toHaveAttribute("aria-expanded", "false");
}
async function capture(page: Page, info: TestInfo, name: string, surface: Locator) {
  // Observe normal toast removal and actual task motion; do not hide content,
  // disable animation or replace waiting with an arbitrary delay.
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await surface.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  const path = info.outputPath(`${name}.png`);
  // The spec is checked before any capture. All visible names/domains are
  // synthetic; no connection editor, access link or generated feed is opened.
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`shared template authoring publishes versions and preserves ordinary-user choices at ${width}px`, async ({ page, browser, baseURL }, info) => {
    requireLoopback(baseURL);
    const viewport = { width, height: width === 390 ? 844 : 1000 };
    await page.setViewportSize(viewport);
    const ownerContext = await browser.newContext({ baseURL, viewport, reducedMotion: "no-preference" });
    try {
      const owner = await ownerContext.newPage();
      const f = await templateAuthoringFixture(page.request, owner.request);
      expect(await f.read(page.request, "/templates")).toEqual([]);
      expect(await f.bindings()).toEqual([]);
      const modes = ["copy", "pinned", "follow"] as const;
      const drafts = new Map(await Promise.all(modes.map(async mode => [mode, await f.draft(mode)] as const)));
      const publications: { id: string; expectedVersion: number }[] = [];
      const selections: { version: number; mode: string; targetId: string; target: unknown; bindings: unknown }[] = [];
      const unexpectedWrites: string[] = [];
      for (const [actor, surface] of [["admin", page], ["owner", owner]] as const) {
        surface.on("request", request => {
          const path = new URL(request.url()).pathname;
          if (!path.startsWith("/api/") || ["GET", "HEAD"].includes(request.method())) return;
          if (actor === "admin" && path === "/api/admin/templates") {
            const body = request.postDataJSON();
            publications.push({ id: body.id, expectedVersion: body.expectedVersion });
          } else if (actor === "owner" && /^\/api\/me\/templates\/[^/]+\/select$/.test(path)) selections.push(request.postDataJSON());
          else if (!(actor === "admin" && path === "/api/admin/templates/sanitize")) unexpectedWrites.push(`${request.method()} ${path}`);
        });
      }
      await page.goto("/#templates");
      await page.getByRole("button", { name: "发布模板", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "发布共享模板", exact: true });
      await editor.getByRole("textbox", { name: "模板名称", exact: true }).fill(names.template);
      await choose(page, editor.getByRole("combobox", { name: "模板类型", exact: true }), "客户端配置模板");
      await choose(page, editor.getByRole("combobox", { name: "从自己的已保存配置提取", exact: true }), names.source);
      const extract = editor.getByRole("button", { name: "提取可共享结构", exact: true });
      const publishV1 = editor.getByRole("button", { name: "发布 v1", exact: true });
      await expect(publishV1).toBeDisabled();
      const extraction = responseFor(page, "/admin/templates/sanitize");
      await extract.click();
      expect((await extraction).status()).toBe(200);
      const shared = editor.getByRole("textbox", { name: "共享结构", exact: true });
      await expect(shared).toBeVisible();
      const v1 = f.parseSharedSpec(await shared.inputValue());
      expect(v1.rules[0].match.value).toBe("shared-v1.example.test");
      await expect(editor.getByText(privacyNotice, { exact: true })).toBeVisible();
      const reviewed = editor.getByRole("checkbox", { name: reviewLabel, exact: true });
      await expect(reviewed).not.toBeChecked();
      await expect(publishV1).toBeDisabled();

      // A canceled discard keeps the exact authored structure and selected source.
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      const discard = page.getByRole("alertdialog", { name: "放弃未发布的模板修改？", exact: true });
      await expect(discard.getByRole("button", { name: "继续编辑", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(discard).toHaveCount(0);
      expect(f.parseSharedSpec(await shared.inputValue())).toEqual(v1);
      await expect(editor.getByRole("textbox", { name: "模板名称", exact: true })).toHaveValue(names.template);
      await expect(editor.getByRole("combobox", { name: "从自己的已保存配置提取", exact: true })).toContainText(names.source);
      expect(publications).toEqual([]);

      // Editing invalidates approval. Invalid JSON is retained locally and never
      // becomes a version; a corrected structure needs its own review again.
      await reviewed.check();
      await shared.fill("{");
      await expect(reviewed).not.toBeChecked();
      await expect(publishV1).toBeDisabled();
      await reviewed.check();
      await publishV1.click();
      await expect(editor.getByText("模板结构不是有效的 JSON，请先修正。", { exact: true })).toBeVisible();
      await expect(shared).toHaveValue("{");
      expect(publications).toEqual([]);
      expect(await f.read(page.request, "/templates")).toEqual([]);
      await shared.fill(JSON.stringify(v1, null, 2));
      await expect(reviewed).not.toBeChecked();
      await reviewed.check();
      const firstPublication = responseFor(page, "/admin/templates");
      await publishV1.click();
      const first = await firstPublication;
      expect(first.status()).toBe(201);
      const template = await first.json();
      f.assertNoPrivateSource(template);
      f.assertSafeSpec(template.spec);
      expect(template).toMatchObject({ name: names.template, kind: "client-profile", version: 1, spec: v1 });
      await expect(editor).toHaveCount(0);
      expect(publications).toEqual([{ id: template.id, expectedVersion: 0 }]);

      // Create v2 in the same library item through the authoring controls. The
      // source is still v1; the new rule is authored in the shared structure.
      await page.reload();
      await page.getByRole("button", { name: "发布模板", exact: true }).click();
      await choose(page, editor.getByRole("combobox", { name: "发布位置", exact: true }), names.template);
      await expect(editor.getByRole("combobox", { name: "模板类型", exact: true })).toBeDisabled();
      await expect(editor.getByRole("textbox", { name: "模板名称", exact: true })).toHaveValue(names.template);
      const publishV2 = editor.getByRole("button", { name: "发布 v2", exact: true });
      await expect(publishV2).toBeDisabled();
      await choose(page, editor.getByRole("combobox", { name: "从自己的已保存配置提取", exact: true }), names.source);
      await page.route("**/api/admin/templates/sanitize", route => route.abort("failed"), { times: 1 });
      const interrupted = page.waitForEvent("requestfailed", { predicate: request => new URL(request.url()).pathname === "/api/admin/templates/sanitize" });
      await extract.click();
      await interrupted;
      await expect(editor.getByText("无法连接服务。请检查网络后重试，当前输入已保留。", { exact: true })).toBeVisible();
      await expect(editor.getByRole("combobox", { name: "发布位置", exact: true })).toContainText(names.template);
      await expect(editor.getByRole("combobox", { name: "从自己的已保存配置提取", exact: true })).toContainText(names.source);
      await expect(publishV2).toBeDisabled();
      await capture(page, info, `template-authoring-extraction-recovery-${width}`, editor);
      const retry = responseFor(page, "/admin/templates/sanitize");
      await extract.click();
      expect((await retry).status()).toBe(200);
      await expect(shared).toBeVisible();
      const v2 = f.parseSharedSpec(await shared.inputValue());
      v2.rules[0].match.value = "shared-v2.example.test";
      await reviewed.check();
      await shared.fill(JSON.stringify(v2, null, 2));
      await expect(reviewed).not.toBeChecked();
      await expect(publishV2).toBeDisabled();
      await expect(editor.getByText(privacyNotice, { exact: true })).toBeVisible();
      await reviewed.check();
      await publishV2.scrollIntoViewIfNeeded();
      await capture(page, info, `template-authoring-v2-decision-${width}`, editor);
      const secondPublication = responseFor(page, "/admin/templates");
      await publishV2.dblclick();
      expect((await secondPublication).status()).toBe(201);
      await expect(editor).toHaveCount(0);
      expect(publications).toEqual([{ id: template.id, expectedVersion: 0 }, { id: template.id, expectedVersion: 1 }]);
      const versions = await f.read(page.request, `/templates/${template.id}/versions`);
      for (const version of versions) f.assertSafeSpec(version.spec);
      expect(versions.map((version: { version: number }) => version.version)).toEqual([1, 2]);
      expect(versions[0].spec).toEqual(v1);
      expect(versions[1].spec).toEqual(v2);
      for (const mode of modes) expect(await f.draft(mode), "Publishing a template leaves personal drafts unchanged").toEqual(drafts.get(mode));

      // The ordinary user chooses versions and ownership semantics independently
      // for three existing drafts. The seeded subscriptions remain frozen.
      await owner.goto("/#templates");
      await expect(owner.getByRole("button", { name: "发布模板", exact: true })).toHaveCount(0);
      const card = owner.getByRole("article").filter({ has: owner.getByRole("heading", { name: names.template, exact: true }) });
      await expect(card.getByText("v2", { exact: true })).toBeVisible();
      const choices = [
        { mode: "copy", label: "独立副本", version: 1, consequence: "创建独立副本，后续由你单独维护。" },
        { mode: "pinned", label: "固定此版本", version: 1, consequence: "固定使用所选版本，后续由你决定是否更换版本。" },
        { mode: "follow", label: "跟随版本", version: 2, consequence: "有新版本时先查看差异与兼容性，再决定是否更新。" },
      ] as const;
      for (const choice of choices) {
        const before = await f.draft(choice.mode);
        await card.getByRole("button", { name: "查看并使用", exact: true }).click();
        const selection = owner.getByRole("dialog", { name: names.template, exact: true });
        const apply = selection.getByRole("button", { name: "应用模板到草稿", exact: true });
        await expect(apply).toBeDisabled();
        if (choice.version === 1) await choose(owner, selection.getByRole("combobox", { name: "模板版本", exact: true }), "v1");
        await choose(owner, selection.getByRole("combobox", { name: "模板目标", exact: true }), names[choice.mode]);
        await selection.getByRole("radio", { name: choice.label, exact: true }).check();
        await expect(selection.getByText(choice.consequence, { exact: true })).toBeVisible();
        await expect(apply).toBeDisabled();
        await choose(owner, selection.getByRole("combobox", { name: "Endpoint 1", exact: true }), "我的日常连接");
        await expect(selection.getByText("只更新选中的草稿", { exact: true })).toBeVisible();
        await expect(selection.getByText(/发布订阅仍需单独确认。/)).toBeVisible();
        await expect(apply).toBeEnabled();
        if (choice.mode === "copy") {
          await selection.getByRole("button", { name: "取消", exact: true }).click();
          const abandon = owner.getByRole("alertdialog", { name: "放弃未应用的模板选择？", exact: true });
          await abandon.getByRole("button", { name: "继续编辑", exact: true }).click();
          await expect(abandon).toHaveCount(0);
          expect(await f.draft(choice.mode)).toEqual(before);
          expect(await f.bindings()).toEqual([]);
          expect(selections).toEqual([]);
          await expect(selection.getByRole("combobox", { name: "模板版本", exact: true })).toContainText("v1");
          await expect(selection.getByRole("combobox", { name: "Endpoint 1", exact: true })).toContainText("我的日常连接");
        }
        await apply.scrollIntoViewIfNeeded();
        await capture(owner, info, `template-user-${choice.mode}-decision-${width}`, selection);
        const accepted = responseFor(owner, `/me/templates/${template.id}/select`);
        await apply.click();
        expect((await accepted).status()).toBe(200);
        await expect(selection).toHaveCount(0);
        f.assertNoPrivateSource(selections.at(-1));
        expect(selections.at(-1)).toEqual({ version: choice.version, mode: choice.mode, targetId: choice.mode, target: authoringTarget, bindings: { endpoints: { "endpoint-1": "personal-exit" }, resources: {} } });
        const after = await f.draft(choice.mode);
        expect(after.ir.endpoints).toEqual(before.ir.endpoints);
        expect(after.ir.runtime.mixedPort).toBe(7891);
        expect(after.ir.rules).toEqual([{ id: "browser", match: { op: "domain-suffix", value: `shared-v${choice.version}.example.test` }, action: { kind: "endpoint", ref: "personal-exit" } }]);
        drafts.set(choice.mode, after);
        for (const other of modes) if (other !== choice.mode) expect(await f.draft(other), "Applying a template changes only the chosen draft").toEqual(drafts.get(other));
        const binding = (await f.bindings()).find((item: { targetId: string }) => item.targetId === choice.mode);
        expect(binding).toMatchObject({ templateId: template.id, targetId: choice.mode, mode: choice.mode, appliedVersion: choice.version });
      }
      await f.unchangedDeliveries();
      await owner.reload();
      await owner.getByRole("tab", { name: "我的引用", exact: true }).click();
      const row = (name: string) => owner.getByRole("row").filter({ hasText: name });
      await expect(row(names.copy)).toContainText("独立维护");
      await expect(row(names.copy).getByRole("button")).toHaveCount(0);
      await expect(row(names.pinned).getByRole("button", { name: `查看固定版本 ${names.pinned}`, exact: true })).toBeVisible();
      await expect(row(names.follow).getByRole("button", { name: `检查更新 ${names.follow}`, exact: true })).toBeVisible();
      expect(await f.bindings()).toHaveLength(3);
      expect(selections).toHaveLength(3);
      expect(unexpectedWrites).toEqual([]);
      await f.unchangedDeliveries();
      await info.attach("template-authoring-proof", { contentType: "application/json", body: JSON.stringify({ viewport, authoring: "real UI extraction, retained/reviewed JSON and version publication", versions: [1, 2], choices: choices.map(({ mode, version }) => ({ mode, version })), deliveriesUnchanged: 3, unexpectedWrites: 0, bounds: "Synthetic setup; no native parser, client loading, managed application or live operation." }) });
    } finally {
      await ownerContext.close();
    }
  });
}
