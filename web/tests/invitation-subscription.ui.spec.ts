import { randomUUID } from "node:crypto";
import { type Page, type Locator, type TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { demoPassword, requireLoopback } from "./account-security-backend";
import {
  invitationSourceFixture,
  invitationServiceName,
  invitationRouteName,
  invitationEntryName,
  invitationPassword,
  readOnboarding,
  readInvitationFeed,
} from "./invitation-subscription-backend";

test.use({ trace: "off", screenshot: "off", video: "off" });
async function capture(
  page: Page,
  info: TestInfo,
  name: string,
  masks: Locator[] = [],
) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({
    path,
    animations: "disabled",
    mask: [page.locator('input[type="password"]'), ...masks],
  });
  await info.attach(name, { path, contentType: "image/png" });
}
async function activateByKeyboard(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let index = 0; index < 80; index++) {
    if (
      await target.evaluate((element) => element === document.activeElement)
    ) {
      await expect(target).toBeInViewport();
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Onboarding action is not keyboard reachable");
}
async function login(page: Page, username: string, password: string) {
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/auth/login" &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  expect((await response).status()).toBe(200);
}
async function logout(page: Page, narrow: boolean) {
  let scope = page.locator("#workspace-navigation");
  if (narrow) {
    // The preceding dialog may still be restoring the workspace's accessible
    // tree. A one-shot isVisible() can miss the trigger and skip opening the
    // mobile-only sidebar entirely; wait for the known viewport's UI instead.
    const navigation = page.getByRole("button", {
      name: "打开导航",
      exact: true,
    });
    await expect(navigation).toBeVisible();
    await navigation.click();
    scope = page.getByRole("dialog", { name: "导航", exact: true });
    await expect(scope).toBeVisible();
  }
  await scope.getByRole("button", { name: /(?:管理员|个人账号)$/ }).click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录 RouteWeaver", exact: true }),
  ).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`invitation to first subscription through real grant and publication at ${width}px`, async ({
    page: admin,
    browser,
    baseURL,
    playwright,
  }, info) => {
    requireLoopback(baseURL);
    const viewport = { width, height: width === 390 ? 844 : 1000 };
    await admin.setViewportSize(viewport);
    const recipientContext = await browser.newContext({ baseURL, viewport });
    const anonymous = await playwright.request.newContext({ baseURL });
    const recipient = await recipientContext.newPage();
    let signupRequests = 0;
    recipient.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/auth/accept-invite"
      )
        signupRequests++;
    });
    const name = "首次使用者";
    const username = `invited-${randomUUID()}`;
    const profileName = "我的首份分流";
    const outputName = "我的首份订阅";
    try {
      await admin.goto("/#users");
      await login(admin, "routeweaver", demoPassword);
      const source = await invitationSourceFixture(admin.request);
      const adminProfiles = await readOnboarding(admin.request, "/me/profiles");
      const adminOutputs = await readOnboarding(admin.request, "/me/outputs");
      await admin
        .getByRole("button", { name: "邀请用户", exact: true })
        .click();
      const invite = admin.getByRole("dialog", {
        name: "邀请用户",
        exact: true,
      });
      await invite.getByLabel("受邀人名称", { exact: true }).fill(name);
      await invite
        .getByRole("button", { name: "生成邀请", exact: true })
        .click();
      const inviteField = invite.getByLabel("邀请链接", { exact: true });
      await expect(inviteField).not.toHaveValue("");
      const invitation = await inviteField.inputValue();
      expect(new URL(invitation).origin === new URL(baseURL!).origin).toBe(
        true,
      );
      await capture(admin, info, `invitation-${width}`, [inviteField]);
      await admin.keyboard.press("Escape");
      // Navigate the real invitation URL without placing a bearer URL in a
      // Playwright goto step title/call log. Tracing remains disabled.
      await recipient.goto("/");
      await recipient.evaluate(
        (url) => window.location.assign(url),
        invitation,
      );
      const tokenField = recipient.getByLabel("邀请码", { exact: true });
      const token = await tokenField.inputValue();
      expect(
        token.length > 0,
        "Invitation route populated the signup form",
      ).toBe(true);
      await recipient.getByLabel("账号", { exact: true }).fill("bad/name");
      await recipient.getByLabel("密码", { exact: true }).fill("short");
      await recipient
        .getByRole("button", { name: "创建账号并继续", exact: true })
        .click();
      await expect(
        recipient.getByText(
          "账号须为 3–128 位，以英文字母或数字开头，仅使用英文字母、数字和 _ . @ + -。",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        recipient.getByText(
          "密码太短：当前 5 字节，至少需要 12 字节。",
          { exact: true },
        ),
      ).toBeVisible();
      expect((await tokenField.inputValue()) === token).toBe(true);
      expect((await recipient.request.get("/api/auth/me")).status()).toBe(401);
      expect(signupRequests).toBe(0);
      await capture(recipient, info, `signup-correction-${width}`, [
        tokenField,
      ]);
      await recipient.getByLabel("账号", { exact: true }).fill(username);
      await recipient
        .getByLabel("密码", { exact: true })
        .fill(invitationPassword);
      const joined = recipient.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/auth/accept-invite" &&
          r.request().method() === "POST",
      );
      await recipient
        .getByRole("button", { name: "创建账号并继续", exact: true })
        .click();
      expect((await joined).status()).toBe(200);
      expect(signupRequests).toBe(1);
      const identity = (await readOnboarding(recipient.request, "/auth/me"))
        .user;
      expect(identity.role).toBe("user");
      expect(identity.username).toBe(username);
      for (const path of [
        "/me/profiles",
        "/me/outputs",
        "/me/sources",
        "/me/collections",
        "/me/platform-entries",
      ])
        expect(
          (await readOnboarding(recipient.request, path)).length,
          "Recipient starts without private workspace records",
        ).toBe(0);
      const beforeGrant = await readOnboarding(
        recipient.request,
        "/me/overview",
      );
      expect(beforeGrant.routes).toEqual([]);
      for (const path of [
        "/api/me/profiles",
        "/api/me/outputs",
        "/api/me/platform-entries",
      ])
        expect((await anonymous.get(path)).status()).toBe(401);

      await admin.reload();
      await admin
        .getByRole("group", { name: `${name} 的操作`, exact: true })
        .getByRole("button", { name: `更多操作 ${name}`, exact: true })
        .click();
      await admin
        .getByRole("menuitem", { name: "授权与续期", exact: true })
        .click();
      const grant = admin.getByRole("dialog", {
        name: `${name} 的服务授权`,
        exact: true,
      });
      await grant
        .getByRole("radio", { name: "指定个人方案", exact: true })
        .check();
      await grant.getByLabel("个人指定方案", { exact: true }).click();
      await admin
        .getByRole("option", { name: invitationServiceName, exact: true })
        .click();
      await grant
        .getByRole("button", { name: "预览影响", exact: true })
        .click();
      const review = admin.getByRole("dialog", {
        name: "确认授权变更",
        exact: true,
      });
      const apply = review.getByRole("button", {
        name: "更新授权",
        exact: true,
      });
      await expect(apply).toBeDisabled();
      await review.getByRole("button", { name: "查看个人设置变更", exact: true }).click();
      await expect(
        review
          .getByRole("table", { name: "个人授权变更", exact: true })
          .getByRole("row")
          .filter({
            has: admin.getByRole("rowheader", {
              name: "个人指定方案",
              exact: true,
            }),
          })
          .getByText(invitationServiceName, { exact: true }),
      ).toBeVisible();
      await expect(
        review.getByText("受管入口配置需单独应用。", { exact: true }),
      ).toBeVisible();
      expect(await readOnboarding(recipient.request, "/me/overview")).toEqual(
        beforeGrant,
      );
      await capture(admin, info, `grant-review-${width}`);
      const impact = review.getByRole("table", { name, exact: true });
      const serviceImpact = impact.getByRole("row").filter({
        has: admin.getByRole("rowheader", { name: "服务方案", exact: true }),
      });
      const routeImpact = impact.getByRole("row").filter({
        has: admin.getByRole("rowheader", { name: "授权线路", exact: true }),
      });
      await expect(serviceImpact).toHaveCount(1);
      await expect(routeImpact).toHaveCount(1);
      await expect(
        serviceImpact
          .getByRole("cell")
          .nth(0)
          .getByText("无方案", { exact: true }),
      ).toBeVisible();
      await expect(
        serviceImpact
          .getByRole("cell")
          .nth(1)
          .getByText(invitationServiceName, { exact: true }),
      ).toBeVisible();
      await expect(
        routeImpact.getByRole("cell").nth(0).getByText("无", { exact: true }),
      ).toBeVisible();
      await expect(
        routeImpact
          .getByRole("cell")
          .nth(1)
          .getByText(invitationRouteName, { exact: true }),
      ).toBeVisible();
      const beforeColumn = impact.getByRole("columnheader", {
        name: "变更前",
        exact: true,
      });
      const afterColumn = impact.getByRole("columnheader", {
        name: "变更后",
        exact: true,
      });
      await serviceImpact.scrollIntoViewIfNeeded();
      await beforeColumn.scrollIntoViewIfNeeded();
      await expect(beforeColumn).toBeInViewport({ ratio: 1 });
      await expect(afterColumn).toBeInViewport({ ratio: 1 });
      await expect(serviceImpact).toBeInViewport({ ratio: 1 });
      await capture(admin, info, `grant-impact-${width}`);
      // Keep the route consequence legible even when the whole table cannot
      // fit in the narrow dialog's scrollable body at once.
      await routeImpact.scrollIntoViewIfNeeded();
      await expect(routeImpact).toBeInViewport({ ratio: 1 });
      await capture(admin, info, `grant-impact-routes-${width}`);
      await review
        .getByRole("button", { name: "返回编辑", exact: true })
        .click();
      expect(await readOnboarding(recipient.request, "/me/overview")).toEqual(
        beforeGrant,
      );
      await grant
        .getByRole("button", { name: "预览影响", exact: true })
        .click();
      const consent = review.getByRole("checkbox", {
        name: "我已核对本次授权变更",
        exact: true,
      });
      await consent.scrollIntoViewIfNeeded();
      await consent.check();
      await expect(consent).toBeChecked();
      await expect(consent).toBeInViewport({ ratio: 1 });
      await expect(apply).toBeEnabled();
      await expect(apply).toBeInViewport({ ratio: 1 });
      await expect(
        review.getByText("受管入口配置需单独应用。", { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(await readOnboarding(recipient.request, "/me/overview")).toEqual(
        beforeGrant,
      );
      await capture(admin, info, `grant-confirmed-${width}`);
      const applied = admin.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/access-policy/apply" &&
          r.request().method() === "POST",
      );
      await apply.click();
      expect((await applied).status()).toBe(200);
      await expect(grant).toBeHidden();
      const granted = await readOnboarding(recipient.request, "/me/overview");
      expect(granted.status).toBe("active");
      expect(granted.entitlement.cycle.mode).toBe("none");
      expect(granted.quotaBytes).toBe(0);
      expect(granted.service.id).toBe(source.id);
      expect(granted.routes).toEqual([
        expect.objectContaining({ id: source.id, name: invitationRouteName }),
      ]);
      // The only post-grant fixture boundary: explicit legacy entry, no UI exists.
      await source.assignLegacyEntryAfterGrant(identity.id);
      await recipient.goto("/#subscriptions");
      await expect(
        recipient.getByRole("heading", {
          name: invitationRouteName,
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        recipient.getByText(invitationServiceName, { exact: true }),
      ).toBeVisible();
      await capture(recipient, info, `authorized-service-${width}`);
      await recipient.goto("/#profiles");
      await recipient
        .getByRole("button", { name: "新建分流配置", exact: true })
        .click();
      await recipient.getByLabel("配置名称", { exact: true }).fill(profileName);
      await recipient.getByLabel("默认流量行为", { exact: true }).click();
      const entryOption = recipient.getByRole("option").filter({
        has: recipient.getByText(`平台入口 ${invitationEntryName}`, {
          exact: true,
        }),
      });
      await expect(entryOption).toHaveCount(1);
      await entryOption.click();
      const ownSummary = recipient.getByText("自有连接：0 个", { exact: true });
      const entrySummary = recipient.getByText("平台入口：1 个", { exact: true });
      const credentialTiming = recipient.getByText("平台入口凭据在发布时解析。", { exact: true });
      await expect(ownSummary).toBeVisible();
      await expect(entrySummary).toBeVisible();
      await expect(recipient.getByText("0 个有效连接", { exact: true })).toHaveCount(0);
      expect(await ownSummary.evaluate((element) => getComputedStyle(element).fontWeight)).toBe(
        await entrySummary.evaluate((element) => getComputedStyle(element).fontWeight),
      );
      await capture(recipient, info, `first-profile-${width}`);
      await credentialTiming.scrollIntoViewIfNeeded();
      await expect(ownSummary).toBeInViewport({ ratio: 1 });
      await expect(entrySummary).toBeInViewport({ ratio: 1 });
      await expect(credentialTiming).toBeInViewport({ ratio: 1 });
      await capture(recipient, info, `first-profile-input-summary-${width}`);
      await recipient
        .getByRole("button", { name: "保存并检查", exact: true })
        .click();
      const create = recipient.getByRole("dialog", {
        name: "新增客户端订阅",
        exact: true,
      });
      await expect(create).toBeVisible();
      const profiles = await readOnboarding(recipient.request, "/me/profiles");
      expect(profiles.length).toBe(1);
      expect(
        profiles[0].name === profileName &&
          JSON.stringify(profiles[0].platformEntryIds) ===
            JSON.stringify(["invited-entry"]) &&
          profiles[0].ir.defaultAction.kind === "endpoint" &&
          profiles[0].ir.defaultAction.ref === "invited-entry",
        "Saved profile selects the authorized entry",
      ).toBe(true);
      expect(
        (await readOnboarding(recipient.request, "/me/outputs")).length,
        "No output before explicit publication",
      ).toBe(0);
      await create.getByRole("button", { name: "取消", exact: true }).click();
      await recipient
        .getByRole("button", { name: "检查发布", exact: true })
        .click();
      await create.getByLabel("订阅名称", { exact: true }).fill(outputName);
      await create.getByLabel("目标客户端", { exact: true }).click();
      await recipient
        .getByRole("option", { name: "Mihomo 1.19.32", exact: true })
        .click();
      await create
        .getByRole("button", { name: "检查发布内容", exact: true })
        .dblclick();
      const checked = create
        .getByRole("status")
        .filter({ hasText: "兼容检查通过。" });
      await expect(checked).toBeFocused();
      await recipient.keyboard.press("Enter");
      expect(
        (await readOnboarding(recipient.request, "/me/outputs")).length,
        "No output before explicit publication",
      ).toBe(0);
      const publish = create.getByRole("button", {
        name: `创建并发布「${outputName}」`,
        exact: true,
      });
      await expect(publish).toBeEnabled();
      await capture(recipient, info, `publication-review-${width}`);
      await activateByKeyboard(recipient, publish);
      const access = recipient.getByRole("dialog", {
        name: `获取「${outputName}」`,
        exact: true,
      });
      await expect(access).toBeVisible();
      const outputs = await readOnboarding(recipient.request, "/me/outputs");
      expect(outputs.length).toBe(1);
      expect(
        outputs[0].name === outputName &&
          outputs[0].profileId === profiles[0].id &&
          outputs[0].status === "published",
        "First output is explicitly published",
      ).toBe(true);
      const url = await access
        .getByRole("textbox", { name: "订阅链接", exact: true })
        .inputValue();
      const bytes = await readInvitationFeed(baseURL!, url);
      const artifact = JSON.parse(bytes.toString());
      expect(artifact.proxies.length).toBe(1);
      expect(
        artifact.proxies[0].type === "socks5" &&
          artifact.proxies[0].server === "127.0.0.1" &&
          artifact.proxies[0].port === 1080 &&
          artifact.proxies[0].username === identity.id &&
          artifact.proxies[0].password === "synthetic-entry-password",
        "Downloaded connection belongs to recipient",
      ).toBe(true);
      expect(
        JSON.stringify(artifact.rules).includes(artifact.proxies[0].name),
      ).toBe(true);
      // The browser's actual download must match the independently fetched bytes.
      const downloading = recipient.waitForEvent("download");
      await access.getByRole("link", { name: "下载配置", exact: true }).click();
      const download = await downloading;
      expect((await download.failure()) === null).toBe(true);
      const stream = await download.createReadStream();
      expect(stream !== null).toBe(true);
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
      await download.delete();
      // QR encodes the bearer URL too; retain visible download action and disclosure.
      await capture(recipient, info, `subscription-delivered-${width}`, [
        access.locator(".qr-container"),
        access.getByRole("textbox", { name: "订阅链接", exact: true }),
      ]);
      await recipient.keyboard.press("Escape");
      await expect(access).toBeHidden();
      await logout(recipient, width === 390);
      expect((await recipient.request.get("/api/me/profiles")).status()).toBe(
        401,
      );
      await login(recipient, username, invitationPassword);
      await recipient.goto("/#subscriptions");
      const row = recipient.getByRole("group", {
        name: `客户端订阅 ${outputName}`,
        exact: true,
      });
      await expect(row).toBeVisible();
      expect(
        JSON.stringify(
          await readOnboarding(recipient.request, "/me/profiles"),
        ) === JSON.stringify(profiles),
        "Saved profile persists unchanged",
      ).toBe(true);
      expect(
        JSON.stringify(
          await readOnboarding(recipient.request, "/me/outputs"),
        ) === JSON.stringify(outputs),
        "Published output persists unchanged",
      ).toBe(true);
      expect((await readInvitationFeed(baseURL!, url)).equals(bytes)).toBe(
        true,
      );
      expect(
        JSON.stringify(await readOnboarding(admin.request, "/me/profiles")) ===
          JSON.stringify(adminProfiles),
        "Other account profiles unchanged",
      ).toBe(true);
      expect(
        JSON.stringify(await readOnboarding(admin.request, "/me/outputs")) ===
          JSON.stringify(adminOutputs),
        "Other account outputs unchanged",
      ).toBe(true);
      expect(
        (
          await admin.request.get(`/api/me/outputs/${outputs[0].id}/access`)
        ).status(),
      ).toBe(404);
      await capture(recipient, info, `persisted-subscription-${width}`);
      await info.attach("safe-onboarding-result", {
        contentType: "application/json",
        body: JSON.stringify({
          invitationCreatedInUI: true,
          invalidSignupRetainedInvitation: true,
          serviceGrantedByPreviewAndApplyUI: true,
          reviewAndCancelDidNotGrant: true,
          emptyRecipientWorkspace: true,
          firstProfileAndPublicationInUI: true,
          checkAndCancelDidNotPublish: true,
          downloadedBytesMatchChosenConnection: true,
          persistedAfterLogin: true,
          anonymousDenied: true,
          otherAccountUnchanged: true,
          boundary:
            "Public API seeds synthetic source infrastructure and assigns explicit legacy platform entry after UI grant. No managed-node application, migration, native-client loading or traffic evidence.",
        }),
      });
    } finally {
      // Bounded cleanup of this test's synthetic pages before Playwright takes
      // failure-context DOM snapshots. Preserve the original task failure if
      // cleanup cannot navigate a closed/crashed page. This is not a guarantee
      // of secrecy for arbitrary runner failures or external reporters.
      for (const page of [recipient, admin]) {
        if (!page.isClosed()) await page.goto("about:blank").catch(() => {});
      }
      await recipientContext.close();
      await anonymous.dispose();
    }
  });
}
