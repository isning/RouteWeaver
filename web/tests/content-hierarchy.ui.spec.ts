import { sourceRowAction } from "./source-row-actions";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { openWorkspace } from "./ui-session";
import { surfaceMotionState } from "./ui-surface-stability";

// Runs inside the page; capture geometry without exposing displayed values.
function confirmationPointerGeometry(
  el: Element,
  point: { x: number; y: number },
) {
  const describe = (target: Element | null) =>
    target && {
      tag: target.tagName,
      slot: target.getAttribute("data-slot"),
      action: target.closest("button")?.getAttribute("aria-label") ?? null,
      box: target.getBoundingClientRect().toJSON(),
    };
  return {
    confirmation: describe(el),
    hit: describe(document.elementFromPoint(point.x, point.y)),
    stack: document
      .elementsFromPoint(point.x, point.y)
      .slice(0, 5)
      .map(describe),
    active: describe(document.activeElement),
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
  };
}

// Only synthetic pre-publication states are deliberately photographed. The
// explicit publish at the end can expose bearer links, so automatic capture is off.
test.use({ trace: "off", screenshot: "off" });

async function json(page: Page, path: string) {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `Read ${path} succeeds`).toBe(true);
  return response.json();
}
async function headers(page: Page) {
  return { "X-CSRF-Token": (await json(page, "/auth/me")).csrfToken };
}
async function decision(dialog: Locator) {
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
  await expect(
    region.getByRole("button", { name: "导入来源", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(region.getByRole("button", { name: /取\s*消/ })).toBeInViewport({
    ratio: 1,
  });
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}
async function openSource(page: Page) {
  await page.goto("/#sources");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "添加来源", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "添加订阅来源",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  // Do not trial-click or scroll an action: visibility on initial open is the contract.
  // Let the natural motion lifecycle reach its start before testing completion;
  // initial visibility can otherwise precede an appear/enter preparation frame.
  await dialog.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect
    .poll(() =>
      dialog.evaluate((el) => ({
        opacity: getComputedStyle(el).opacity,
        preparing: /(?:appear|enter|prepare)(?:-|\s|$)/.test(el.className),
        running: el
          .getAnimations({ subtree: true })
          .some((a) => a.playState === "running"),
      })),
    )
    .toEqual({ opacity: "1", preparing: false, running: false });
  return dialog;
}

for (const [width, height] of [
  [1280, 900],
  [390, 844],
  [320, 844],
]) {
  test(`source completion and privacy disclosure are together on initial open at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await openWorkspace(page);
    const before = await json(page, "/me/sources");
    const dialog = await openSource(page);
    await decision(dialog);
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(`source-initial-${width}.png`),
      animations: "disabled",
    });
    await dialog
      .getByLabel("来源名称", { exact: true })
      .fill("合成来源布局检查");
    const chooser = page.waitForEvent("filechooser");
    await dialog
      .getByRole("button", { name: "选择配置文件", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "synthetic-layout.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("socks5://layout.example:1080#Layout"),
    });
    await expect(
      dialog.getByLabel("节点链接或配置内容", { exact: true }),
    ).toHaveValue("socks5://layout.example:1080#Layout");
    await expect(dialog.getByRole("status")).toHaveText(
      "已读取文件：synthetic-layout.txt",
    );
    await expect(
      dialog.getByText(
        "文件先在本地读取，提交后才上传。仅提取受支持的连接内容。",
        { exact: true },
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "导入选项", exact: true }).click();
    await expect(
      dialog.getByRole("combobox", { name: "内容格式", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("switch", { name: "启用来源", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole("switch", { name: "启用来源", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await decision(dialog);
    expect(await json(page, "/me/sources")).toEqual(before);
    await page.screenshot({
      path: info.outputPath(`source-file-options-${width}.png`),
      animations: "disabled",
    });
    // A local file and expanded optional fields are still an uncommitted draft.
    await dialog.getByRole("button", { name: /取\s*消/ }).click();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(dialog.getByLabel("来源名称", { exact: true })).toHaveValue(
      "合成来源布局检查",
    );
    await expect(
      dialog.getByLabel("节点链接或配置内容", { exact: true }),
    ).toHaveValue("socks5://layout.example:1080#Layout");
    await dialog.getByRole("button", { name: /取\s*消/ }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await json(page, "/me/sources")).toEqual(before);
  });
}

test("short source task and doubled text retain native keyboard access without a covering footer", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await openWorkspace(page);
  const before = await json(page, "/me/sources");
  const dialog = await openSource(page);
  const container = dialog;
  // Shorter disclosure text can leave enough room for a separately scrolling
  // body. Verify the actual scroll owner and usable layout, not one CSS mode.
  const mode = await dialog.getAttribute("data-task-scroll");
  expect(["body", "task"]).toContain(mode);
  const body = dialog.locator("[data-task-overlay-body]");
  const scroller = mode === "task" ? dialog : body;
  await expect(scroller).toHaveCSS("overflow-y", "auto");
  const initialLayout = await dialog.evaluate((el) => {
    const body = el.querySelector<HTMLElement>("[data-task-overlay-body]")!;
    const header = el.querySelector<HTMLElement>("[data-task-overlay-header]")!;
    const footer = el.querySelector<HTMLElement>("[data-task-overlay-footer]")!;
    return {
      mode: el.getAttribute("data-task-scroll"),
      dialog: el.getBoundingClientRect().toJSON(),
      body: body.getBoundingClientRect().toJSON(),
      header: header.getBoundingClientRect().toJSON(),
      footer: footer.getBoundingClientRect().toJSON(),
      bodyClientHeight: body.clientHeight,
      viewportHeight: innerHeight,
    };
  });
  await info.attach("source-short-initial-scroll-layout", {
    body: JSON.stringify(initialLayout),
    contentType: "application/json",
  });
  expect(initialLayout.dialog.top).toBeGreaterThanOrEqual(0);
  expect(initialLayout.dialog.bottom).toBeLessThanOrEqual(
    initialLayout.viewportHeight,
  );
  expect(initialLayout.body.top).toBeGreaterThanOrEqual(
    initialLayout.header.bottom,
  );
  expect(initialLayout.footer.top).toBeGreaterThanOrEqual(
    initialLayout.body.bottom,
  );
  if (mode === "body") {
    expect(initialLayout.bodyClientHeight).toBeGreaterThanOrEqual(200);
    expect(initialLayout.footer.bottom).toBeLessThanOrEqual(
      initialLayout.dialog.bottom,
    );
  }
  // Reaching the last body control must genuinely move the selected scroller;
  // a clipped dialog with an inert or covered body cannot satisfy this check.
  const options = dialog.getByRole("button", { name: "导入选项", exact: true });
  await options.scrollIntoViewIfNeeded();
  await expect(options).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  const submit = dialog.getByRole("button", { name: "导入来源", exact: true });
  // The short-layout contract is sequential reachability, not permanently fixed completion.
  await submit.scrollIntoViewIfNeeded();
  await decision(dialog);
  await page.screenshot({
    path: info.outputPath("source-short-initial-decision.png"),
    animations: "disabled",
  });
  await submit.click();
  const name = dialog.getByLabel("来源名称", { exact: true });
  await name.scrollIntoViewIfNeeded();
  await expect(
    dialog.getByText("给来源取一个名称", { exact: true }),
  ).toBeVisible();
  await name.fill("短视口合成来源");
  // Text-only growth doubles the original computed text sizes, not the viewport.
  await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".source-editor-modal, .source-editor-modal *",
      ),
    );
    const sizes = nodes.map((node) =>
      parseFloat(getComputedStyle(node).fontSize),
    );
    nodes.forEach((node, i) => {
      node.style.fontSize = `${sizes[i] * 2}px`;
    });
  });
  await expect(container).toHaveAttribute("data-task-scroll", "task");
  await expect(container).toHaveCSS("overflow-y", "auto");
  await expect(body).toHaveCSS("overflow-y", "visible");
  await name.click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const content = dialog.getByLabel("节点链接或配置内容", { exact: true });
  await expect(content).toBeFocused();
  await page.keyboard.type("socks5://short.example:1080#Short");
  // The textarea can be taller than the viewport. Its focused first line must
  // be visible; demanding that the entire multiline control fit would hide the issue.
  const geometry = await content.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const footer = document
      .querySelector('[role="group"][aria-label="来源导入确认"]')!
      .getBoundingClientRect();
    const top = rect.top + parseFloat(getComputedStyle(el).paddingTop);
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    return {
      top,
      lineBottom: top + lineHeight,
      footerTop: footer.top,
      fieldBottom: rect.bottom,
      height: innerHeight,
    };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.lineBottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.fieldBottom);
  await page.screenshot({
    path: info.outputPath("source-short-text200-focus.png"),
    animations: "disabled",
  });
  await submit.scrollIntoViewIfNeeded();
  await decision(dialog);
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("source-short-text200-decision.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await submit.scrollIntoViewIfNeeded();
  await decision(dialog);
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("source-320-text200-decision.png"),
    animations: "disabled",
  });
  expect(await json(page, "/me/sources")).toEqual(before);
});

async function choose(page: Page, control: Locator, name: string) {
  await control.click();
  await page.getByRole("option").getByText(name, { exact: true }).click();
  if ((await control.getAttribute("aria-expanded")) === "true")
    await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

test("collection zero one and multiple source states retain preparation ordering and per-source processing", async ({
  page,
}, info) => {
  await openWorkspace(page);
  const originalSources = await json(page, "/me/sources");
  await page.goto("/#collections");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "新建集合", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "新建集合", exact: true });
  const sourceControl = drawer.getByRole("combobox", {
    name: "订阅来源",
    exact: true,
  });
  await expect(sourceControl).toBeVisible();
  await expect(
    drawer.getByText(originalSources.length ? "尚未选择来源" : "暂无可选来源", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    drawer.getByText(
      /按此顺序合并|保留所有节点|添加步骤，开始整理|未添加处理步骤/,
    ),
  ).toHaveCount(0);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await sourceControl.scrollIntoViewIfNeeded();
    const save = drawer.getByRole("button", { name: "保存集合", exact: true });
    await expect(save).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () => (await save.boundingBox())?.height || 0)
      .toBeGreaterThanOrEqual(44);
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(`collection-zero-${width}.png`),
      animations: "disabled",
    });
  }
  await choose(
    page,
    drawer.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "去除重复连接",
  );
  await expect(
    drawer.getByRole("switch", { name: "启用步骤 1", exact: true }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  // Setup only: this journey tests collection membership, not source import.
  const csrf = await headers(page);
  const suffix = Date.now().toString(36);
  const sources: Array<{ id: string; name: string }> = [];
  for (const name of ["North", "South"]) {
    const response = await page.request.post("/api/me/sources", {
      headers: csrf,
      data: {
        id: `hierarchy-${name}-${suffix}`,
        name: `${name} ${suffix}`,
        kind: "text",
        enabled: true,
        content: `socks5://${name.toLowerCase()}.example:1080#${name}`,
      },
    });
    expect(response.ok()).toBe(true);
    sources.push(await response.json());
  }
  await page.reload();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "新建集合", exact: true })
    .click();
  await drawer
    .getByLabel("集合名称", { exact: true })
    .fill(`合成集合 ${suffix}`);
  await expect(drawer.getByText("尚未选择来源", { exact: true })).toBeVisible();
  const merged = drawer.locator(".steps-editor").filter({
    has: page.getByRole("heading", { name: "合并后处理", exact: true }),
  });
  await choose(
    page,
    merged.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "去除重复连接",
  );
  await choose(page, sourceControl, sources[0].name);
  await expect(drawer.getByText(/按此顺序合并/)).toHaveCount(0);
  await expect(
    drawer.getByRole("button", { name: /[上下]移来源/ }),
  ).toHaveCount(0);
  const firstSource = drawer.getByRole("button", {
    name: `1. ${sources[0].name} 来源处理`,
    exact: true,
  });
  const chevron = firstSource.locator(".collection-source-chevron");
  await expect(chevron).toHaveAttribute("aria-hidden", "true");
  await expect(chevron).toHaveCSS("rotate", "0deg");
  await firstSource.click();
  await expect(chevron).toHaveCSS("rotate", "90deg");
  // State remains apparent without animation for reduced-motion users.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await firstSource.click();
  await expect(firstSource).toHaveAttribute("aria-expanded", "false");
  await expect(chevron).toHaveCSS("rotate", "0deg");
  await expect(chevron).toHaveCSS("transition-duration", "0s");
  await firstSource.click();
  await expect(firstSource).toHaveAttribute("aria-expanded", "true");
  await expect(chevron).toHaveCSS("rotate", "90deg");
  await expect(chevron).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: null });
  await expect(
    drawer.getByText("未添加处理步骤", { exact: true }),
  ).toBeVisible();
  const perSource = drawer.locator(".steps-editor").filter({
    has: page.getByRole("heading", { name: "来源处理", exact: true }),
  });
  await choose(
    page,
    perSource.getByRole("combobox", { name: "添加处理步骤", exact: true }),
    "重新命名",
  );
  await perSource
    .getByLabel("步骤 1 命名模板", { exact: true })
    .fill("{name} selected");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await sourceControl.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(`collection-one-${width}.png`),
      animations: "disabled",
    });
  }
  await choose(page, sourceControl, sources[1].name);
  await expect(drawer.getByText(/按此顺序合并/)).toBeVisible();
  await drawer.getByRole("button", { name: "下移来源 1", exact: true }).click();
  await expect(
    drawer.getByText(`1. ${sources[1].name}`, { exact: true }),
  ).toBeVisible();
  await expect(
    perSource.getByLabel("步骤 1 命名模板", { exact: true }),
  ).toHaveValue("{name} selected");
  await expect(merged.getByText("去除重复连接", { exact: true })).toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await sourceControl.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await page.screenshot({
      path: info.outputPath(`collection-multiple-${width}.png`),
      animations: "disabled",
    });
  }
  await drawer
    .getByRole("button", { name: "预览处理结果", exact: true })
    .click();
  await expect(drawer.getByText("逐阶段预览", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "保存集合", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  const saved = (await json(page, "/me/collections")).find(
    (item: { name: string }) => item.name === `合成集合 ${suffix}`,
  );
  expect(
    saved.sources.map((source: { sourceId: string }) => source.sourceId),
  ).toEqual([sources[1].id, sources[0].id]);
  expect(saved.sources[1].steps[0]).toMatchObject({
    kind: "rename",
    template: "{name} selected",
    enabled: true,
  });
  expect(saved.steps[0]).toMatchObject({ kind: "deduplicate", enabled: true });
  // Remove only this journey's synthetic fixtures, preserving unrelated inventory.
  for (const path of [
    `collections/${saved.id}`,
    ...sources.map((source) => `sources/${source.id}`),
  ]) {
    expect(
      (await page.request.delete(`/api/me/${path}`, { headers: csrf })).ok(),
    ).toBe(true);
  }
  expect(await json(page, "/me/sources")).toEqual(originalSources);
});

