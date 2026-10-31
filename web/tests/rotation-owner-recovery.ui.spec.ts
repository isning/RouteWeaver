import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { emptyProfile } from "../src/model";
import { surfaceMotionState } from "./ui-surface-stability";

async function ownerFixture(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { rotationFocus: unknown[] };
    state.rotationFocus = [];
    const describe = (element: Element | null) =>
      element
        ? {
            tag: element.tagName,
            role: element.getAttribute("role"),
            name:
              element.getAttribute("aria-label") ||
              element.textContent?.slice(0, 80),
            connected: element.isConnected,
          }
        : null;
    for (const kind of ["focusin", "pointerdown", "keydown", "transitionend"])
      document.addEventListener(
        kind,
        (event) => {
          state.rotationFocus.push({
            kind,
            at: performance.now(),
            key: (event as KeyboardEvent).key,
            target: describe(
              event.target instanceof Element ? event.target : null,
            ),
            active: describe(document.activeElement),
            dialogs: [...document.querySelectorAll('[role="dialog"]')]
              .filter(
                (element) => (element as HTMLElement).offsetParent !== null,
              )
              .map((element) => element.getAttribute("aria-labelledby")),
          });
        },
        true,
      );
  });
  const profile = { ...emptyProfile(), id: "shared-profile", name: "日常分流" };
  const original = {
    id: "phone",
    name: "Phone",
    profileId: profile.id,
    target: { adapterId: "sing-box", version: "1.14.3" },
    mode: "nodes-only",
    status: "published",
    revision: "phone-old",
    publishedAt: "2026-10-23T17:00:00Z",
  };
  const sibling = {
    ...original,
    id: "laptop",
    name: "Laptop",
    revision: "laptop-old",
  };
  let current = { ...original },
    owner = "rotation-owner",
    readiness = "OUTPUT_ENTRY_UNCONFIRMED";
  let nextAccess: Promise<void> | undefined;
  const writes: { path: string; body: unknown }[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  let accessReads = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (path === "/api/me/profiles/shared-profile/preview")
        return route.fulfill({
          json: {
            valid: true,
            previewDigest: "e".repeat(64),
            publicationEffect: { version: 1, link: "preserve" },
            artifacts: [],
            diagnostics: [],
            previewScope: "output-update",
            outputId: original.id,
          },
        });
      if (path === "/api/me/outputs/phone/publish") {
        current = { ...current, revision: "phone-updated" };
        readiness = "ready";
        return route.fulfill({ json: current });
      }
    } else {
      if (path === "/api/auth/me")
        return route.fulfill({
          json: {
            user: {
              id: owner,
              name: owner === "rotation-owner" ? "小林" : "新账号",
              role: "user",
            },
            csrfToken: `synthetic-${owner}`,
          },
        });
      if (path === "/api/me/overview")
        return route.fulfill({
          json: {
            user: { id: owner, name: "小林", enabled: true },
            routes: [],
            quotaBytes: 0,
            status: "active",
          },
        });
      if (path === "/api/me/profiles")
        return route.fulfill({
          json: owner === "rotation-owner" ? [profile] : [],
        });
      if (path === "/api/me/outputs")
        return route.fulfill({
          json: owner === "rotation-owner" ? [current, sibling] : [],
        });
      if (path === "/api/me/outputs/phone/access") {
        accessReads++;
        if (nextAccess) {
          const waiting = nextAccess;
          nextAccess = undefined;
          await waiting;
        }
        return readiness === "ready"
          ? route.fulfill({
              json: {
                feedPath: "/feed/synthetic-existing-link",
                delivery: "feed",
              },
            })
          : route.fulfill({
              status: 409,
              json: { code: readiness, detail: "Synthetic blocked delivery" },
            });
      }
      if (path === "/api/me/outputs/phone/status")
        return route.fulfill({
          json: { ...current, draftComparison: { state: "changed" } },
        });
      if (path === "/api/me/outputs/laptop/status")
        return route.fulfill({
          json: { ...sibling, draftComparison: { state: "changed" } },
        });
      if (path.endsWith("/notifications") || path.endsWith("/unread"))
        return route.fulfill({ json: [] });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 500,
      json: { detail: "Unexpected synthetic request" },
    });
  });
  return {
    original,
    sibling,
    writes,
    unexpected,
    errors,
    reads: () => accessReads,
    ready: (value: string) => {
      readiness = value;
    },
    changeAccount: () => {
      owner = "second-owner";
    },
    hold: () => {
      let done!: () => void;
      nextAccess = new Promise<void>((resolve) => {
        done = resolve;
      });
      return done;
    },
  };
}
async function openPhone(page: Page, pendingRead = false) {
  const row = page.getByRole("group", {
    name: "客户端订阅 Phone",
    exact: true,
  });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "获取订阅", exact: true }).click();
  const access = page.getByRole("dialog", {
    name: "获取「Phone」",
    exact: true,
  });
  await expect
    .poll(() => access.evaluate(surfaceMotionState))
    .toMatchObject(
      pendingRead
        ? { preparing: false, opacity: "1" }
        : { preparing: false, running: false, opacity: "1" },
    );
  await expect(
    access.getByRole("button", { name: "关闭", exact: true }),
  ).toBeEnabled();
  return access;
}

