import { test, expect } from "./isolated-control-plane-fixture";
import {
  initialPassword,
  requireLoopback,
  signInAPI,
} from "./account-security-backend";
import {
  assertCycleWindow,
  cycleFixture,
  cycleModes,
} from "./cycle-renewal-backend";

test.use({ trace: "off", screenshot: "off", video: "off" });
for (const [mode, label] of cycleModes)
  test(`real ${mode} cycle editor, renewal, explicit reset and user countdown`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    requireLoopback(baseURL);
    const recipient = await playwright.request.newContext({ baseURL });
    try {
      const f = await cycleFixture(page.request, recipient, mode);
      await page.goto("/#users");
      const editor = page.getByRole("dialog", {
        name: `${f.account.name} · 服务授权`,
        exact: true,
      });
      const open = async () => {
        await page
          .getByRole("button", {
            name: `更多操作 ${f.account.name}`,
            exact: true,
          })
          .click();
        await page
          .getByRole("menuitem", { name: "授权与续期", exact: true })
          .click();
        await expect(
          editor.getByRole("button", { name: "预览影响", exact: true }),
        ).toBeVisible();
      };
      const apply = async () => {
        await editor
          .getByRole("button", { name: "预览影响", exact: true })
          .click();
        const review = page.getByRole("dialog", {
          name: "确认授权变更",
          exact: true,
        });
        await expect(review).toBeVisible();
        await review
          .getByRole("checkbox", { name: "我已核对本次授权变更", exact: true })
          .check();
        const applied = page.waitForResponse(
          (r) =>
            r.url().endsWith("/access-policy/apply") &&
            r.request().method() === "POST",
        );
        await review
          .getByRole("button", { name: "更新授权", exact: true })
          .click();
        expect((await applied).status()).toBe(200);
        await expect(editor).toHaveCount(0);
      };
      await open();
      await editor
        .getByRole("button", { name: "高级：账号流量周期", exact: true })
        .click();
      await editor
        .getByRole("combobox", { name: "流量重置规则", exact: true })
        .click();
      await page.getByRole("option", { name: label, exact: true }).click();
      if (mode === "monthly")
        await editor.getByLabel("每月几号", { exact: true }).fill("31");
      if (mode === "fixed-days")
        await editor.getByLabel("每周期天数", { exact: true }).fill("7");
      await apply();
      const selected = await f.overview();
      assertCycleWindow(selected, mode);
      const anchor = selected.entitlement.cycle.anchor;
      const nextReset = selected.cycle.nextReset;
      await f.seedUsage();
      await open();
      await editor
        .getByLabel("到期时间（留空为不过期）", { exact: true })
        .click();
      const calendar = page.getByLabel("选择日期与时间", { exact: true });
      await calendar
        .getByLabel("时间（UTC+8）", { exact: true })
        .fill("23:59:00");
      await calendar.getByRole("button", { name: "确定", exact: true }).click();
      await apply();
      const renewed = await f.overview();
      expect(Date.parse(renewed.entitlement.expiresAt)).toBeGreaterThan(
        Date.parse(selected.entitlement.expiresAt),
      );
      expect(renewed.usage.weightedBytes).toBe(150);
      expect(renewed.entitlement.cycle.anchor).toBe(anchor);
      expect(renewed.cycle.nextReset).toBe(nextReset);
      await open();
      await editor
        .getByRole("textbox", { name: "重置原因", exact: true })
        .fill("Synthetic cycle acceptance");
      await editor
        .getByRole("button", { name: "重置本周期用量", exact: true })
        .click();
      const confirmation = page.getByRole("alertdialog", {
        name: `重置「${f.account.name}」的本周期用量？`,
        exact: true,
      });
      await confirmation
        .getByRole("button", { name: "取消", exact: true })
        .click();
      expect((await f.overview()).usage.weightedBytes).toBe(150);
      await editor
        .getByRole("button", { name: "重置本周期用量", exact: true })
        .click();
      const reset = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/users/${f.account.id}/reset`) &&
          r.request().method() === "POST",
      );
      await confirmation
        .getByRole("button", { name: "确认重置", exact: true })
        .click();
      expect((await reset).status()).toBe(200);
      const cleared = await f.overview();
      expect(cleared.usage.weightedBytes).toBe(0);
      expect(cleared.entitlement.cycle.anchor).toBe(anchor);
      expect(cleared.cycle.nextReset).toBe(nextReset);
      await f.verifyReplayAndAudit();
      // New normal login + full page reload uses the real invited user's own view.
      await signInAPI(page.request, f.account.username, initialPassword);
      await page.goto("/#subscriptions");
      await page.reload();
      await page
        .getByRole("button", { name: "用量与周期明细", exact: true })
        .click();
      await expect(
        page.getByText("UTC+8", { exact: true }).first(),
      ).toBeVisible();
      if (mode === "none")
        await expect(
          page.getByText("不自动重置", { exact: true }),
        ).toBeVisible();
      else await expect(page.getByText(/（还有 .+）/)).toBeVisible();
      expect(
        (await (await page.request.get("/api/me/overview")).json()).usage
          .weightedBytes,
      ).toBe(0);
    } finally {
      await recipient.dispose();
    }
  });
