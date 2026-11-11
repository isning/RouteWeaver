import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { settledTask } from "./ui-settled-task";

// Built production App, synthetic browser HTTP only. No rate write reaches the
// isolated backend. Receipts survive only while Rates remains mounted; these
// tests do not establish persistence across navigation, offline use or enforcement.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
  timezoneId: "UTC",
});

const routeName = "合成办公线路：研发团队日常协作";
const failure = "倍率记录暂时无法刷新";
const mismatch = "保存结果无法核对，请检查倍率记录，避免重复保存。";
const consequence =
  "每次保存创建独立倍率版本，保存后锁定；历史记录沿用原版本。";
type Rate = {
  id: string;
  routeId: string;
  micros: number;
  effectiveAt: string;
};

async function installFixture(
  page: Page,
  baseURL: string | undefined,
  mismatched: boolean,
) {
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Synthetic rate recovery requires a loopback origin");
  const origin = new URL(baseURL).origin;
  const fixtures: Record<string, unknown> = {
    "/api/auth/me": {
      user: { id: "synthetic-rate-admin", name: "合成管理员", role: "admin" },
      csrfToken: "synthetic-rate-recovery",
    },
    "/api/state": {
      nodes: [],
      users: [],
      routes: [],
      revisions: [],
      capabilities: [],
      deploymentAvailable: false,
    },
    "/api/settings": {},
    "/api/services": [],
    "/api/published-routes": [
      { id: "synthetic-office-route", name: routeName, status: "published" },
    ],
  };
  const writes: Rate[] = [];
  const reads: string[] = [];
  const authoritativeReads: string[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let recovered = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const refuse = () => {
      unexpected.push(
        `${request.method()} ${url.origin}${url.pathname}${url.search}`,
      );
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin || url.search) return refuse();
    if (!/^\/api(?:\/|$)/.test(url.pathname)) {
      // Only the built document and static assets can pass through to this
      // exact isolated origin. Unknown paths and all other methods are blocked.
      if (
        request.method() === "GET" &&
        (url.pathname === "/" || url.pathname.startsWith("/assets/"))
      )
        return route.continue();
      return refuse();
    }
    if (request.method() === "GET" && url.pathname === "/api/rates") {
      reads.push(url.pathname);
      if (!writes.length) return route.fulfill({ json: [] });
      if (recovered) {
        authoritativeReads.push(url.pathname);
        return route.fulfill({ json: writes });
      }
      return route.fulfill({ status: 503, json: { message: failure } });
    }
    if (request.method() === "GET" && Object.hasOwn(fixtures, url.pathname)) {
      reads.push(url.pathname);
      return route.fulfill({ json: fixtures[url.pathname] });
    }
    if (request.method() === "POST" && url.pathname === "/api/rates") {
      const body = request.postDataJSON() as Rate;
      writes.push(structuredClone(body));
      expect(writes).toHaveLength(1);
      expect(Object.keys(body).sort()).toEqual([
        "effectiveAt",
        "id",
        "micros",
        "routeId",
      ]);
      expect(body.id).toMatch(/^rate_[a-f0-9]{16}$/);
      expect(body).toMatchObject({
        routeId: "synthetic-office-route",
        micros: 2_000_000,
        effectiveAt: "2099-01-02T03:04:00.000Z",
      });
      return route.fulfill({
        status: 201,
        json: mismatched
          ? { ...body, id: "synthetic-unrelated-receipt" }
          : body,
      });
    }
    return refuse();
  });
  return {
    writes,
    reads,
    authoritativeReads,
    unexpected,
    errors,
    recover: () => {
      recovered = true;
    },
  };
}

// Reach controls using actual tab order, without injecting focus or DOM events.
async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let count = 0; count < 80; count++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await info.attach(name, {
    body: await page.screenshot({ scale: "css" }),
    contentType: "image/png",
  });
}

