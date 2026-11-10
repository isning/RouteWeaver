import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { openWorkspace } from "./ui-session";
import { surfaceMotionState } from "./ui-surface-stability";
import type { Source } from "../src/types";

// Explicit captures contain only synthetic, pre-publication business state.
// Candidate/diagnostic and save-failure injections are named below; happy paths
// use the real local HTTP/domain service, not a mocked application module.
test.use({ trace: "off", screenshot: "off" });

// Each case owns only IDs it created. Cleanup also runs after an assertion
// fails, so one collection task cannot contaminate the prior empty/refresh suite.
const fixtures = new WeakMap<
  Page,
  { paths: Set<string>; captures: Promise<void>[] }
>();
function rememberFixture(
  page: Page,
  kind: "sources" | "collections",
  id: string,
) {
  fixtures.get(page)!.paths.add(`${kind}/${id}`);
}
test.beforeEach(async ({ page }) => {
  const owned = { paths: new Set<string>(), captures: [] as Promise<void>[] };
  fixtures.set(page, owned);
  page.on("response", (response) => {
    const match = new URL(response.url()).pathname.match(
      /^\/api\/me\/(sources|collections)$/,
    );
    if (!match || response.request().method() !== "POST" || !response.ok())
      return;
    owned.captures.push(
      response.json().then((value) => {
        if (typeof value.id !== "string" || !value.id)
          throw new Error("Created fixture has no identity");
        rememberFixture(page, match[1] as "sources" | "collections", value.id);
      }),
    );
  });
});
test.afterEach(async ({ page }) => {
  const owned = fixtures.get(page)!;
  await Promise.all(owned.captures);
  if (owned.paths.size)
    await remove(
      page,
      [...owned.paths].sort(
        (a, b) =>
          Number(b.startsWith("collections/")) -
          Number(a.startsWith("collections/")),
      ),
    );
});

const requestEvidence = new WeakMap<
  Page,
  {
    pending: Map<import("@playwright/test").Request, string>;
    responses: { method: string; path: string; status: number }[];
  }
>();
test.beforeEach(async ({ page }) => {
  const evidence = {
    pending: new Map<import("@playwright/test").Request, string>(),
    responses: [] as { method: string; path: string; status: number }[],
  };
  requestEvidence.set(page, evidence);
  const path = (r: import("@playwright/test").Request) =>
    new URL(r.url()).pathname;
  page.on("request", (r) => {
    if (path(r).startsWith("/api/me/"))
      evidence.pending.set(r, `${r.method()} ${path(r)}`);
  });
  page.on("requestfinished", (r) => evidence.pending.delete(r));
  page.on("requestfailed", (r) => evidence.pending.delete(r));
  page.on("response", (r) => {
    if (path(r.request()).startsWith("/api/me/"))
      evidence.responses.push({
        method: r.request().method(),
        path: path(r.request()),
        status: r.status(),
      });
  });
});