async function publicationFixture(page: Page) {
  await openWorkspace(page);
  const csrf = await headers(page);
  const key = Date.now().toString(36);
  const sourceResponse = await page.request.post("/api/me/sources", {
    headers: csrf,
    data: {
      id: `gesture-source-${key}`,
      name: `合成发布素材 ${key}`,
      kind: "text",
      enabled: true,
      content: "socks5://publish.example:1080#Synthetic Publish",
    },
  });
  expect(sourceResponse.ok()).toBe(true);
  const source = await sourceResponse.json();
  const profile = {
    id: `gesture-profile-${key}`,
    name: `合成分流 ${key}`,
    sourceIds: [source.id],
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    ir: {
      schemaVersion: "1.0",
      id: `gesture-profile-${key}`,
      name: `合成分流 ${key}`,
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [],
      rules: [],
      resources: [],
      defaultAction: { kind: "direct" },
      runtime: { mixedPort: 7890 },
    },
  };
  expect(
    (
      await page.request.post("/api/me/profiles", {
        headers: csrf,
        data: profile,
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post("/api/me/outputs", {
        headers: csrf,
        data: {
          id: `gesture-existing-${key}`,
          name: `既有电脑 ${key}`,
          profileId: profile.id,
          target: profile.target,
          mode: "full",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/#outputs?profile=${profile.id}`);
  await page.reload();
  await page
    .getByRole("article", { name: `分流配置 ${profile.name}`, exact: true })
    .getByRole("button", {
      name: `为 ${profile.name} 新增客户端订阅`,
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "新增客户端订阅",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return { profile, dialog };
}

for (const gesture of ["double click", "held Enter"] as const) {
  test(`new subscription ${gesture} cannot cross from check into publish without a fresh explicit confirmation`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const { profile, dialog } = await publicationFixture(page);
    const before = await json(page, "/me/outputs");
    let writes = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/me/outputs"
      )
        writes++;
    });
    const mode = gesture === "held Enter" ? "nodes-only" : "full";
    const name = `合成${gesture === "held Enter" ? "手机" : "电脑"}订阅`;
    await dialog.getByLabel("订阅名称", { exact: true }).fill(name);
    if (mode === "nodes-only")
      await choose(
        page,
        dialog.getByRole("combobox", { name: "输出内容", exact: true }),
        "纯节点输出",
      );
    const check = dialog.getByRole("button", {
      name: "检查发布内容",
      exact: true,
    });
    const publish = dialog.getByRole("button", {
      name: `创建并发布「${name}」`,
      exact: true,
    });
    await expect(check).toBeEnabled();
    await expect(publish).toHaveCount(0);
    await expect(
      dialog.getByText("创建独立的客户端订阅，其他订阅保留原版本。", { exact: true }),
    ).toHaveCount(1);
    if (gesture === "double click") {
      // Exercise an ordinary native double-click first. The guarded second-stage
      // continuation below also covers a response landing between the two clicks.
      await check.dblclick();
    } else {
      await check.focus();
      await page.keyboard.down("Enter");
    }
    const status = dialog
      .getByRole("status")
      .filter({ hasText: "兼容检查通过。" });
    await expect(status).toBeFocused();
    await expect(publish).toBeEnabled();
    if (gesture === "held Enter") {
      await page.keyboard.down("Enter");
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
    }
    expect(writes).toBe(0);
    expect(await json(page, "/me/outputs")).toEqual(before);
    await expect(
      dialog.getByText("纯节点订阅，仅交付连接。", { exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText(
        mode === "nodes-only"
          ? "仅包含节点连接。"
          : "包含连接、策略组、分流规则和运行设置。",
        { exact: true },
      ),
    ).toHaveCount(1);
    // Capture the natural result-focus position, not a post-scroll arrangement.
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await expect(publish).toBeInViewport({ ratio: 1 });
      await expect(
        dialog.getByText("新建独立链接，其他订阅保留原版本。", { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await noOverflow(page);
      await page.screenshot({
        path: info.outputPath(`new-subscription-${mode}-review-${width}.png`),
        animations: "disabled",
      });
    }
    // Changing an option invalidates that review. Neither a stale confirmation
    // nor rechecking is allowed to produce an Output.
    await page.setViewportSize({ width: 1280, height: 900 });
    const changedName = name + "（复核）";
    await dialog.getByLabel("订阅名称", { exact: true }).fill(changedName);
    await expect(publish).toHaveCount(0);
    await expect(check).toBeEnabled();
    if (gesture === "double click") {
      // In a short real viewport both stages share the constrained completion
      // position. In a tall viewport the new review legitimately moves the footer.
      await page.setViewportSize({ width: 1280, height: 480 });
      await check.scrollIntoViewIfNeeded();
      await info.attach("confirmation-check-viewport", {
        body: JSON.stringify({
          box: await check.boundingBox(),
          viewport: await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          })),
        }),
        contentType: "application/json",
      });
      await expect(check).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() => dialog.evaluate(surfaceMotionState))
        .toEqual({
          opacity: "1",
          preparing: false,
          running: false,
        });
      const box = await check.boundingBox();
      expect(box).not.toBeNull();
      // The prior native trace reported integer CSS coordinates. Hit-test the
      // same integer point rather than a different fractional edge position.
      const point = {
        x: Math.floor(box!.x + box!.width / 2),
        y: Math.floor(box!.y + box!.height / 2),
      };
      await page.mouse.click(point.x, point.y);
      await expect(status).toBeFocused();
      const fresh = dialog.getByRole("button", {
        name: `创建并发布「${changedName}」`,
        exact: true,
      });
      await expect(fresh).toBeEnabled();
      await info.attach("confirmation-fresh-viewport", {
        body: JSON.stringify(
          await fresh.evaluate(confirmationPointerGeometry, point),
        ),
        contentType: "application/json",
      });
      await expect(fresh).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() => dialog.evaluate(surfaceMotionState))
        .toEqual({
          opacity: "1",
          preparing: false,
          running: false,
        });
      const hitsFreshConfirmation = await fresh.evaluate(
        (el, p) => el.contains(document.elementFromPoint(p.x, p.y)),
        point,
      );
      await info.attach("confirmation-shared-pointer-geometry", {
        body: JSON.stringify({
          point,
          checkBox: box,
          confirmationBox: await fresh.boundingBox(),
          viewport: await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          })),
          hitsFreshConfirmation,
        }),
        contentType: "application/json",
      });
      expect(hitsFreshConfirmation).toBe(true);
      // mouse.click({clickCount:2}) generates a new detail=1 click first.
      // Send only this gesture's native second down/up pair at the unchanged
      // pointer position, and observe its actual click detail without dispatching.
      await fresh.evaluate((el) => {
        type NativeEvent = {
          type: string;
          detail: number;
          action: string | null;
          targetTag: string | null;
          targetSlot: string | null;
          targetBox: unknown;
          confirmationBox: unknown;
          x: number;
          y: number;
        };
        const state = window as unknown as {
          confirmationClickDetails: number[];
          confirmationNativeEvents: NativeEvent[];
          stopConfirmationCapture?: () => void;
        };
        state.confirmationClickDetails = [];
        state.confirmationNativeEvents = [];
        const expected = el.getAttribute("aria-label");
        const capture = (event: Event) => {
          const mouse = event as MouseEvent;
          const action =
            event.target instanceof Element
              ? (event.target.closest("button")?.getAttribute("aria-label") ??
                null)
              : null;
          state.confirmationNativeEvents.push({
            type: event.type,
            detail: mouse.detail,
            action,
            targetTag:
              event.target instanceof Element ? event.target.tagName : null,
            targetSlot:
              event.target instanceof Element
                ? event.target.getAttribute("data-slot")
                : null,
            targetBox:
              event.target instanceof Element
                ? event.target.getBoundingClientRect().toJSON()
                : null,
            confirmationBox: el.getBoundingClientRect().toJSON(),
            x: mouse.clientX,
            y: mouse.clientY,
          });
          if (event.type === "click" && action === expected)
            state.confirmationClickDetails.push(mouse.detail);
        };
        const events = ["mousedown", "mouseup", "click"];
        events.forEach((type) =>
          document.addEventListener(type, capture, true),
        );
        state.stopConfirmationCapture = () =>
          events.forEach((type) =>
            document.removeEventListener(type, capture, true),
          );
      });
      // Refresh native hit targeting after the keyed Check button was replaced;
      // do not move to a new point or dispatch a synthetic DOM click.
      await page.mouse.move(point.x, point.y);
      const beforeNativePair = await fresh.evaluate(
        confirmationPointerGeometry,
        point,
      );
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      const afterNativePair = await fresh.evaluate(
        confirmationPointerGeometry,
        point,
      );
      const nativeGesture = await page.evaluate(() => {
        const state = window as unknown as {
          confirmationClickDetails: number[];
          confirmationNativeEvents: unknown[];
          stopConfirmationCapture?: () => void;
        };
        state.stopConfirmationCapture?.();
        return {
          details: state.confirmationClickDetails,
          events: state.confirmationNativeEvents,
        };
      });
      await info.attach("confirmation-native-second-click", {
        body: JSON.stringify({
          point,
          expectedAction: `创建并发布「${changedName}」`,
          hitsFreshConfirmation,
          beforeNativePair,
          afterNativePair,
          ...nativeGesture,
        }),
        contentType: "application/json",
      });
      expect(nativeGesture.details).toEqual([2]);
    } else {
      await check.click();
      await expect(status).toBeFocused();
    }
    expect(writes).toBe(0);
    expect(await json(page, "/me/outputs")).toEqual(before);
    await dialog
      .getByRole("button", {
        name: `创建并发布「${changedName}」`,
        exact: true,
      })
      .click();
    await expect(dialog).not.toBeVisible();
    const after = await json(page, "/me/outputs");
    expect(writes).toBe(1);
    expect(after).toHaveLength(before.length + 1);
    for (const output of before)
      expect(
        after.find((item: { id: string }) => item.id === output.id),
      ).toEqual(output);
    expect(
      after.find((item: { name: string }) => item.name === changedName),
    ).toMatchObject({ profileId: profile.id, mode, target: profile.target });
    await info.attach("explicit-confirmation-result", {
      body: JSON.stringify({
        gesture,
        mode,
        writes,
        existingOutputsUnchanged: true,
        freshReviewRequired: true,
      }),
      contentType: "application/json",
    });
  });
}

async function missingReferenceFixture(page: Page) {
  await openWorkspace(page);
  await expect(
    page.getByRole("heading", { name: "我的订阅", exact: true }),
  ).toBeVisible();
  const headers = { "X-CSRF-Token": (await json(page, "/auth/me")).csrfToken };
  const key = Date.now().toString(36);
  const id = "repair-" + key;
  const sr = await page.request.post("/api/me/sources", {
    headers,
    data: {
      id: "source-" + key,
      name: "修复素材 " + key,
      kind: "text",
      applyMode: "manual",
      content:
        "socks5://one.example:1080#London\nsocks5://two.example:1080#Tokyo\nsocks5://three.example:1080#Osaka",
      enabled: true,
    },
  });
  expect(sr.ok()).toBe(true);
  const source = await sr.json();
  const ref = { kind: "endpoint", ref: source.snapshot.endpoints[1].id };
  const secondRef = { kind: "endpoint", ref: source.snapshot.endpoints[2].id };
  const profile = {
    id,
    name: "日常分流 " + key,
    sourceIds: [source.id],
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    ir: {
      schemaVersion: "1.0",
      id,
      name: "日常分流 " + key,
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [
        {
          id: "travel",
          name: "旅行",
          kind: "manual",
          members: [ref, secondRef],
        },
      ],
      rules: [
        {
          id: "first",
          match: { op: "domain-suffix", value: "one.example" },
          action: { kind: "direct" },
        },
        {
          id: "second",
          match: { op: "domain-suffix", value: "two.example" },
          action: secondRef,
        },
      ],
      resources: [],
      defaultAction: ref,
      runtime: { mixedPort: 7890 },
    },
  };
  expect(
    (
      await page.request.post("/api/me/profiles", { headers, data: profile })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page.getByText("订阅素材", { exact: true }).click();
  await page.getByRole("button", { name: "订阅来源", exact: true }).click();
  await page
    .getByRole("textbox", { name: "搜索来源", exact: true })
    .fill(source.name);
  await (await sourceRowAction(page, "编辑", source.name)).click();
  await page
    .getByLabel("节点链接或配置内容")
    .fill("socks5://one.example:1080#London");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: `应用更新 ${source.name}`, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `查看上次应用结果 ${source.name}`,
      exact: true,
    })
    .click();
  const receipt = page.getByRole("dialog", {
    name: "上次应用详情",
    exact: true,
  });
  await receipt
    .getByRole("link", { name: new RegExp("^查看配置 " + profile.name) })
    .click();
  await page
    .getByRole("article", { name: "分流配置 " + profile.name, exact: true })
    .getByRole("button", { name: "继续配置", exact: true })
    .click();
  return { profile, source };
}

test("missing destinations remain readable with full identities available at desktop, 390 and 320", async ({
  page,
}, info) => {
  const { profile } = await missingReferenceFixture(page);
  const warning = page.getByRole("alert", { name: "部分流量去向当前不可用" });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("button")).toHaveCount(3);
  // The real API retains known endpoint names in the revealed IR.
  // First capture that state, then use the actual JSON editor to remove only
  // obsolete endpoint metadata from this unsaved synthetic draft, retaining refs.
  await warning
    .getByRole("button", { name: "调整默认流量去向", exact: true })
    .click();
  const namedDefault = page
    .getByRole("combobox", { name: "默认流量行为", exact: true })
    .locator("xpath=ancestor::label");
  await expect(namedDefault).toContainText("不可用：Tokyo");
  await page.screenshot({
    path: info.outputPath("1280-named-default.png"),
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "运行设置", exact: true }).click();
  await page
    .getByRole("button", { name: "高级：配置意图与目标版本", exact: true })
    .click();
  await page
    .getByRole("button", { name: "编辑配置意图 JSON", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "配置意图 JSON",
    exact: true,
  });
  const editor = drawer.getByLabel("配置意图 JSON 文本", { exact: true });
  const draft = JSON.parse(await editor.inputValue());
  draft.endpoints = [];
  await editor.fill(JSON.stringify(draft));
  await drawer.getByRole("button", { name: "应用到草稿", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [repair, label, detail] of [
      ["调整默认流量去向", "默认流量行为", "默认去向的引用详情"],
      ["调整规则 2 的去向", "规则 2 的流量去向", "规则 2的引用详情"],
      [
        "调整策略组「旅行」的成员",
        "策略组「旅行」的固定成员",
        "策略组「旅行」成员的引用详情",
      ],
    ]) {
      await warning.getByRole("button", { name: repair, exact: true }).click();
      const control = page.getByRole("combobox", { name: label, exact: true });
      await expect(control).toBeFocused();
      await expect(control).toBeInViewport({ ratio: 1 });
      const field = control.locator("xpath=ancestor::label");
      await expect(field).toContainText("连接不可用");
      await expect(field).not.toContainText("ep_");
      const selectedContent = field.locator(
        '[role="combobox"] > span, [data-slot="badge"] > span',
      );
      await expect(selectedContent.first()).toBeVisible();
      const clipped = await selectedContent.evaluateAll((elements) =>
        elements
          .map((element) => ({
            text: element.textContent,
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
          }))
          .filter((element) => element.scrollWidth > element.width + 1),
      );
      expect(clipped).toEqual([]);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({
        path: info.outputPath(`${width}-${label}.png`),
        animations: "disabled",
      });
      const details = page.getByLabel(detail, { exact: true });
      const summary = details.locator("summary");
      await expect(summary).toHaveCSS("display", "list-item");
      if (width <= 700)
        expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(
          44,
        );
      await expect(control).toHaveAttribute(
        "aria-describedby",
        (await details.getAttribute("id")) as string,
      );
      if (
        !(await details.evaluate(
          (element) => (element as HTMLDetailsElement).open,
        ))
      )
        await details.locator("summary").click();
      await expect(details.locator("code").first()).toBeVisible();
      await expect(details).toContainText(
        profile.ir.groups[0].members[label.includes("规则") ? 1 : 0].ref,
      );
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      if (label.includes("固定成员")) {
        await expect(details.locator("li")).toHaveCount(2);
        await control.click();
        const option = page
          .getByRole("listbox")
          .getByText(profile.ir.groups[0].members[1].ref, { exact: true });
        await expect(option).toBeVisible();
        await expect(option).toHaveText(profile.ir.groups[0].members[1].ref);
        // Expanded option lists scroll independently; full identity must remain
        // readable when brought into view, without relying on hover/tooltips.
        await option.scrollIntoViewIfNeeded();
        await expect(option).toBeInViewport({ ratio: 1 });
        await expect(page.locator("body")).toHaveJSProperty(
          "scrollWidth",
          width,
        );
        await page.screenshot({
          path: info.outputPath(`${width}-group-reference-details.png`),
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
      }
    }
  }
  const saved = (await json(page, "/me/profiles")).find(
    (item: any) => item.id === profile.id,
  );
  expect(saved.ir.defaultAction).toEqual(profile.ir.defaultAction);
  expect(saved.ir.rules).toEqual(profile.ir.rules);
  expect(saved.ir.groups).toEqual(profile.ir.groups);
});
