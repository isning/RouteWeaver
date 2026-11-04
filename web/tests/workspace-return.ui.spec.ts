import { navigateWorkspace } from "./ui-session";
import { test } from "./native-browser";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import { expect, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:4173";
const search = (p: Page) =>
  p.getByRole("textbox", { name: "搜索配置或客户端订阅" });
const heading = (p: Page, name: string) =>
  p.getByRole("heading", { name, exact: true, level: 1 });
async function login(p: Page) {
  await p.goto(origin);
  await p.getByLabel("账号", { exact: true }).fill("routeweaver");
  await p.getByLabel("密码", { exact: true }).fill("local-demo-password");
  await p.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await waitForConfirmedWorkspace(p, "normal-ui-login");
}
async function api(p: Page, path: string, data?: unknown) {
  const result = await p.evaluate(
    async ({ path, data }) => {
      const session = await (await fetch("/api/auth/me")).json();
      const r = await fetch(
        "/api" + path,
        data === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": session.csrfToken,
              },
              body: JSON.stringify(data),
            },
      );
      return { ok: r.ok, value: await r.json() };
    },
    { path, data },
  );
  expect(result.ok, `Synthetic fixture ${path}`).toBe(true);
  return result.value;
}
async function seed(p: Page, count: number) {
  const prefix = "Return " + Date.now().toString(36);
  const profiles = [];
  for (let i = 0; i < count; i++) {
    const id = `return-${Date.now()}-${i}`;
    const name = prefix + " " + String(i).padStart(2, "0");
    profiles.push(
      await api(p, "/me/profiles", {
        id,
        name,
        target: { adapterId: "mihomo", version: "1.19.32" },
        mode: "full",
        sourceIds: [],
        ir: {
          schemaVersion: "1.0",
          id,
          name,
          ownerId: "",
          revision: "1",
          endpoints: [],
          groups: [],
          rules: [],
          resources: [],
          defaultAction: { kind: "direct" },
          runtime: { mixedPort: 7890 },
        },
      }),
    );
  }
  const profile = profiles[Math.min(11, count - 1)];
  const output = await api(p, "/me/outputs", {
    id: "return-output-" + Date.now(),
    name: "Laptop " + prefix,
    profileId: profile.id,
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
  });
  await p.reload();
  await expect(search(p)).toBeVisible();
  return { prefix, profiles, profile, output };
}
async function nav(p: Page, _group: string, name: string) {
  await navigateWorkspace(p, name);
  await expect(heading(p, name)).toBeVisible();
}
async function scrollY(p: Page) {
  return p.evaluate(() => window.scrollY);
}
async function proof(p: Page) {
  return p.evaluate(() => ({
    hash: location.hash,
    state: history.state,
    length: history.length,
  }));
}
async function privacy(p: Page, value: string) {
  expect(
    await p.evaluate(
      () =>
        location.href +
        JSON.stringify(history.state) +
        JSON.stringify(localStorage) +
        JSON.stringify(sessionStorage),
    ),
  ).not.toContain(value);
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("actual subscription search page and scroll survive materials detour without serialized search", async ({
  page,
}, info) => {
  await login(page);
  const f = await seed(page, 23);
  await search(page).fill(f.prefix);
  await page
    .getByRole("navigation", { name: "配置清单分页" })
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await expect(
    page.getByRole("article", {
      name: "分流配置 " + f.profiles[10].name,
      exact: true,
    }),
  ).toBeVisible();
  await page.mouse.move(1000, 600);
  await page.mouse.wheel(0, 580);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(200);
  // Wheel delivery is asynchronous; observe stable rendered scroll before bookmarking.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = scrollY,
          stable = 0;
        const frame = () => {
          stable = scrollY === last ? stable + 1 : 0;
          last = scrollY;
          if (stable >= 12) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  const before = await scrollY(page);
  await privacy(page, f.prefix);
  await nav(page, "订阅素材", "订阅来源");
  await nav(page, "订阅与分流", "我的订阅");
  await expect(search(page)).toHaveValue(f.prefix);
  await expect(
    page.getByRole("article", {
      name: "分流配置 " + f.profiles[10].name,
      exact: true,
    }),
  ).toBeAttached();
  await info.attach("scroll-observation", {
    body: JSON.stringify({ before, after: await scrollY(page) }),
    contentType: "application/json",
  });
  await expect
    .poll(async () => Math.abs((await scrollY(page)) - before))
    .toBeLessThan(3);
  await privacy(page, f.prefix);
  await page.screenshot({
    path: info.outputPath("subscription-return-restored.png"),
  });
  await info.attach("safe-result", {
    body: JSON.stringify({
      task: "search/page/real-scroll return",
      before,
      after: await scrollY(page),
      searchNotSerialized: true,
    }),
    contentType: "application/json",
  });
});

test("Output owned Back Forward restores exact trigger and position; direct link Close stays inside app", async ({
  page,
  context,
}, info) => {
  await login(page);
  const f = await seed(page, 23);
  await search(page).fill(f.prefix);
  await page
    .getByRole("navigation", { name: "配置清单分页" })
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  const trigger = page.getByRole("button", {
    name: "查看订阅 " + f.output.name,
    exact: true,
  });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  const before = await scrollY(page);
  const list = await proof(page);
  await trigger.click();
  const detail = page.getByRole("dialog", {
    name: f.output.name + " 的订阅详情",
    exact: true,
  });
  await expect(detail).toBeVisible();
  const detailProof = await proof(page);
  expect(detailProof.state.routeweaverPosition).toBe(
    list.state.routeweaverPosition + 1,
  );
  await page.goBack();
  await expect(detail).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect
    .poll(async () => Math.abs((await scrollY(page)) - before))
    .toBeLessThan(3);
  const triggerInViewport = await trigger.evaluate((n) => {
    const r = n.getBoundingClientRect();
    return (
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= innerHeight &&
      r.right <= innerWidth
    );
  });
  expect(triggerInViewport).toBe(true);
  expect((await proof(page)).state).toEqual(list.state);
  await page.goForward();
  await expect(detail).toBeVisible();
  expect((await proof(page)).state).toEqual(detailProof.state);
  await page.goBack();
  await expect(detail).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(search(page)).toHaveValue(f.prefix);
  expect((await proof(page)).state).toEqual(list.state);
  await expect
    .poll(async () => Math.abs((await scrollY(page)) - before))
    .toBeLessThan(3);
  await page.goto(
    origin + "/#subscriptions?profile=" + encodeURIComponent(f.profile.id),
  );
  await search(page).fill("no-match-in-memory");
  await nav(page, "订阅素材", "订阅来源");
  // A same-document deep link re-enters the SAME remembered profile scope.

  await page.goto(
    origin +
      "/#subscriptions?profile=" +
      encodeURIComponent(f.profile.id) +
      "&output=" +
      encodeURIComponent(f.output.id),
  );
  await expect(detail).toBeVisible();
  await expect(
    detail.getByText("分流配置：" + f.profile.name, { exact: true }),
  ).toBeVisible();
  // The modal correctly excludes the background from the accessibility tree.
  // Verify remembered list state only after its real Close action restores it.
  await expect(search(page)).toHaveCount(0);
  const rememberedDetail = await proof(page);
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(detail).not.toBeVisible();
  expect((await proof(page)).length).toBe(rememberedDetail.length);
  expect(page.url()).toContain(
    "#subscriptions?profile=" + encodeURIComponent(f.profile.id),
  );
  expect(page.url()).not.toContain("output=");
  await expect(search(page)).toBeVisible();
  await expect(search(page)).toHaveValue("no-match-in-memory");
  const scopedProfile = page.getByRole("article", {
    name: "分流配置 " + f.profile.name,
    exact: true,
  });
  await expect(scopedProfile).toBeVisible();
  await expect(
    scopedProfile.getByText("没有匹配的客户端订阅。", { exact: true }),
  ).toBeVisible();
  await expect(
    scopedProfile.getByRole("button", {
      name: "查看订阅 " + f.output.name,
      exact: true,
    }),
  ).toHaveCount(0);
  await privacy(page, "no-match-in-memory");
  const direct = await context.newPage();
  await direct.goto(
    origin +
      "/#subscriptions?profile=" +
      encodeURIComponent(f.profile.id) +
      "&output=" +
      encodeURIComponent(f.output.id),
  );
  const directDetail = direct.getByRole("dialog", {
    name: f.output.name + " 的订阅详情",
    exact: true,
  });
  await expect(directDetail).toBeVisible();
  const directProof = await proof(direct);
  await directDetail.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(directDetail).not.toBeVisible();
  expect((await proof(direct)).length).toBe(directProof.length);
  expect(direct.url()).toContain("#subscriptions?profile=");
  expect(direct.url()).not.toContain("output=");
  await expect(heading(direct, "我的订阅")).toBeVisible();
  await expect(search(direct)).toHaveValue("");
  await expect(
    direct.getByRole("article", {
      name: "分流配置 " + f.profile.name,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    direct.getByRole("button", {
      name: "查看订阅 " + f.output.name,
      exact: true,
    }),
  ).toBeVisible();
  await direct.screenshot({
    path: info.outputPath("direct-output-close-scoped-list.png"),
  });
  await direct.close();
  await privacy(page, "no-match-in-memory");
  await info.attach("safe-result", {
    body: JSON.stringify({
      task: "Output history",
      exactTriggerFocus: true,
      triggerInViewport,
      scrollBefore: before,
      ownedPositionIncrement: 1,
      forwardSameID: true,
      directCloseReplaced: true,
      rememberedSearchAfterClose: true,
      explicitProfileRetainedDespiteNoMatch: true,
      newTabHasIndependentListMemory: true,
    }),
    contentType: "application/json",
  });
});

test("dirty native Back cancel preserves entry; paused routine auth defers confirmation and discard occurs once", async ({
  page,
}, info) => {
  await login(page);
  const initial = await proof(page);
  await nav(page, "订阅素材", "订阅来源");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "添加来源", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "添加订阅来源",
    exact: true,
  });
  const field = editor.getByLabel("来源名称", { exact: true });
  await field.fill("未保存的备用来源");
  const source = await proof(page);
  await page.goBack();
  const confirm = page.getByRole("alertdialog", {
    name: "放弃未保存的修改？",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(field).toHaveValue("未保存的备用来源");
  expect(await proof(page)).toEqual(source);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let intercepted!: () => void;
  const pending = new Promise<void>((r) => (intercepted = r));
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch({
      headers: await route.request().allHeaders(),
    });
    intercepted();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.evaluate(() => {
    (window as any).__trustedFocus = false;
    window.addEventListener("focus", (e) => {
      if (e.isTrusted) (window as any).__trustedFocus = true;
    });
  });
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  try {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe("hidden");
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
    await pending;
    await expect(page.locator("[data-session-workspace]")).toHaveAttribute(
      "inert",
      "",
    );
    expect(await page.evaluate(() => (window as any).__trustedFocus)).toBe(
      true,
    );
    await page.goBack();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => proof(page)).toEqual(source);
    await expect(field).toHaveValue("未保存的备用来源");
  } finally {
    release();
    await cdp.detach();
  }
  await expect(page.locator("[data-session-workspace]")).not.toHaveAttribute(
    "inert",
    "",
  );
  await page.unroute("**/api/auth/me");
  // Same-account routine recovery resumes the one still-valid Back intent.
  await expect(confirm).toBeVisible();
  await confirm
    .getByRole("button", { name: "放弃修改并离开", exact: true })
    .click();
  await expect(heading(page, "我的订阅")).toBeVisible();
  await expect(editor).not.toBeVisible();
  expect((await proof(page)).state).toEqual(initial.state);
  await page.goForward();
  await expect(heading(page, "订阅来源")).toBeVisible();
  expect((await proof(page)).state).toEqual(source.state);
  await expect(confirm).toHaveCount(0);
  await expect(editor).not.toBeVisible();
  await page.goBack();
  await expect(heading(page, "我的订阅")).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await info.attach("safe-result", {
    body: JSON.stringify({
      task: "dirty native Back and auth pause",
      cancelKeptEntry: true,
      trustedNativeFocus: true,
      noHiddenConfirmation: true,
      discardOnce: true,
      forwardIntact: true,
    }),
    contentType: "application/json",
  });
});
