import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { entitlementEditFixture } from "../src/test-support/entitlement-edit-fixture";
import { settledTask } from "./ui-settled-task";

// Built production App and public keyboard/UI seams, with synthetic GET data.
// No preview, confirmation or save request is forwarded or fulfilled. This is
// custom validation recovery, not native constraint validation or backend proof.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
  timezoneId: "UTC",
});
const failure = "请选择个人方案，或切换为继承用户组方案";

async function installFixture(page: Page, baseURL: string | undefined) {
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error(
      "Synthetic entitlement recovery requires a loopback origin",
    );
  const origin = new URL(baseURL).origin;
  const user = {
    id: "alice",
    name: "Alice",
    enabled: true,
    quotaBytes: 0,
    usedBytes: 0,
  };
  const person = entitlementEditFixture({
    userId: user.id,
    groupIds: [],
    routeIds: [],
    quotaBytes: 0,
    onlineIpLimit: 0,
    connectionLimit: 0,
    entryRateBps: 0,
    status: "active",
    provenance: {},
    entitlement: {
      userId: user.id,
      startsAt: "2026-01-01T00:00:00Z",
      paused: false,
      cycle: {
        mode: "monthly",
        day: 1,
        anchor: "2026-01-01T00:00:00Z",
        timezone: "UTC+8",
      },
    },
  });
  const contextPath = "/api/access-policy/edit-context/entitlement/alice";
  const fixtures: Record<string, unknown> = {
    "/api/auth/me": {
      user: { id: "synthetic-admin", name: "Admin", role: "admin" },
      csrfToken: "synthetic-user-policy",
    },
    "/api/state": {
      nodes: [],
      users: [user],
      routes: [],
      revisions: [],
      capabilities: [],
      deploymentAvailable: false,
    },
    "/api/settings": {},
    "/api/published-routes": [],
    "/api/services": [],
    "/api/rates": [],
    "/api/user-groups": [],
    [contextPath]: person.context(),
    "/api/users/alice/admission-status": {
      asOf: "2026-01-01T00:00:00Z",
      maxLeaseSeconds: 30,
      onlineIps: [],
      activeStreams: 0,
      entries: [],
    },
  };
  const unexpected: string[] = [],
    writes: string[] = [],
    reads: string[] = [];
  let pageErrors = 0;
  page.on("pageerror", () => {
    pageErrors++;
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    // Never retain request bodies, external addresses or query values.
    const label = `${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}${url.search ? "?redacted" : ""}`;
    const refuse = () => {
      unexpected.push(label);
      return route.abort("blockedbyclient");
    };
    if (request.method() !== "GET") {
      writes.push(label);
      return refuse();
    }
    if (url.origin !== origin || url.search) return refuse();
    if (Object.hasOwn(fixtures, url.pathname)) {
      reads.push(url.pathname);
      return route.fulfill({ json: fixtures[url.pathname] });
    }
    if (url.pathname === "/" || url.pathname.startsWith("/assets/"))
      return route.continue();
    return refuse();
  });
  return {
    writes,
    unexpected,
    reads,
    contextPath,
    pageErrors: () => pageErrors,
  };
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let count = 0; count < 80; count++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function openEditor(page: Page) {
  await page
    .getByRole("button", { name: "更多操作 Alice", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "授权与续期", exact: true }).click();
  // Loading and editable sheets have the same name but different lifetimes.
  await expect(page.getByLabel("开通时间", { exact: true })).toBeVisible();
  const sheet = page.getByRole("dialog", {
    name: "Alice 的服务授权",
    exact: true,
  });
  await settledTask(sheet);
  return sheet;
}

async function captureRecovery(
  page: Page,
  sheet: Locator,
  choice: Locator,
  info: TestInfo,
  name: string,
) {
  // Observe automatic recovery scrolling only. Do not scroll/focus the invalid
  // control after submission: that would hide the very regression under test.
  await expect(choice).toBeFocused();
  await expect(choice).toBeInViewport({ ratio: 1 });
  await expect(sheet.getByText(failure, { exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect
    .poll(() =>
      choice.evaluate((node) => {
        const box = node.getBoundingClientRect();
        let top = 0,
          bottom = innerHeight,
          left = 0,
          right = innerWidth;
        for (
          let parent = node.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent),
            rect = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            top = Math.max(top, rect.top + parent.clientTop);
            bottom = Math.min(
              bottom,
              rect.top + parent.clientTop + parent.clientHeight,
            );
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            left = Math.max(left, rect.left + parent.clientLeft);
            right = Math.min(
              right,
              rect.left + parent.clientLeft + parent.clientWidth,
            );
          }
        }
        return (
          box.top >= top - 1 &&
          box.bottom <= bottom + 1 &&
          box.left >= left - 1 &&
          box.right <= right + 1
        );
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await info.attach(name, {
    body: await page.screenshot({ scale: "css" }),
    contentType: "image/png",
  });
}

for (const width of [390, 1440]) {
  test(`guarded entitlement Preview recovers the invalid personal choice at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await installFixture(page, baseURL);
    await page.goto("/#users");
    let sheet = await openEditor(page);
    for (const opening of ["initial", "reopened"]) {
      const pause = sheet.getByRole("switch", {
        name: "暂停平台服务",
        exact: true,
      });
      await expect(pause).toHaveAttribute("aria-checked", "false");
      await expect(
        sheet.getByRole("radio", { name: "继承用户组方案", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await pause.click();
      const personal = sheet.getByRole("radio", {
        name: "指定个人方案",
        exact: true,
      });
      await personal.click();
      const choice = sheet.getByRole("combobox", {
        name: "个人指定方案",
        exact: true,
      });
      await expect(choice).toBeEnabled();
      const preview = sheet.getByRole("button", {
        name: "预览影响",
        exact: true,
      });
      await expect(preview).toHaveAttribute("type", "button");
      expect(
        await preview.evaluate((node) =>
          (node as HTMLButtonElement).form?.checkValidity(),
        ),
      ).toBe(true);
      for (const key of ["Enter", "Space"]) {
        await tabTo(page, preview);
        await expect(preview).toBeFocused();
        await expect(preview).not.toHaveAttribute("aria-disabled", "true");
        await page.keyboard.press(key);
        await expect(choice).toHaveAttribute("aria-invalid", "true");
        await expect(choice).toHaveAccessibleDescription(failure);
        await expect(choice).toHaveText("选择服务方案");
        await expect(pause).toHaveAttribute("aria-checked", "true");
        await expect(personal).toHaveAttribute("aria-checked", "true");
        await expect(
          page.getByRole("dialog", { name: "确认授权变更", exact: true }),
        ).toHaveCount(0);
        await captureRecovery(
          page,
          sheet,
          choice,
          info,
          `${opening}-${key}-${width}`,
        );
        expect(fixture.writes).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      }
      await sheet.getByRole("button", { name: "取消", exact: true }).click();
      const discard = page.getByRole("alertdialog", {
        name: "放弃尚未保存的授权修改？",
        exact: true,
      });
      await expect(discard).toBeVisible();
      await discard
        .getByRole("button", { name: "放弃修改", exact: true })
        .click();
      await expect(sheet).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "更多操作 Alice", exact: true }),
      ).toBeFocused();
      if (opening === "initial") sheet = await openEditor(page);
    }
    expect(
      fixture.reads.filter((path) => path === fixture.contextPath),
    ).toHaveLength(2);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.pageErrors()).toBe(0);
  });
}