async function read(page: Page, path: string) {
  const response = await page.request.get(`/api/me/${path}`);
  expect(response.ok(), `Read ${path}`).toBe(true);
  return response.json();
}
async function headers(page: Page) {
  const response = await page.request.get("/api/auth/me");
  expect(response.ok()).toBe(true);
  return { "X-CSRF-Token": (await response.json()).csrfToken };
}
async function inventory(page: Page) {
  return {
    collections: await read(page, "collections"),
    profiles: await read(page, "profiles"),
    outputs: await read(page, "outputs"),
  };
}
function writes(page: Page) {
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      /^(POST|PUT|PATCH|DELETE)$/.test(request.method()) &&
      /^\/api\/me\/(sources|collections|profiles|outputs)(?:\/|$)/.test(path) &&
      !path.endsWith("/preview")
    )
      paths.push(`${request.method()} ${path}`);
  });
  return paths;
}
async function choose(page: Page, control: Locator, name: string) {
  await control.click();
  await page.getByRole("option", { name, exact: true }).click();
  if (await page.getByRole("listbox").isVisible())
    await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
async function captureSurface(surface: Locator, label: string) {
  const animations = await surface.evaluate((el) =>
    el.getAnimations({ subtree: true }).map((a) => {
      const effect = a.effect as KeyframeEffect;
      const target = effect?.target as HTMLElement | null;
      const css = target ? getComputedStyle(target) : null;
      const ancestors = [];
      let parent = target?.parentElement;
      while (parent && ancestors.length < 5) {
        const c = getComputedStyle(parent);
        ancestors.push({
          tag: parent.tagName,
          classes: parent.getAttribute("class"),
          opacity: c.opacity,
          display: c.display,
          visibility: c.visibility,
          bounds: parent.getBoundingClientRect().toJSON(),
        });
        parent = parent.parentElement;
      }
      return {
        ancestors,
        properties: effect?.getKeyframes().map((k) => Object.keys(k)),
        name: (a as CSSAnimation).animationName,
        state: a.playState,
        timing: effect?.getComputedTiming(),
        iterations: String(effect?.getComputedTiming().iterations),
        target: target?.tagName,
        classes: target?.getAttribute("class"),
        display: css?.display,
        visibility: css?.visibility,
        opacity: css?.opacity,
        bounds: target?.getBoundingClientRect().toJSON(),
      };
    }),
  );
  const controls = await surface.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => ({
      text: button.textContent,
      classes: button.getAttribute("class"),
      ariaBusy: button.getAttribute("aria-busy"),
      disabled: (button as HTMLButtonElement).disabled,
      opacity: getComputedStyle(button).opacity,
      bounds: button.getBoundingClientRect().toJSON(),
    })),
  );
  const motionAncestors = await surface.evaluate((el) => {
    const result = [];
    let parent: Element | null = el;
    while (parent && result.length < 4) {
      result.push({
        classes: parent.getAttribute("class"),
        opacity: getComputedStyle(parent).opacity,
        transform: getComputedStyle(parent).transform,
        bounds: parent.getBoundingClientRect().toJSON(),
        animations: parent.getAnimations().map((a) => ({
          state: a.playState,
          name: (a as CSSAnimation).animationName,
          property: (a as CSSTransition).transitionProperty,
        })),
      });
      parent = parent.parentElement;
    }
    return result;
  });
  const layoutFrames = await surface.evaluate(async (el) => {
    const capture = () =>
      [el, ...el.querySelectorAll("button,input,[aria-controls]")].map(
        (node) => ({
          tag: node.tagName,
          text: node.tagName === "BUTTON" ? node.textContent : null,
          bounds: node.getBoundingClientRect().toJSON(),
        }),
      );
    const before = capture();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return { before, after: capture() };
  });
  const evidence = requestEvidence.get(surface.page())!;
  const diagnostic = {
    animations,
    controls,
    motionAncestors,
    layoutFrames,
    pendingRequests: [...evidence.pending.values()],
    responses: evidence.responses,
  };
  await test.info().attach(label, {
    body: JSON.stringify(diagnostic),
    contentType: "application/json",
  });
}
async function stableSurface(surface: Locator) {
  await expect(surface).toBeVisible();
  await surface.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  try {
    await expect
      .poll(() => surface.evaluate(surfaceMotionState))
      .toEqual({ opacity: "1", preparing: false, running: false });
  } catch (error) {
    await captureSurface(surface, "surface-animation-diagnostic");
    // Only this spec's synthetic, pre-publication collection/source surfaces.
    await surface.page().screenshot({
      path: test.info().outputPath("surface-animation-diagnostic.png"),
    });
    throw error;
  }
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath(name),
    animations: "disabled",
  });
}
async function newCollection(page: Page, name: string) {
  await page.goto("/#collections");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "新建集合", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "新建集合", exact: true });
  await stableSurface(drawer);
  await drawer.getByLabel("集合名称", { exact: true }).fill(name);
  return drawer;
}
function stage(drawer: Locator, name: string) {
  return drawer.getByRole("group", { name, exact: true });
}
function row(drawer: Locator, page: Page, order: number, name: string) {
  // Exact source identity scopes the disclosure; does not match cached dropdowns.
  return drawer
    .getByRole("button")
    .filter({ has: page.getByText(`${order}. ${name}`, { exact: true }) });
}
async function sourceTask(drawer: Locator, page: Page) {
  await drawer.getByRole("button", { name: "添加来源", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "添加订阅来源",
    exact: true,
  });
  await stableSurface(dialog);
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  return dialog;
}
async function privacyAndNativeForm(dialog: Locator) {
  const region = dialog.getByRole("group", {
    name: "来源导入确认",
    exact: true,
  });
  const privacy = region.locator(".privacy-note");
  for (const fact of [
    "订阅信息由平台解析",
    "加密保存",
    "仅供你的账号使用",
  ])
    await expect(privacy).toContainText(fact);
  await expect(privacy).toBeInViewport({ ratio: 1 });
  const submit = region.getByRole("button", {
    name: "导入来源",
    exact: true,
  });
  await expect(submit).toBeInViewport({ ratio: 1 });
  await expect(region.getByRole("button", { name: /取\s*消/ })).toBeInViewport({
    ratio: 1,
  });
  expect(
    await submit.evaluate((button) => {
      const input = document.querySelector<HTMLInputElement>(
        ".source-editor-modal input[id]",
      );
      return {
        type: (button as HTMLButtonElement).type,
        sameForm:
          !!input?.form && (button as HTMLButtonElement).form === input.form,
      };
    }),
  ).toEqual({ type: "submit", sameForm: true });
}
async function fillSource(dialog: Locator, name: string) {
  await dialog.getByLabel("来源名称", { exact: true }).fill(name);
  await dialog
    .getByLabel("节点链接或配置内容", { exact: true })
    .fill("socks5://context.example:1080#Context Synthetic");
}
async function returned(drawer: Locator, page: Page, name: string) {
  await expect(
    page.getByRole("dialog", { name: "添加订阅来源", exact: true }),
  ).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "添加来源", exact: true }),
  ).toBeFocused();
  await expect(drawer.getByLabel("集合名称", { exact: true })).toHaveValue(
    name,
  );
}
async function discardCollection(drawer: Locator, page: Page) {
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "放弃尚未保存的集合修改？",
    exact: true,
  });
  await expect(confirm).toContainText("已保存的来源会保留");
  await confirm.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(drawer).not.toBeVisible();
}
async function remove(page: Page, paths: string[]) {
  const owned = fixtures.get(page)!;
  await Promise.all(owned.captures);
  const csrf = await headers(page);
  for (const path of paths) {
    expect(
      (await page.request.delete(`/api/me/${path}`, { headers: csrf })).ok(),
      `Remove only fixture ${path}`,
    ).toBe(true);
    owned.paths.delete(path);
  }
}