for (const reducedMotion of ["no-preference", "reduce"] as const)
  test(`owner repairs only the original frozen Output and returns from explicit review at 390px (${reducedMotion})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion });
    const f = await ownerFixture(page);
    let phase = "workspace readiness";
    const focusCheckpoints: unknown[] = [];
    const recordFocus = async (boundary: string) => {
      focusCheckpoints.push(
        await page.evaluate(
          (boundary) => ({
            boundary,
            active: {
              tag: document.activeElement?.tagName,
              name:
                document.activeElement?.getAttribute("aria-label") ||
                document.activeElement?.textContent?.slice(0, 100),
            },
            inAccess: !!document.activeElement?.closest('[role="dialog"]'),
            documentHasFocus: document.hasFocus(),
          }),
          boundary,
        ),
      );
    };
    try {
      await page.goto("/#subscriptions");
      const access = await openPhone(page);
      phase = "unconfirmed";
      await expect(
        access.getByText("平台入口尚未确认可用", { exact: true }),
      ).toBeVisible();
      await expect(access.getByRole("textbox")).toHaveCount(0);
      await expect(access.getByRole("link")).toHaveCount(0);
      await expect(
        access.getByRole("button", { name: "检查更新", exact: true }),
      ).toHaveCount(0);
      expect(f.writes).toHaveLength(0);
      await page.screenshot({
        path: info.outputPath("entry-unconfirmed-390.png"),
      });
      f.ready("OUTPUT_REPUBLISH_REQUIRED");
      await access
        .getByRole("button", { name: "重新核对", exact: true })
        .click();
      phase = "republish required";
      await expect(
        access.getByText("此订阅需要更新", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("republish-required-390.png"),
      });
      await recordFocus("recheck resolved before next action");
      await page.keyboard.press("Tab");
      await recordFocus("first Tab after recheck");
      await expect(
        access.getByRole("button", { name: "检查更新", exact: true }),
      ).toBeFocused();
      await access
        .getByRole("button", { name: "检查更新", exact: true })
        .click();
      const review = page.getByRole("dialog", {
        name: "检查订阅更新「Phone」",
        exact: true,
      });
      const confirm = review.getByRole("button", {
        name: "确认更新「Phone」",
        exact: true,
      });
      await expect(confirm).toBeEnabled();
      expect(f.writes).toEqual([
        {
          path: "/api/me/profiles/shared-profile/preview",
          body: {
            outputId: f.original.id,
            target: f.original.target,
            mode: f.original.mode,
          },
        },
      ]);
      phase = "cancel review";
      await review.getByRole("button", { name: /^取\s*消$/ }).click();
      await expect
        .soft(access.getByRole("button", { name: "检查更新", exact: true }))
        .toBeFocused();
      await access
        .getByRole("button", { name: "检查更新", exact: true })
        .click();
      await expect(confirm).toBeEnabled();
      await page.screenshot({
        path: info.outputPath("original-output-review-390.png"),
      });
      phase = "explicit publish";
      await confirm.click();
      await expect(
        access.getByRole("textbox", { name: "订阅链接", exact: true }),
      ).toHaveValue(/synthetic-existing-link$/);
      await expect(
        access.getByRole("link", { name: "下载配置", exact: true }),
      ).toBeVisible();
      expect(f.writes.filter((w) => w.path.endsWith("/publish"))).toEqual([
        {
          path: "/api/me/outputs/phone/publish",
          body: { previewDigest: "e".repeat(64) },
        },
      ]);
      expect(
        f.writes.some(
          (w) =>
            /\/(rotate|revoke|principals)$/.test(w.path) ||
            w.path === "/api/me/outputs",
        ),
      ).toBe(false);
      expect(f.unexpected).toEqual([]);
      expect(f.errors).toEqual([]);
      await page.screenshot({
        path: info.outputPath("same-output-access-restored-390.png"),
      });
      phase = "outer Close after nested review";
      const trigger = page
        .getByRole("group", { name: "客户端订阅 Phone", exact: true })
        .getByRole("button", { name: "获取订阅", exact: true });
      await access.getByRole("button", { name: "关闭", exact: true }).click();
      await expect.soft(trigger).toBeFocused();
      await trigger.click();
      await expect
        .poll(() => access.evaluate(surfaceMotionState))
        .toMatchObject({ preparing: false, running: false, opacity: "1" });
      await page.keyboard.press("Escape");
      await expect.soft(trigger).toBeFocused();
      phase = "complete";
    } finally {
      await writeFile(
        info.outputPath("focus-events.json"),
        JSON.stringify(
          await page
            .evaluate(() => ({
              events: (window as unknown as { rotationFocus: unknown[] })
                .rotationFocus,
              active: {
                tag: document.activeElement?.tagName,
                name:
                  document.activeElement?.getAttribute("aria-label") ||
                  document.activeElement?.textContent?.slice(0, 100),
              },
              dialogs: [...document.querySelectorAll('[role="dialog"]')].map(
                (element) => ({
                  visible: (element as HTMLElement).offsetParent !== null,
                  text: element.textContent?.slice(0, 100),
                }),
              ),
            }))
            .catch((error) => ({ unavailable: String(error) })),
          null,
          2,
        ),
      );
      await writeFile(
        info.outputPath("journey.json"),
        JSON.stringify(
          {
            phase,
            reducedMotion,
            focusCheckpoints,
            writes: f.writes,
            unexpected: f.unexpected,
            errors: f.errors,
            reads: f.reads(),
          },
          null,
          2,
        ),
      );
    }
  });

test("late blocked access cannot restore the previous account task at 390px", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await ownerFixture(page),
    release = f.hold();
  try {
    await page.goto("/#subscriptions");
    await openPhone(page, true);
    await expect.poll(f.reads).toBe(1);
    f.changeAccount();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("dialog", { name: "获取「Phone」", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "客户端订阅 Phone", exact: true }),
    ).toHaveCount(0);
    f.ready("OUTPUT_REPUBLISH_REQUIRED");
    release();
    await expect(page.getByText("此订阅需要更新", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("dialog", { name: "检查订阅更新「Phone」", exact: true }),
    ).toHaveCount(0);
    expect(f.writes).toHaveLength(0);
    expect(f.unexpected).toEqual([]);
    expect(f.errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath("new-account-no-stale-task-390.png"),
    });
  } finally {
    release();
    await writeFile(
      info.outputPath("journey.json"),
      JSON.stringify(
        { writes: f.writes, unexpected: f.unexpected, errors: f.errors },
        null,
        2,
      ),
    );
  }
});
