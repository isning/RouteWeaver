import type { Page } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import {
  demoPassword,
  requireLoopback,
  signInAPI,
} from "./account-security-backend";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import {
  originPath,
  originState,
  sameEffective,
  stageOrigin,
} from "./settings-origin-backend";

// Real normal CLI and real authenticated HTTP, without page.route/fulfilled APIs.
// Reserved .example domains are saved as strings only; no probe or DNS is run.
async function save(page: Page, status = 200) {
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === originPath &&
      r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存域名草稿", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(status);
  return result;
}
for (const width of [1440, 768, 390]) {
  test(`E13 real domain draft recovery and reviewed default activation at ${width}px`, async ({
    page,
    playwright,
    baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 900 });
    const mutations: { path: string; status: number }[] = [];
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith(originPath) && response.request().method() !== "GET")
        mutations.push({ path, status: response.status() });
    });
    const other = await playwright.request.newContext({ baseURL });
    try {
      const otherSession = await signInAPI(other, "routeweaver", demoPassword);
      await page.goto("/");
      await page.getByLabel("账号", { exact: true }).fill("routeweaver");
      await page.getByLabel("密码", { exact: true }).fill(demoPassword);
      await page
        .getByRole("button", { name: "进入工作空间", exact: true })
        .click();
      await waitForConfirmedWorkspace(page, "normal-ui-login");
      await page.goto("/#settings");
      const input = page.getByLabel("订阅域名草稿", { exact: true });
      await expect(input).toBeVisible();
      const initial = await originState(page.request);
      const currentLink = page
        .getByRole("region", { name: "订阅域名设置", exact: true })
        .getByRole("term")
        .filter({ hasText: /^当前链接示例$/ })
        .locator("xpath=following-sibling::dd");
      await expect(currentLink).toHaveCount(1);
      await expect(currentLink).toHaveText(initial.currentLinkExample);
      await input.fill("http://invalid.example/path");
      await save(page, 400);
      await expect(input).toHaveValue("http://invalid.example/path");
      expect(await originState(other)).toEqual(initial);
      await page.screenshot({ path: info.outputPath(`origin-real-invalid-${width}.png`), fullPage: true });

      await input.fill("https://draft.example");
      const staged = await (await save(page)).json();
      await expect(
        page.getByText("尚未验证草稿", { exact: true }),
      ).toBeVisible();
      const enable = page.getByRole("button", {
        name: "启用已保存草稿",
        exact: true,
      });
      await expect(enable).toBeDisabled();
      await page.screenshot({ path: info.outputPath(`origin-real-unverified-${width}.png`), fullPage: true });
      sameEffective(await originState(other), initial);
      await expect(currentLink).toHaveText(initial.currentLinkExample);
      expect(
        (
          await other.post(`${originPath}/activate`, {
            headers: { "X-CSRF-Token": otherSession.csrfToken },
            data: { expectedRevision: staged.revision },
          })
        ).status(),
      ).toBe(409);
      expect(await originState(other)).toEqual(staged);

      await input.fill("https://retained.example");
      const concurrent = await (
        await stageOrigin(
          other,
          otherSession.csrfToken,
          "https://concurrent.example",
          staged.revision,
        )
      ).json();
      const refresh = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === originPath &&
          r.request().method() === "GET",
      );
      await save(page, 409);
      expect((await refresh).status()).toBe(200);
      await expect(input).toHaveValue("https://retained.example");
      await expect(
        page.getByText("https://concurrent.example/feed/{existing-token}", {
          exact: true,
        }),
      ).toBeVisible();
      expect(await originState(other)).toEqual(concurrent);
      const recovered = await (await save(page)).json();
      expect(recovered.draftOrigin).toBe("https://retained.example");
      sameEffective(recovered, initial);

      await input.fill("");
      const pending = await (await save(page)).json();
      await expect(
        page.getByText("默认地址无需验证", { exact: true }),
      ).toBeVisible();
      expect(pending.configuredRevision).not.toBe(pending.effectiveRevision);
      sameEffective(pending, initial);
      await enable.click();
      const dialog = page.getByRole("dialog", {
        name: "启用订阅地址",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: info.outputPath(`origin-real-default-review-${width}.png`) });
      await expect(
        dialog.getByRole("button", { name: "确认启用", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(enable).toBeFocused();
      expect(await originState(other)).toEqual(pending);

      await enable.press("Enter");
      await expect(dialog).toBeVisible();
      const replacement = await (
        await stageOrigin(
          other,
          otherSession.csrfToken,
          "https://replacement.example",
          pending.revision,
        )
      ).json();
      const refreshed = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === originPath &&
          r.request().method() === "GET",
      );
      const conflict = page.waitForResponse(
        (r) => new URL(r.url()).pathname === `${originPath}/activate`,
      );
      await dialog
        .getByRole("checkbox", {
          name: "我已确认域名配置与旧链接的访问安排",
          exact: true,
        })
        .check();
      await dialog
        .getByRole("button", { name: "确认启用", exact: true })
        .click();
      expect((await conflict).status()).toBe(409);
      expect((await refreshed).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(input).toHaveValue("");
      await expect(
        page.getByText("https://replacement.example/feed/{existing-token}", {
          exact: true,
        }),
      ).toBeVisible();
      expect(await originState(other)).toEqual(replacement);
      sameEffective(replacement, initial);
      await expect(currentLink).toHaveText(initial.currentLinkExample);

      const reviewed = await (await save(page)).json();
      await expect(enable).toBeEnabled();
      await enable.press("Enter");
      await expect(dialog).toBeVisible();
      const checkbox = dialog.getByRole("checkbox", {
        name: "我已确认域名配置与旧链接的访问安排",
        exact: true,
      });
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      const activation = page.waitForResponse(
        (r) => new URL(r.url()).pathname === `${originPath}/activate`,
      );
      await dialog
        .getByRole("button", { name: "确认启用", exact: true })
        .press("Enter");
      expect((await activation).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(enable).toBeDisabled();
      const effective = await originState(other);
      expect(effective.effectiveRevision).toBe(reviewed.configuredRevision);
      expect(effective.effectiveOrigin).toBe("");
      expect(effective.currentLinkExample).toBe(initial.currentLinkExample);
      expect(effective.tokensUnchanged).toBe(true);
      await expect(currentLink).toHaveText(effective.currentLinkExample);
      await page.reload();
      await expect(input).toHaveValue("");
      await expect(enable).toBeDisabled();
      expect(await originState(other)).toEqual(effective);
      await page.screenshot({ path: info.outputPath(`origin-real-default-active-${width}.png`), fullPage: true });
      expect(mutations).toEqual([
        { path: originPath, status: 400 },
        { path: originPath, status: 200 },
        { path: originPath, status: 409 },
        { path: originPath, status: 200 },
        { path: originPath, status: 200 },
        { path: `${originPath}/activate`, status: 409 },
        { path: originPath, status: 200 },
        { path: `${originPath}/activate`, status: 200 },
      ]);
    } finally {
      await other.dispose();
    }
  });
}
