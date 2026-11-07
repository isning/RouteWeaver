import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { demoPassword, requireLoopback, signInAPI } from "./account-security-backend";
import { originPath, originState, sameEffective } from "./settings-origin-backend";
import { settledTask } from "./ui-settled-task";

// Every accepted read/write uses a fresh normal CLI and its real authenticated
// HTTP API. The only fault aborts an origin GET. Reserved .example addresses are
// saved as inert strings: no verification probe, DNS, TLS or external operation.
// Security is a local form-dismissal check, never MFA setup/enable or a real account.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

async function visibleControl(control: Locator) {
  await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight &&
      (hit === element || element.contains(hit));
  })).toBe(true);
}

async function capture(page: Page, surface: Locator, info: TestInfo, name: string) {
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`settings-edit-journey-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(`settings-edit-journey-${name}`, { path, contentType: "image/png" });
}

// Native Tab may scroll the sequential short-height task. Never place focus on
// the target or move its scroll position to make a keyboard assertion pass.
async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 16; index++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 360 }]) {
  test(`real settings edit, read recovery, security return and reviewed completion at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize(viewport);
    await signInAPI(page.request, "routeweaver", demoPassword);
    const initialSettingsResponse = await page.request.get("/api/settings");
    expect(initialSettingsResponse.status()).toBe(200);
    const initialSettings = await initialSettingsResponse.json();
    const initialOrigin = await originState(page.request);
    const writes: string[] = [];
    const forbidden: string[] = [];
    let abortOriginRead = false;
    let abortedReads = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL!).origin) {
        forbidden.push("external request");
        return route.abort();
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        const operation = `${request.method()} ${url.pathname}`;
        if (!["PUT /api/settings", `PUT ${originPath}`, `POST ${originPath}/activate`].includes(operation)) {
          forbidden.push(operation);
          return route.abort();
        }
        writes.push(operation);
      }
      if (abortOriginRead && url.pathname === originPath && request.method() === "GET") {
        abortedReads++;
        return route.abort("failed");
      }
      return route.continue();
    });
    // Two genuine entries permit native Back cancellation and later Back/Forward.
    await page.goto("/#activity");
    await expect(page.getByRole("heading", { name: "变更记录", exact: true })).toBeVisible();
    if (viewport.width < 1024)
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
    await page.getByRole("navigation", { name: "工作空间导航", exact: true })
      .getByRole("button", { name: "平台设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "平台设置", exact: true })).toBeVisible();
    const basic = page.getByRole("tab", { name: "基本设置", exact: true });
    const security = page.getByRole("tab", { name: "账号安全", exact: true });
    const platform = page.getByRole("form", { name: "平台基本设置", exact: true });
    const edit = platform.getByRole("button", { name: "编辑平台名称", exact: true });
    const domain = page.getByLabel("订阅域名草稿", { exact: true });
    const originRegion = page.getByRole("region", { name: "订阅域名设置", exact: true });
    const suffix = `${viewport.width}x${viewport.height}`;
    const draftName = "协作平台验收";
    const draftOrigin = "https://settings-draft.example";
    await expect(domain).toBeVisible();
    await edit.click();
    const name = platform.getByRole("textbox", { name: "平台名称", exact: true });
    await expect(name).toBeFocused();
    await name.fill("");
    await page.keyboard.press("Tab");
    const saveName = platform.getByRole("button", { name: "保存设置", exact: true });
    await expect(saveName).toBeFocused();
    await page.keyboard.press("Enter");
    const nameError = platform.getByText("请填写平台名称", { exact: true });
    await expect(nameError).toBeVisible();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    expect(await name.getAttribute("aria-describedby")).toBe(await nameError.getAttribute("id"));
    expect(writes).toEqual([]);
    await visibleControl(saveName);
    await capture(page, platform, info, `empty-name-${suffix}`);
    await name.fill(draftName);
    await domain.fill(draftOrigin);

    await security.click();
    await expect(basic).toHaveAttribute("aria-selected", "false");
    await expect(name).toBeHidden();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    const password = page.getByLabel("验证当前账号密码", { exact: true });
    await password.fill("synthetic-never-submitted-password");
    await basic.click();
    await expect(name).toHaveValue(draftName);
    await expect(domain).toHaveValue(draftOrigin);
    await security.click();
    await expect(password).toHaveValue("");
    await password.click();
    await visibleControl(password);
    await capture(page, page.getByRole("tabpanel", { name: "账号安全", exact: true }), info, `security-return-${suffix}`);
    await basic.click();
    await expect(name).toHaveValue(draftName);
    await expect(domain).toHaveValue(draftOrigin);

    await page.goBack();
    const leave = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    await expect(leave).toBeVisible();
    await expect(leave).toContainText("离开会放弃尚未保存的内容");
    const stay = leave.getByRole("button", { name: "继续编辑", exact: true });
    await expect(stay).toBeFocused();
    await visibleControl(stay);
    await capture(page, leave, info, `keep-drafts-${suffix}`);
    await page.keyboard.press("Enter");
    await expect(leave).toBeHidden();
    await expect(page).toHaveURL(/#settings$/);
    await expect(name).toHaveValue(draftName);
    await expect(domain).toHaveValue(draftOrigin);
    expect(writes).toEqual([]);

    // Name cancellation affects only that field, then a new explicit edit saves.
    await platform.getByRole("button", { name: "取消名称修改", exact: true }).click();
    await expect(edit).toBeFocused();
    await expect(platform).toContainText(initialSettings.name);
    await expect(domain).toHaveValue(draftOrigin);
    await edit.press("Enter");
    await expect(name).toHaveValue(initialSettings.name);
    await name.fill(draftName);
    const nameSaved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/settings" && response.request().method() === "PUT");
    await saveName.click();
    const nameReceipt = await nameSaved;
    expect(nameReceipt.status()).toBe(200);
    expect(nameReceipt.request().postDataJSON()).toEqual({ ...initialSettings, name: draftName });
    await expect(name).toBeHidden();
    await expect(edit).toBeFocused();
    await expect(platform).toContainText(draftName);
    expect(await (await page.request.get("/api/settings")).json()).toEqual({ ...initialSettings, name: draftName });
    await expect(domain).toHaveValue(draftOrigin);
    expect(await originState(page.request)).toEqual(initialOrigin);
    await capture(page, platform, info, `name-saved-${suffix}`);

    const saveDraft = page.getByRole("button", { name: "保存域名草稿", exact: true });
    const enableDraft = page.getByRole("button", { name: "启用已保存草稿", exact: true });
    const submitDraft = async () => {
      const response = page.waitForResponse((value) =>
        new URL(value.url()).pathname === originPath && value.request().method() === "PUT");
      await saveDraft.click();
      const result = await response;
      expect(result.status()).toBe(200);
      return result.json();
    };
    const staged = await submitDraft();
    sameEffective(staged, initialOrigin);
    expect(staged.draftOrigin).toBe(draftOrigin);
    await expect(page.getByText("尚未验证草稿", { exact: true })).toBeVisible();
    await expect(enableDraft).toBeDisabled();
    await enableDraft.scrollIntoViewIfNeeded();
    await capture(page, originRegion, info, `saved-not-active-${suffix}`);

    // Abort only background GETs, never synthesize a successful API response.
    const retainedOrigin = "https://retained-settings.example";
    await domain.fill(retainedOrigin);
    abortOriginRead = true;
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    const retry = originRegion.getByRole("button", { name: "重新读取设置", exact: true });
    await expect(retry).toBeVisible();
    await expect(domain).toHaveValue(retainedOrigin);
    await expect(domain).toBeDisabled();
    await expect(saveDraft).toBeDisabled();
    await expect(enableDraft).toBeDisabled();
    expect(abortedReads).toBeGreaterThan(0);
    expect(await originState(page.request)).toEqual(staged);
    await retry.scrollIntoViewIfNeeded();
    await capture(page, originRegion, info, `read-failure-${suffix}`);
    abortOriginRead = false;
    await retry.click();
    await expect(domain).toBeEnabled();
    await expect(domain).toHaveValue(retainedOrigin);
    await expect(retry).toHaveCount(0);

    // Default-origin activation is the only safe local activation. The custom
    // draft was never probed; it is replaced with the existing default address.
    await domain.fill("");
    const pending = await submitDraft();
    sameEffective(pending, initialOrigin);
    await expect(enableDraft).toBeEnabled();
    await enableDraft.click();
    const review = page.getByRole("dialog", { name: "启用订阅地址", exact: true });
    await expect(review).toBeVisible();
    await expect(review).toContainText("保留当前订阅令牌");
    await expect(review).toContainText("不会自动跳转");
    const consent = review.getByRole("checkbox", { name: "我已确认域名配置与旧链接的访问安排", exact: true });
    const activate = review.getByRole("button", { name: "确认启用", exact: true });
    await expect(activate).toBeDisabled();
    await capture(page, review, info, `activation-identity-${suffix}`);
    await tabTo(page, consent);
    await visibleControl(consent);
    await page.keyboard.press("Space");
    await expect(consent).toBeChecked();
    await capture(page, review, info, `activation-consent-${suffix}`);
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await expect(enableDraft).toBeFocused();
    expect(await originState(page.request)).toEqual(pending);
    expect(writes.filter((operation) => operation.endsWith("/activate"))).toEqual([]);

    await enableDraft.press("Enter");
    await expect(review).toBeVisible();
    await expect(consent).not.toBeChecked();
    await tabTo(page, consent);
    await page.keyboard.press("Space");
    await tabTo(page, activate);
    await visibleControl(activate);
    await capture(page, review, info, `activation-decision-${suffix}`);
    const activated = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `${originPath}/activate` && response.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await activated).status()).toBe(200);
    await expect(review).toBeHidden();
    await expect(enableDraft).toBeDisabled();
    const effective = await originState(page.request);
    expect(effective.effectiveRevision).toBe(pending.configuredRevision);
    expect(effective.effectiveOrigin).toBe("");
    expect(effective.currentLinkExample).toBe(initialOrigin.currentLinkExample);
    expect(effective.tokensUnchanged).toBe(true);
    await expect(originRegion.getByText("待启用", { exact: true })).toHaveCount(0);
    await enableDraft.scrollIntoViewIfNeeded();
    await capture(page, originRegion, info, `activation-complete-${suffix}`);

    await page.goBack();
    await expect(page.getByRole("heading", { name: "变更记录", exact: true })).toBeVisible();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole("heading", { name: "平台设置", exact: true })).toBeVisible();
    await expect(platform).toContainText(draftName);
    await expect(domain).toHaveValue("");
    await expect(enableDraft).toBeDisabled();
    await security.click();
    await expect(password).toHaveValue("");
    const sessionResponse = await page.request.get("/api/auth/me");
    expect(sessionResponse.status()).toBe(200);
    expect((await sessionResponse.json()).user.mfaEnabled).toBe(false);
    expect(forbidden).toEqual([]);
    expect(writes).toEqual([
      "PUT /api/settings", `PUT ${originPath}`, `PUT ${originPath}`, `POST ${originPath}/activate`,
    ]);
    const proof = {
      viewport, writes, abortedReads, forbidden,
      nameSaved: true, nameCancelPreservesDomain: true,
      securityPasswordClearedOnReturn: true, mfaEnabled: false,
      draftsPreservedAcrossTabsAndCancelledBack: true,
      readFailureRetainedUnsavedDomain: true,
      activationCancelHadNoWrite: true, activationReopenRequiredFreshConsent: true,
      persistedDefaultOrigin: effective.effectiveOrigin,
      configuredRevision: effective.configuredRevision,
      effectiveRevision: effective.effectiveRevision,
      tokensUnchanged: effective.tokensUnchanged,
      backForwardRetainedAcceptedSettings: true,
      limits: "Synthetic isolated backend only; no custom-origin HTTPS probe, DNS/TLS change, external operation or MFA enrollment.",
    };
    await writeFile(info.outputPath(`settings-edit-journey-proof-${suffix}.json`), `${JSON.stringify(proof, null, 2)}\n`);
  });
}