for (const width of [1280, 390, 320]) {
  test(`contextual source initial pixels and natural focus return preserve unsaved collection at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await openWorkspace(page);
    const before = await inventory(page);
    const originalSources = await read(page, "sources");
    const suffix = `${width}-${Date.now().toString(36)}`;
    const collectionName = `保留集合草稿 ${suffix}`;
    const sourceName = `就地来源 ${suffix}`;
    const drawer = await newCollection(page, collectionName);
    await expect(
      drawer.getByText(
        originalSources.length ? "尚未选择来源" : "暂无可选来源",
        { exact: true },
      ),
    ).toBeVisible();
    const merged = stage(drawer, "合并后处理");
    await choose(
      page,
      merged.getByRole("combobox", { name: "添加处理步骤", exact: true }),
      "去除重复连接",
    );
    const observed = writes(page);
    const dialog = await sourceTask(drawer, page);
    // Observe initial layout before any trial click or pre-scroll.
    await privacyAndNativeForm(dialog);
    await shot(page, info, `collection-source-initial-${width}.png`);
    await fillSource(dialog, sourceName);
    let failedLists = 0;
    if (width === 1280) {
      // Explicit post-save list HTTP fault. The Source POST remains real. All
      // following browser list reads fail, so a friendly name cannot come from
      // waiting for a successful refetch or networkidle. API inventory is real.
      info.annotations.push({
        type: "synthetic-http-fault",
        description: "GET sources fails after real contextual POST",
      });
      let sourceWriteStarted = false;
      await page.route("**/api/me/sources", async (route) => {
        if (route.request().method() === "POST") sourceWriteStarted = true;
        if (route.request().method() === "GET" && sourceWriteStarted) {
          failedLists++;
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ detail: "合成故障：来源列表暂不可读取。" }),
          });
        }
        return route.continue();
      });
    }
    await dialog.getByRole("button", { name: "导入来源", exact: true }).click();
    await returned(drawer, page, collectionName);
    await expect(row(drawer, page, 1, sourceName)).toContainText("来源处理");
    await expect(
      merged.getByText("去除重复连接", { exact: true }),
    ).toBeVisible();
    await expect(drawer.getByText(/已配置/)).toHaveCount(0);
    expect(observed).toEqual(["POST /api/me/sources"]);
    expect(await inventory(page)).toEqual(before);
    const saved = (await read(page, "sources")).find(
      (source: { name: string }) => source.name === sourceName,
    );
    expect(saved.snapshot.endpoints).toHaveLength(1);
    await expect(
      drawer
        .locator('[data-slot="badge"]')
        .getByText(sourceName, { exact: true }),
    ).toBeVisible();
    await expect(drawer.getByText(saved.id, { exact: true })).toHaveCount(0);
    if (width === 1280) expect(failedLists).toBeGreaterThan(0);
    await shot(page, info, `collection-source-return-${width}.png`);
    await discardCollection(drawer, page);
    expect(await inventory(page)).toEqual(before);
    expect(
      (await read(page, "sources")).find(
        (source: { id: string }) => source.id === saved.id,
      ),
    ).toEqual(saved);
    expect(observed).toEqual(["POST /api/me/sources"]);
    // Reopening is genuinely new, not a secretly saved collection draft.
    await page
      .locator(".page-heading")
      .getByRole("button", { name: "新建集合", exact: true })
      .click();
    await expect(drawer.getByLabel("集合名称", { exact: true })).toHaveValue(
      "",
    );
    await expect(
      drawer.getByRole("button", {
        name: /^\d+\. .+ 来源处理(?: 已配置 \d+ 步)?$/,
      }),
    ).toHaveCount(0);
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await remove(page, [`sources/${saved.id}`]);
    expect(await read(page, "sources")).toEqual(originalSources);
  });
}

test("source acquisition preserves ordered source and merged steps until explicit collection save and reopened summaries", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWorkspace(page);
  const before = await inventory(page);
  const originals = await read(page, "sources");
  const csrf = await headers(page);
  const suffix = Date.now().toString(36);
  const names = [`北区线路 ${suffix}`, `南区线路 ${suffix}`];
  const sources: Array<{ id: string; name: string }> = [];
  for (const [i, name] of names.entries()) {
    const response = await page.request.post("/api/me/sources", {
      headers: csrf,
      data: {
        id: `collection-seam-${suffix}-${i}`,
        name,
        kind: "text",
        enabled: true,
        content: `socks5://stage${i}.example:1080#Stage ${i}`,
      },
    });
    expect(response.ok()).toBe(true);
    sources.push(await response.json());
    rememberFixture(page, "sources", sources[sources.length - 1].id);
  }
  const name = "差旅连接";
  const drawer = await newCollection(page, name);
  const selector = drawer.getByRole("combobox", {
    name: "订阅来源",
    exact: true,
  });
  for (const source of sources) await choose(page, selector, source.name);
  await row(drawer, page, 1, sources[0].name).click();
  const perSource = stage(drawer, "来源处理");
  await choose(
    page,
    perSource.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "重新命名",
  );
  await perSource
    .getByLabel("步骤 1 命名模板", { exact: true })
    .fill("{name} · 常用");
  await choose(
    page,
    perSource.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "去除重复连接",
  );
  await perSource
    .getByRole("switch", { name: "启用步骤 2", exact: true })
    .click();
  await expect(
    perSource.getByRole("switch", { name: "启用步骤 2", exact: true }),
  ).not.toBeChecked();
  await row(drawer, page, 1, sources[0].name).click();
  const merged = stage(drawer, "合并后处理");
  await choose(
    page,
    merged.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "去除重复连接",
  );
  await drawer.getByRole("button", { name: "下移来源 1", exact: true }).click();
  await expect(row(drawer, page, 2, sources[0].name)).toContainText(
    "来源处理 已配置 2 步",
  );
  const observed = writes(page);
  const dialog = await sourceTask(drawer, page);
  const addedName = "备用线路";
  await fillSource(dialog, addedName);
  // Keyboard activation exercises the preserved native submit/form association.
  await dialog
    .getByRole("button", { name: "导入来源", exact: true })
    .press("Enter");
  await returned(drawer, page, name);
  const added = (await read(page, "sources")).find(
    (source: { name: string }) => source.name === addedName,
  );
  await expect(row(drawer, page, 1, sources[1].name)).toBeVisible();
  await expect(row(drawer, page, 2, sources[0].name)).toContainText(
    "来源处理 已配置 2 步",
  );
  await expect(row(drawer, page, 3, addedName)).toBeVisible();
  expect(observed).toEqual(["POST /api/me/sources"]);
  expect(await inventory(page)).toEqual(before);
  // The parent selection is the completion feedback; no redundant toast may
  // cover the retained collection's Save footer.
  await expect(page.getByText("来源已添加", { exact: true })).not.toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(row(drawer, page, 2, sources[0].name)).toContainText(
      "来源处理 已配置 2 步",
    );
    await shot(page, info, `collection-context-return-rich-${width}.png`);
  }
  // Preview exposes the unsaved public recipe without persisting it.
  const preview = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/me/collections/preview",
  );
  await drawer
    .getByRole("button", { name: "预览处理结果", exact: true })
    .click();
  const recipe = (await preview).postDataJSON();
  expect(recipe.name).toBe(name);
  expect(
    recipe.sources.map((source: { sourceId: string }) => source.sourceId),
  ).toEqual([sources[1].id, sources[0].id, added.id]);
  expect(recipe.sources[1].steps).toEqual([
    expect.objectContaining({
      kind: "rename",
      enabled: true,
      template: "{name} · 常用",
    }),
    expect.objectContaining({ kind: "deduplicate", enabled: false }),
  ]);
  expect(recipe.steps).toEqual([
    expect.objectContaining({ kind: "deduplicate", enabled: true }),
  ]);
  await expect(drawer.getByText("逐阶段预览", { exact: true })).toBeVisible();
  expect(await inventory(page)).toEqual(before);
  await drawer.getByRole("button", { name: "保存集合", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  expect(observed).toEqual([
    "POST /api/me/sources",
    "POST /api/me/collections",
  ]);
  const saved = (await read(page, "collections")).find(
    (collection: { name: string }) => collection.name === name,
  );
  // Persistence normalizes absent override to {}; the authored ordered recipe
  // and every step identity/value must survive unchanged.
  expect(saved.sources).toMatchObject(recipe.sources);
  expect(saved.steps).toMatchObject(recipe.steps);
  expect(await read(page, "profiles")).toEqual(before.profiles);
  expect(await read(page, "outputs")).toEqual(before.outputs);
  await page
    .getByRole("button", {
      name: `${name} ${saved.sources.length} 个来源 ${saved.steps.length} 个聚合步骤 编辑集合`,
      exact: true,
    })
    .click();
  const reopened = page.getByRole("dialog", { name, exact: true });
  await stableSurface(reopened);
  const reopenedSave = reopened.getByRole("button", {
    name: "保存集合",
    exact: true,
  });
  await expect(reopenedSave).toBeEnabled();
  await expect(reopenedSave).not.toHaveAttribute("aria-busy", "true");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const summary = row(reopened, page, 2, sources[0].name);
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(summary).toContainText("来源处理 已配置 2 步");
    await expect(
      summary.getByText("来源处理 已配置 2 步", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      reopened.getByRole("button", { name: "上移来源 2", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    if (width < 600) {
      for (const control of [
        reopened.getByRole("button", { name: "添加来源", exact: true }),
        reopened.getByRole("button", { name: "上移来源 2", exact: true }),
        reopened.getByRole("button", { name: "下移来源 2", exact: true }),
      ]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
    }
    await shot(page, info, `collection-reopened-counts-${width}.png`);
  }
  await row(reopened, page, 2, sources[0].name).press("Enter");
  const reopenedStage = stage(reopened, "来源处理");
  await expect(
    reopenedStage.getByLabel("步骤 1 命名模板", { exact: true }),
  ).toHaveValue("{name} · 常用");
  await expect(
    reopenedStage.getByRole("switch", { name: "启用步骤 2", exact: true }),
  ).not.toBeChecked();
  await reopened.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(reopened).not.toBeVisible();
  await remove(page, [
    `collections/${saved.id}`,
    ...[...sources, added].map((source) => `sources/${source.id}`),
  ]);
  expect(await read(page, "sources")).toEqual(originals);
});

test("synthetic source-save HTTP failure retains uncertainty, parent recipe and cancellation guards", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  const before = await inventory(page);
  const sources = await read(page, "sources");
  const name = `未保存集合 ${Date.now().toString(36)}`;
  const drawer = await newCollection(page, name);
  const merged = stage(drawer, "合并后处理");
  await choose(
    page,
    merged.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "去除重复连接",
  );
  const observed = writes(page);
  const dialog = await sourceTask(drawer, page);
  await fillSource(dialog, "失败后保留的合成来源");
  // Explicit HTTP-boundary fault, not a real backend outage and not a timed delay.
  await page.route("**/api/me/sources", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "合成故障：服务暂时不可用。" }),
    });
  });
  await dialog.getByRole("button", { name: "导入来源", exact: true }).click();
  await expect(
    dialog.getByText("合成故障：服务暂时不可用。", { exact: true }),
  ).toBeVisible();
  await expect(drawer).not.toBeVisible();
  await expect(dialog.getByLabel("来源名称", { exact: true })).toHaveValue(
    "失败后保留的合成来源",
  );
  expect(await read(page, "sources")).toEqual(sources);
  await dialog.getByRole("button", { name: /取\s*消/ }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "关闭来源编辑？",
    exact: true,
  });
  await expect(confirm).toContainText("尚未确认上次提交是否已保存");
  await expect(confirm).toContainText("关闭不会撤销已提交的来源输入");
  await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await expect(
    dialog.getByLabel("节点链接或配置内容", { exact: true }),
  ).toHaveValue("socks5://context.example:1080#Context Synthetic");
  await dialog.getByRole("button", { name: /取\s*消/ }).click();
  await confirm.getByRole("button", { name: "关闭编辑", exact: true }).click();
  await returned(drawer, page, name);
  await expect(merged.getByText("去除重复连接", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  const parent = page.getByRole("alertdialog", {
    name: "放弃尚未保存的集合修改？",
    exact: true,
  });
  await parent.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(parent).not.toBeVisible();
  await expect(drawer.getByLabel("集合名称", { exact: true })).toHaveValue(
    name,
  );
  await shot(page, info, "collection-cancel-retained-390.png");
  expect(observed).toEqual(["POST /api/me/sources"]);
  expect(await inventory(page)).toEqual(before);
  expect(await read(page, "sources")).toEqual(sources);
  await discardCollection(drawer, page);
});