for (const width of [1440, 390]) {
  for (const mismatched of [false, true]) {
    test(`rate ${mismatched ? "unverified receipt closes for checking" : "saved receipt survives failed refresh and retry"} at ${width}px`, async ({
      page,
      baseURL,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const fixture = await installFixture(page, baseURL, mismatched);
      await page.goto("/#services");
      await expect(
        page.getByRole("heading", { name: "服务方案", exact: true, level: 1 }),
      ).toBeVisible();
      const opener = page.getByRole("button", {
        name: "调整倍率",
        exact: true,
      });
      await tabTo(page, opener);
      await page.keyboard.press("Enter");
      const editor = page.getByRole("dialog", {
        name: "调整线路扣量倍率",
        exact: true,
      });
      await settledTask(editor);
      const routeChoice = editor.getByRole("combobox", {
        name: "线路",
        exact: true,
      });
      await tabTo(page, routeChoice);
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("option", { name: routeName, exact: true }),
      ).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(routeChoice).toContainText(routeName);
      const factor = editor.getByRole("spinbutton", {
        name: "整条线路倍率（×）",
        exact: true,
      });
      await tabTo(page, factor);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("2");
      await expect(factor).toHaveValue("2");
      await expect(
        editor.getByText("使用 1 GB 实际流量，扣除 2 GB 额度。", {
          exact: true,
        }),
      ).toBeVisible();
      const date = editor.getByLabel("开始时间（本机时区）", { exact: true });
      await tabTo(page, date);
      // A native datetime field is seeded through its public input interface;
      // navigation, selection, submission and recovery stay keyboard-driven.
      await date.fill("2099-01-02T03:04");
      await expect(date).toHaveValue("2099-01-02T03:04");
      const save = editor.getByRole("button", {
        name: "保存倍率版本",
        exact: true,
      });
      await tabTo(page, save);
      await expect(save).toBeInViewport({ ratio: 1 });
      await expect(routeChoice).toBeInViewport({ ratio: 1 });
      await expect(
        editor.getByText(consequence, { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await capture(page, info, `rate-${width}-${mismatched}-decision`);
      await page.keyboard.press("Enter");
      await expect.poll(() => fixture.writes.length).toBe(1);
      const row = page
        .getByRole("row")
        .filter({ hasText: routeName })
        .filter({ hasText: "2×" });
      if (mismatched) {
        await expect(editor.getByText(mismatch, { exact: true })).toBeVisible();
        await expect(save).toBeDisabled();
        await expect(routeChoice).toContainText(routeName);
        await expect(factor).toHaveValue("2");
        await expect(date).toHaveValue("2099-01-02T03:04");
        await expect(
          page.getByText("线路倍率版本已保存", { exact: true }),
        ).toHaveCount(0);
        await expect(row).toHaveCount(0);
        const check = editor.getByRole("button", {
          name: "关闭并检查记录",
          exact: true,
        });
        await tabTo(page, check);
        await capture(page, info, `rate-${width}-unverified-receipt`);
        fixture.recover();
        await page.keyboard.press("Enter");
      } else {
        await expect(editor).toHaveCount(0);
        await expect(page.getByText(failure, { exact: true })).toBeVisible();
        await expect(row).toHaveCount(1);
        await expect(row).toContainText("2099/01/02 11:04");
        await expect(row).toContainText("待生效");
        await row.scrollIntoViewIfNeeded();
        await expect(page.getByText(failure, { exact: true })).toBeInViewport({
          ratio: 1,
        });
        await expect(row).toBeInViewport({ ratio: 1 });
        await capture(
          page,
          info,
          `rate-${width}-saved-despite-refresh-failure`,
        );
        // A fresh, canceled editor cannot erase the earlier confirmed receipt.
        await tabTo(page, opener);
        await page.keyboard.press("Enter");
        await settledTask(editor);
        await tabTo(
          page,
          editor.getByRole("button", { name: "取消", exact: true }),
        );
        await page.keyboard.press("Enter");
        await expect(editor).toHaveCount(0);
        await expect(row).toHaveCount(1);
        const retry = page.getByRole("button", { name: "重试", exact: true });
        await tabTo(page, retry);
        await expect(retry).toBeInViewport({ ratio: 1 });
        fixture.recover();
        await page.keyboard.press("Enter");
      }
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(row).toHaveCount(1);
      await expect(page.getByText(failure, { exact: true })).toHaveCount(0);
      await expect(row).toContainText("2099/01/02 11:04");
      await row.scrollIntoViewIfNeeded();
      await capture(
        page,
        info,
        `rate-${width}-${mismatched}-authoritative-record`,
      );
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.authoritativeReads.length).toBeGreaterThan(0);
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
      await info.attach("synthetic-rate-request-ledger", {
        contentType: "application/json",
        body: JSON.stringify(
          {
            writes: fixture.writes,
            reads: fixture.reads,
            authoritativeReads: fixture.authoritativeReads,
            unexpected: fixture.unexpected,
            scope:
              "Built App with intercepted synthetic responses only. No backend rate write, deployed enforcement, offline or cross-navigation retention verified.",
          },
          null,
          2,
        ),
      });
    });
  }
}
