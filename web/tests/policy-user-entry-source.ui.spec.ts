import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { headers, inviteOwner, names, read, seedInfrastructure, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Real isolated HTTP + normal authentication + actual managed-principal
// provisioning. No API mocks, direct DB writes, node apply, native traffic or
// real credentials. The test creates only synthetic local fixture credentials.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const id = "uiux-inventory";

async function create(client: APIRequestContext, path: string, data: unknown) {
  const response = await client.post(`/api${path}`, { headers: await headers(client), data });
  expect(response.ok(), `Create synthetic fixture ${path}`).toBe(true);
  return response.json();
}
async function capture(page: Page, info: TestInfo, dialog: Locator, name: string) {
  await settledTask(dialog);
  expect(await page.getByRole("dialog").count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const path = info.outputPath(`${name}-${page.viewportSize()!.width}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}
async function jsonDraft(page: Page, editor: Locator) {
  await editor.getByRole("button", { name: "编辑转发设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "服务端配置意图", exact: true });
  const field = dialog.getByRole("textbox", { name: "服务端配置意图 JSON 文本", exact: true });
  return { dialog, field, value: JSON.parse(await field.inputValue()) };
}

async function finishJSONTask(page: Page, dialog: Locator, action: "应用到草稿" | "取消") {
  // Capture this exact Radix content identity before dismissal. Its accessible
  // name/visibility may change during exit, but the DOM scope still exists.
  const scopeId = await dialog.getAttribute("id");
  expect(scopeId).toBeTruthy();
  const scope = page.locator(`[id=${JSON.stringify(scopeId)}]`);
  await dialog.getByRole("button", { name: action, exact: true }).click();
  await expect(scope).toHaveCount(0);
}

for (const width of [1440, 390]) {
  test(`source management preserves draft and cannot revive rotated credentials at ${width}px`, async ({ page, browser, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    // Invitation bootstrap logs its admin API client in. Keep those cookies
    // separate so the page below genuinely exercises the login form.
    const setupAdmin = await browser.newContext({ baseURL });
    const owner = await browser.newContext({ baseURL });
    let accountId: string;
    try { accountId = await inviteOwner(setupAdmin.request, owner.request); }
    finally { await owner.close(); await setupAdmin.close(); }
    await signIn(page, baseURL, "admin");
    await seedInfrastructure(page.request, true);
    await create(page.request, "/services", {
      id: "source-plan", name: "Synthetic source service", routeIds: [id], quotaBytes: 1048576,
      cycle: { mode: "none", timezone: "UTC+8" },
    });
    const entitlement = await page.request.put(`/api/users/${accountId}/entitlement`, {
      headers: await headers(page.request),
      data: { serviceId: "source-plan", cycle: { mode: "none", timezone: "UTC+8" } },
    });
    expect(entitlement.status()).toBe(200);
    await create(page.request, `/published-routes/${id}/principals`, {
      accountId, entryId: "source-entry", credentialVersion: "source-v1",
    });
    const state = await read(page.request, "/state");
    // /state is legacy inventory, not the published-route authority. The source
    // task must resolve the actual published route without this invented field.
    expect(Object.hasOwn(state, "publishedRoutes")).toBe(false);
    const account = state.users.find((user: { id: string }) => user.id === accountId);
    expect(!!account).toBe(true);
    const summaries = await read(page.request, `/users/${accountId}/entries`);
    // Deliberate real DTO assertion: the prior mock invented userId and hid a
    // production blocker. Owner comes from this authenticated collection URL.
    expect(summaries).toHaveLength(1);
    expect(Object.hasOwn(summaries[0], "userId")).toBe(false);
    expect(summaries[0]).toMatchObject({ id: "source-entry", publishedRouteId: id, deploymentId: id, credentialVersion: "source-v1" });
    const before = await read(page.request, `/server-deployments/${id}/reveal`);
    const oldPrincipal = before.ir.programs[0].principals[0];
    const mutations: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) mutations.push(`${request.method()} ${path}`);
    });
    await page.goto("/#routes");
    const edit = page.getByRole("button", { name: `编辑转发路径 ${names.deployment}`, exact: true });
    await edit.click();
    const editor = page.getByRole("dialog", { name: `编辑 ${names.deployment}`, exact: true });
    await editor.getByRole("textbox", { name: "转发路径名称", exact: true }).fill("Keep my unsaved source draft");
    // Keep a future/unknown program field entirely client-side to detect lossy
    // replacement while visiting source management. Never submit unknown IR.
    const raw = await jsonDraft(page, editor);
    raw.value.programs[0].futureSourceSetting = { raw: " 007 ", enabled: false };
    await raw.field.fill(JSON.stringify(raw.value, null, 2));
    await finishJSONTask(page, raw.dialog, "应用到草稿");
    const sourceTrigger = editor.getByRole("button", { name: `核对入口来源 ${names.listener} 用户入口 1`, exact: true });
    await sourceTrigger.click();
    let source = page.getByRole("dialog", { name: "核对用户入口", exact: true });
    await expect(source.getByRole("button", { name: "管理此账号的入口", exact: true })).toBeEnabled();
    await capture(page, info, source, "verified-principal-source");
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(sourceTrigger).toBeFocused();
    await expect(editor.getByRole("textbox", { name: "转发路径名称", exact: true })).toHaveValue("Keep my unsaved source draft");
    expect(mutations).toEqual([]);

    await sourceTrigger.click();
    source = page.getByRole("dialog", { name: "核对用户入口", exact: true });
    await source.getByRole("button", { name: "管理此账号的入口", exact: true }).click();
    const entries = page.getByRole("dialog", { name: `${account.name} 的平台入口`, exact: true });
    const row = entries.getByRole("listitem", { name: names.line, exact: true });
    await expect(row).toBeVisible();
    await capture(page, info, entries, "source-entry-management");
    await row.getByRole("button", { name: "轮换凭据", exact: true }).click();
    let rotation = page.getByRole("alertdialog", { name: "轮换此用户的入口凭据？", exact: true });
    await rotation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    expect(mutations).toEqual([]);
    await row.getByRole("button", { name: "轮换凭据", exact: true }).click();
    rotation = page.getByRole("alertdialog", { name: "轮换此用户的入口凭据？", exact: true });
    const rotated = page.waitForResponse(response => response.url().endsWith(`/api/published-routes/${id}/principals`) && response.request().method() === "POST");
    await rotation.getByRole("button", { name: "准备新凭据", exact: true }).click();
    expect((await rotated).status()).toBe(201);
    await expect(page.getByText("新凭据已准备", { exact: true })).toBeVisible();
    // The mutation/toast can finish while the confirmation's exit scope still
    // owns Escape. Wait for real removal, including hidden closing content,
    // before sending a distinct dismissal to the returned entry task.
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await settledTask(entries);
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(sourceTrigger).toBeFocused();
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await expect(editor.getByRole("textbox", { name: "转发路径名称", exact: true })).toHaveValue("Keep my unsaved source draft");
    const retained = await jsonDraft(page, editor);
    expect(retained.value.programs[0].futureSourceSetting).toEqual({ raw: " 007 ", enabled: false });
    expect(retained.value.programs[0].principals[0].credentialVersion).toBe("source-v1");
    await finishJSONTask(page, retained.dialog, "取消");
    const latest = await read(page.request, `/server-deployments/${id}/reveal`);
    const newPrincipal = latest.ir.programs[0].principals[0];
    expect(latest.revisionToken !== before.revisionToken).toBe(true);
    expect(newPrincipal.credentialVersion !== oldPrincipal.credentialVersion).toBe(true);
    expect(newPrincipal.credential.uuid !== oldPrincipal.credential.uuid).toBe(true);
    expect(newPrincipal.subjectId !== oldPrincipal.subjectId).toBe(true);
    expect(latest.name).toBe(names.deployment);
    expect(latest.ir.programs[0].futureSourceSetting).toBeUndefined();
    expect(mutations).toEqual([`POST /api/published-routes/${id}/principals`]);
    await capture(page, info, editor, "stale-policy-save-fenced");
    // Keep the original return-state evidence, then capture the recovery UI
    // itself after the real success toast exits. No hidden DOM removal or sleep.
    const recoveryWarning = editor.getByText("用户入口可能已更新", { exact: true });
    const recoveryAction = editor.getByRole("button", { name: "重新读取路径", exact: true });
    const fencedSave = editor.getByRole("button", { name: "保存草稿", exact: true });
    await recoveryWarning.scrollIntoViewIfNeeded();
    await recoveryAction.scrollIntoViewIfNeeded();
    // Move off the former JSON footer/toast area so hover cannot pause dismissal.
    await recoveryAction.hover();
    await expect(page.getByText("新凭据已准备", { exact: true })).toHaveCount(0);
    await settledTask(editor);
    await expect(fencedSave).toBeDisabled();
    for (const control of [recoveryWarning, recoveryAction, fencedSave]) {
      await expect(control).toBeVisible();
      expect(await control.evaluate(element => {
        const r = element.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }), "Recovery warning, action and disabled save fit the actual viewport").toBe(true);
    }
    // Test the actionable CTA at its center and inset corners, not just its
    // bounding box. The disabled save is checked geometrically above because
    // disabled controls may intentionally have pointer-events:none.
    expect(await recoveryAction.evaluate(element => {
      const r = element.getBoundingClientRect();
      return [[r.left + 10, r.top + 10], [r.right - 10, r.top + 10],
        [r.left + 10, r.bottom - 10], [r.right - 10, r.bottom - 10],
        [r.left + r.width / 2, r.top + r.height / 2]].every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || (!!hit && element.contains(hit));
      });
    }), "Recovery action is unobscured").toBe(true);
    await capture(page, info, editor, "stale-policy-recovery-settled");
    await editor.getByRole("button", { name: "重新读取路径", exact: true }).click();
    let recovery = page.getByRole("alertdialog", { name: "重新读取并放弃当前草稿？", exact: true });
    await recovery.getByRole("button", { name: "保留草稿", exact: true }).click();
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await expect(editor.getByRole("textbox", { name: "转发路径名称", exact: true })).toHaveValue("Keep my unsaved source draft");
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "重新读取路径", exact: true }).click();
    recovery = page.getByRole("alertdialog", { name: "重新读取并放弃当前草稿？", exact: true });
    await recovery.getByRole("button", { name: "重新读取路径", exact: true }).click();
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await expect(editor).toBeHidden();
    await edit.click();
    await expect(editor.getByRole("textbox", { name: "转发路径名称", exact: true })).toHaveValue(names.deployment);
    const fresh = await jsonDraft(page, editor);
    expect(fresh.value.programs[0].principals[0].credentialVersion === newPrincipal.credentialVersion).toBe(true);
    expect(fresh.value.programs[0].principals[0].credential.uuid === newPrincipal.credential.uuid).toBe(true);
    expect(fresh.value.programs[0].principals.some((principal: { credentialVersion: string }) => principal.credentialVersion === "source-v1")).toBe(false);
    expect(fresh.value.programs[0].futureSourceSetting).toBeUndefined();
    await finishJSONTask(page, fresh.dialog, "取消");
    // Stop-delivery uses the same source workflow but does not rewrite the
    // deployment. It still conservatively fences the captured editor draft.
    await sourceTrigger.click();
    source = page.getByRole("dialog", { name: "核对用户入口", exact: true });
    await source.getByRole("button", { name: "管理此账号的入口", exact: true }).click();
    await row.getByRole("button", { name: "停止交付", exact: true }).click();
    const stop = page.getByRole("alertdialog", { name: `停止交付「${names.line}」？`, exact: true });
    const stopped = page.waitForResponse(response => response.url().endsWith(`/api/users/${accountId}/entries/source-entry`) && response.request().method() === "DELETE");
    await stop.getByRole("button", { name: "停止交付", exact: true }).click();
    expect((await stopped).status()).toBe(200);
    await expect(row.getByText("已撤销", { exact: true })).toBeVisible();
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await settledTask(entries);
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(sourceTrigger).toBeFocused();
    await expect(editor.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    const revoked = await read(page.request, `/users/${accountId}/entries`);
    expect(revoked[0]).toMatchObject({ id: "source-entry", revoked: true, credentialVersion: newPrincipal.credentialVersion });
    const afterRevoke = await read(page.request, `/server-deployments/${id}/reveal`);
    expect(afterRevoke.revisionToken === latest.revisionToken).toBe(true);
    expect(afterRevoke.ir.programs[0].principals[0].credential.uuid === newPrincipal.credential.uuid).toBe(true);
    // No save, validate, apply or service command. The only mutations are the
    // two explicitly confirmed source operations in this isolated fixture.
    expect(mutations).toEqual([`POST /api/published-routes/${id}/principals`, `DELETE /api/users/${accountId}/entries/source-entry`]);
  });
}