for (const abnormal of ["candidate", "failed"] as const) {
  test(`synthetic ${abnormal} response stays unselected with honest saved status and same-draft recovery`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openWorkspace(page);
    const before = await inventory(page);
    const sources = await read(page, "sources");
    const name = `异常返回集合 ${abnormal} ${Date.now().toString(36)}`;
    const sourceName = `待检查合成来源 ${abnormal}`;
    const diagnostic = "第 2 行：合成诊断：第二行连接尚需检查。";
    const recoveryMessage = "订阅未能完整导入。请检查内容后重试。";
    const drawer = await newCollection(page, name);
    const merged = stage(drawer, "合并后处理");
    await choose(
      page,
      merged.getByRole("combobox", { name: "添加处理步骤", exact: true }),
      "去除重复连接",
    );
    info.annotations.push({
      type: "synthetic-http-state",
      description:
        "Real Source POST persists an accepted snapshot; only this exact source's browser POST and subsequent summary/reveal/list reads inject a consistent candidate or failed-import state. APIRequestContext reads retain actual server truth. No parser/decision claim.",
    });
    let injectedSourceID: string | undefined;
    const injectState = (source: Source) => ({
      ...source,
      ...(abnormal === "candidate"
        ? {
            candidate: {
              id: "synthetic-candidate",
              createdAt: "2026-10-23T00:00:00Z",
              diff: {
                added: [],
                removed: (source.snapshot?.endpoints || []).map((endpoint) => ({
                  id: endpoint.id,
                  name: endpoint.name,
                })),
                connectionChanged: [],
                renamed: [],
                beforeCount: source.snapshot?.endpoints.length || 0,
                afterCount: 0,
              },
              affected: [],
            },
            refreshStatus: "review-required",
          }
        : {
            refreshStatus: "failed",
            lastError: diagnostic,
            lastErrorCode: "source_import_incomplete",
            diagnostics: [
              { line: 2, message: "合成诊断：第二行连接尚需检查。" },
            ],
          }),
    });
    // The owning recovery task rereads both summary and private input. Keep this
    // declared synthetic state consistent through those reads instead of having
    // an accepted GET silently replace the POST-only failure fixture.
    await page.route(
      /\/api\/me\/sources(?:\/[^/?]+(?:\/reveal)?)?$/,
      async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const create =
          request.method() === "POST" && path === "/api/me/sources";
        const readInjected =
          request.method() === "GET" &&
          injectedSourceID &&
          (path === "/api/me/sources" ||
            path === `/api/me/sources/${injectedSourceID}` ||
            path === `/api/me/sources/${injectedSourceID}/reveal`);
        if (!create && !readInjected) return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        const data = await response.json();
        if (create) injectedSourceID = data.id;
        await route.fulfill({
          response,
          json: Array.isArray(data)
            ? data.map((source: Source) =>
                source.id === injectedSourceID ? injectState(source) : source,
              )
            : injectState(data),
        });
      },
    );
    const observed = writes(page);
    const dialog = await sourceTask(drawer, page);
    await fillSource(dialog, sourceName);
    await dialog.getByRole("button", { name: "导入来源", exact: true }).click();
    const review = page.getByRole("dialog", { name: "查看变化", exact: true });
    // A pending manual source returns to its owner; inspecting it is optional.
    await expect(review).toHaveCount(0);
    expect(observed).toEqual(["POST /api/me/sources"]);
    expect(await inventory(page)).toEqual(before);
    await returned(drawer, page, name);
    const notice = drawer
      .getByRole("alert")
      .filter({ hasText: "来源尚未加入集合" });
    const savedMessage = `「${sourceName}」已单独保存，尚未加入当前集合。`;
    await expect(notice).toContainText(savedMessage);
    if (abnormal === "failed") {
      await expect(notice).toContainText(recoveryMessage);
      await expect(notice).not.toContainText(diagnostic);
    }
    await expect(
      drawer.getByRole("button", {
        name: /^\d+\. .+ 来源处理(?: 已配置 \d+ 步)?$/,
      }),
    ).toHaveCount(0);
    const recovery = notice.getByRole("button", {
      name: abnormal === "candidate" ? "查看变化" : "继续编辑",
      exact: true,
    });
    const lastMessage = notice.getByText(
      abnormal === "failed" ? recoveryMessage : savedMessage,
      { exact: true },
    );
    const messageBox = await lastMessage.boundingBox();
    const actionBox = await recovery.boundingBox();
    expect(messageBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    // At 320px recovery follows the readable full-width message instead of
    // squeezing saved-state/failure text into a narrow column beside it.
    expect(actionBox!.y).toBeGreaterThanOrEqual(
      messageBox!.y + messageBox!.height - 1,
    );
    await shot(page, info, `collection-${abnormal}-unselected-320.png`);
    // Recovery stays in this same draft; it no longer navigates to Sources.
    await recovery.press("Enter");
    await expect(drawer).not.toBeVisible();
    await expect(page).toHaveURL(/#collections$/);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    if (abnormal === "candidate") {
      await expect(review.getByLabel("来源检查摘要")).toBeFocused();
      await expect(review).toContainText(sourceName);
      await expect(review).toContainText("应用后将移除这个来源的全部选项");
      await expect(
        review.getByRole("button", { name: "应用更新", exact: true }),
      ).toBeEnabled();
      expect(observed).toEqual(["POST /api/me/sources"]);
      await review.screenshot({
        path: info.outputPath("optional-candidate-review-320.png"),
        animations: "disabled",
      });
      await review
        .getByRole("button", { name: "稍后处理", exact: true })
        .click();
    } else {
      const correction = page.getByRole("dialog", {
        name: "编辑来源",
        exact: true,
      });
      await expect(
        correction.getByLabel("来源名称", { exact: true }),
      ).toHaveValue(sourceName);
      await expect(
        correction.getByLabel("节点链接或配置内容", { exact: true }),
      ).toHaveValue("socks5://context.example:1080#Context Synthetic");
      await correction
        .getByLabel("来源名称", { exact: true })
        .fill(`${sourceName} 未提交修改`);
      await correction.getByRole("button", { name: /取\s*消/ }).click();
      const guard = page.getByRole("alertdialog", {
        name: "放弃尚未保存的来源修改？",
        exact: true,
      });
      await expect(guard).toContainText("已保存的来源输入会保留");
      await guard
        .getByRole("button", { name: "继续编辑", exact: true })
        .click();
      await expect(guard).not.toBeVisible();
      await expect(
        correction.getByLabel("来源名称", { exact: true }),
      ).toHaveValue(`${sourceName} 未提交修改`);
      await correction.getByRole("button", { name: /取\s*消/ }).click();
      await guard
        .getByRole("button", { name: "放弃修改", exact: true })
        .click();
      await expect(correction).not.toBeVisible();
    }
    await expect(drawer).toBeVisible();
    await expect(recovery).toBeFocused();
    await expect(drawer.getByLabel("集合名称", { exact: true })).toHaveValue(
      name,
    );
    await expect(
      merged.getByText("去除重复连接", { exact: true }),
    ).toBeVisible();
    await expect(notice).toContainText(savedMessage);
    if (abnormal === "failed")
      await expect(notice).toContainText(recoveryMessage);
    await expect(
      drawer.getByRole("button", {
        name: /^\d+\. .+ 来源处理(?: 已配置 \d+ 步)?$/,
      }),
    ).toHaveCount(0);
    // The retained parent recipe remains empty; only the original Source POST
    // was written. Neither defer, resume nor canceled local correction writes.
    const preview = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/me/collections/preview",
    );
    await drawer
      .getByRole("button", { name: "预览处理结果", exact: true })
      .click();
    const recipe = (await preview).postDataJSON();
    expect(recipe.name).toBe(name);
    expect(recipe.sources).toEqual([]);
    expect(recipe.steps).toEqual([
      expect.objectContaining({ kind: "deduplicate", enabled: true }),
    ]);
    expect(observed).toEqual(["POST /api/me/sources"]);
    expect(await inventory(page)).toEqual(before);
    const saved = (await read(page, "sources")).find(
      (source: { name: string }) => source.name === sourceName,
    );
    expect(saved.snapshot.endpoints).toHaveLength(1);
    await discardCollection(drawer, page);
    expect(await inventory(page)).toEqual(before);
    expect(
      (await read(page, "sources")).find(
        (source: { id: string }) => source.id === saved.id,
      ),
    ).toEqual(saved);
    await remove(page, [`sources/${saved.id}`]);
    expect(await read(page, "sources")).toEqual(sources);
  });
}

test("synthetic informational diagnostic does not misclassify an accepted source as failed", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openWorkspace(page);
  const before = await inventory(page);
  const sources = await read(page, "sources");
  const suffix = Date.now().toString(36);
  const name = `诊断不等于失败 ${suffix}`;
  const sourceName = `已接受合成来源 ${suffix}`;
  const drawer = await newCollection(page, name);
  const merged = stage(drawer, "合并后处理");
  await choose(
    page,
    merged.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "去除重复连接",
  );
  info.annotations.push({
    type: "synthetic-http-state",
    description:
      "Only informational diagnostics added to the real accepted Source POST response; no failed status or lastError.",
  });
  await page.route("**/api/me/sources", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        diagnostics: [{ line: 2, message: "合成提示：已提取受支持的连接。" }],
      },
    });
  });
  const observed = writes(page);
  const dialog = await sourceTask(drawer, page);
  await fillSource(dialog, sourceName);
  await dialog
    .getByRole("button", { name: "导入来源", exact: true })
    .press("Enter");
  await returned(drawer, page, name);
  await expect(row(drawer, page, 1, sourceName)).toBeVisible();
  await expect(
    drawer.getByRole("button", {
      name: /^\d+\. .+ 来源处理(?: 已配置 \d+ 步)?$/,
    }),
  ).toHaveCount(1);
  await expect(
    drawer.getByText("来源尚未加入集合", { exact: true }),
  ).toHaveCount(0);
  await expect(merged.getByText("去除重复连接", { exact: true })).toBeVisible();
  const saved = (await read(page, "sources")).find(
    (source: { name: string }) => source.name === sourceName,
  );
  expect(saved.snapshot.endpoints).toHaveLength(1);
  const preview = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/me/collections/preview",
  );
  await drawer
    .getByRole("button", { name: "预览处理结果", exact: true })
    .click();
  const recipe = (await preview).postDataJSON();
  expect(recipe.name).toBe(name);
  expect(recipe.sources).toEqual([{ sourceId: saved.id, steps: [] }]);
  expect(recipe.steps).toEqual([
    expect.objectContaining({ kind: "deduplicate", enabled: true }),
  ]);
  expect(observed).toEqual(["POST /api/me/sources"]);
  expect(await inventory(page)).toEqual(before);
  await shot(page, info, "collection-informational-diagnostic-320.png");
  await discardCollection(drawer, page);
  expect(await inventory(page)).toEqual(before);
  expect(
    (await read(page, "sources")).find(
      (source: { id: string }) => source.id === saved.id,
    ),
  ).toEqual(saved);
  await remove(page, [`sources/${saved.id}`]);
  expect(await read(page, "sources")).toEqual(sources);
});
