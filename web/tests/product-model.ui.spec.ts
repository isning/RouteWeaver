import { currentProfileFixtureHeaders } from "./profile-fixture";
import { auditTextGeometry } from "./text-geometry";
import { openWorkspace, navigateWorkspace } from "./ui-session";
import { createHash } from "node:crypto";
import {
  test,
  expect,
  type Page,
  type TestInfo,
  type Locator,
} from "@playwright/test";

type SavedProfile = {
  id: string;
  name: string;
  ir: { defaultAction: { kind: string } };
};
type PublishedOutput = {
  id: string;
  name: string;
  profileId: string;
  target: { adapterId: string; version: string };
  mode: string;
  status: string;
  revision?: string;
  publishedAt?: string;
  updatedAt?: string;
  routingSummary?: unknown;
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function readJSON<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `Read ${path} succeeds`).toBe(true);
  return response.json() as Promise<T>;
}

/** Setup only: no editor/save/check/publish interaction under test is seeded. */
async function seedIndependentOutputs(
  page: Page,
  outputCount = 2,
  withRule = false,
) {
  const session = await readJSON<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `journey-profile-${suffix}`;
  const profile = {
    id,
    name: `Journey configuration ${suffix}`,
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    sourceIds: [],
    ir: {
      schemaVersion: "1.0",
      id,
      name: `Journey configuration ${suffix}`,
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [],
      rules: withRule
        ? [
            {
              id: `rule-${suffix}`,
              match: { op: "domain-suffix", value: "before.example" },
              action: { kind: "reject" },
            },
          ]
        : [],
      resources: [],
      defaultAction: { kind: "direct" },
      runtime: { mixedPort: 7890 },
    },
  };
  const saved = await page.request.post("/api/me/profiles", {
    headers,
    data: profile,
  });
  expect(saved.ok(), "Synthetic configuration setup succeeds").toBe(true);
  const outputs: PublishedOutput[] = [];
  for (const [label, adapterId, version] of [
    ["Laptop", "mihomo", "1.19.32"],
    ["Phone", "sing-box", "1.14.3"],
  ].slice(0, outputCount)) {
    const result = await page.request.post("/api/me/outputs", {
      headers,
      data: {
        id: `journey-output-${label.toLowerCase()}-${suffix}`,
        name: `${label} ${suffix}`,
        profileId: profile.id,
        target: { adapterId, version },
        mode: "full",
      },
    });
    expect(result.ok(), `Synthetic ${label} publication setup succeeds`).toBe(
      true,
    );
    outputs.push(await result.json());
  }
  // API fixtures predate the UI task. Reload their initial read model rather than
  // carrying the empty query cache from login into a hash-only navigation.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "我的订阅", exact: true }),
  ).toBeVisible();
  return { profile, outputs };
}

/** Never put access paths, tokens, or delivery contents into reports/assertion diffs. */
async function frozenState(page: Page, id: string) {
  const outputs = await readJSON<PublishedOutput[]>(page, "/me/outputs");
  const output = outputs.find((item) => item.id === id);
  expect(Boolean(output), "Requested Output exists").toBe(true);
  const access = await readJSON<{ feedPath?: string }>(
    page,
    `/me/outputs/${id}/access`,
  );
  expect(
    Boolean(access.feedPath),
    "Output has local test delivery identity",
  ).toBe(true);
  const path = new URL(access.feedPath!, "http://127.0.0.1:4173").pathname;
  // Only the loopback origin is used, even if a response also supplies a display URL.
  const delivered = await page.request.get(path);
  expect(delivered.ok(), "Frozen local delivery succeeds").toBe(true);
  return {
    id: output!.id,
    profileId: output!.profileId,
    target: output!.target,
    mode: output!.mode,
    status: output!.status,
    revision: output!.revision,
    publishedAt: output!.publishedAt,
    updatedAt: output!.updatedAt,
    routingSummary: output!.routingSummary,
    accessFingerprint: digest(access.feedPath!),
    contentFingerprint: digest(await delivered.text()),
  };
}

async function changeDefault(page: Page, label: "拒绝连接" | "直连") {
  const behavior = page.getByLabel("默认流量行为", { exact: true });
  await behavior.click();
  // The shadcn combobox trigger is a button; type into its search field.
  const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
  await search.fill(label);
  await expect(
    page.getByRole("option", { name: label, exact: true }),
  ).toHaveCount(1);
  await search.press("Enter");
}

async function startConfiguration(page: Page) {
  await page.getByRole("button", { name: /^(设置订阅|新建分流配置)$/ }).click();
}

async function editSelectedOutputConfiguration(page: Page, name: string) {
  const detail = page.getByRole("dialog", {
    name: `${name} 的订阅详情`,
    exact: true,
  });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "更多操作", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "编辑关联分流配置", exact: true })
    .click();
}

async function report(
  testInfo: TestInfo,
  journey: string,
  evidence: Record<string, unknown>,
) {
  await testInfo.attach("journey-result", {
    body: JSON.stringify(
      {
        journey,
        evidence,
        scope:
          "Real loopback control-plane UI/API; no live proxy traffic or runtime application.",
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
}

async function verifyLowerEditorCompletion(page: Page, field: Locator) {
  const actions = page.locator(".profile-publish-action");
  const save = page.getByRole("button", { name: "保存草稿", exact: true });
  await expect(save).toHaveCount(1);
  await field.scrollIntoViewIfNeeded();
  await expect(field).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  for (const action of await actions.getByRole("button").all()) {
    await expect(action).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () => (await action.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
  }
  const bar = await actions.boundingBox();
  const target = await field.boundingBox();
  expect(Boolean(bar && target)).toBe(true);
  expect(
    target!.y,
    "Focused lower editor input is below, not behind, the sticky actions",
  ).toBeGreaterThanOrEqual(bar!.y + bar!.height);
  expect(
    await field.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
      return hit === element || element.contains(hit);
    }),
    "The focused control can actually receive pointer input",
  ).toBe(true);
}

async function waitForTechnicalLayout(dialog: Locator) {
  // ARIA expands before the collapse height animation completes. Wait for that
  // real layout boundary before scrolling, without disabling UI motion or sleeping.
  const technicalContent = dialog.locator("[data-slot='accordion-content']");
  await expect(technicalContent).toHaveAttribute("data-state", "open");
  await technicalContent.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) =>
        animation.finished.catch(() => {
          // A canceled/replaced animation also stops changing this layout.
        }),
      ),
    );
  });
}

/** Numeric geometry only: technical configurations can contain private material. */
async function recordTechnicalScrollGeometry(dialog: Locator) {
  await test.info().attach("technical-preview-scroll-geometry", {
    body: JSON.stringify(
      await dialog.evaluate((root) => {
        const body = root.querySelector<HTMLElement>(
          "[data-task-overlay-body]",
        );
        const panel = root.querySelector<HTMLElement>(
          "[data-slot='accordion-content']",
        );
        const preview = root.querySelector("pre");
        return {
          mode: root.getAttribute("data-task-scroll"),
          viewport: {
            width: innerWidth,
            height: innerHeight,
            scrollX,
            scrollY,
          },
          dialog: root.getBoundingClientRect().toJSON(),
          body: body && {
            box: body.getBoundingClientRect().toJSON(),
            scrollTop: body.scrollTop,
            scrollHeight: body.scrollHeight,
            clientHeight: body.clientHeight,
          },
          panel: panel && {
            box: panel.getBoundingClientRect().toJSON(),
            state: panel.dataset.state,
            animationStates: panel
              .getAnimations({ subtree: true })
              .map((animation) => animation.playState),
          },
          preview: preview?.getBoundingClientRect().toJSON(),
        };
      }),
    ),
    contentType: "application/json",
  });
}

async function verifyMobilePublicationReview(
  page: Page,
  dialog: Locator,
  confirm: Locator,
  screenshotPath: string,
  mode: "create" | "update",
) {
  await page.setViewportSize({ width: 390, height: 844 });
  const cancel = dialog.getByRole("button", { name: /^取\s*消$/ });
  const verifyFooterTargets = async () => {
    if (mode === "update") {
      const decision = dialog.getByRole("group", {
        name: "更新确认",
        exact: true,
      });
      await decision.scrollIntoViewIfNeeded();
      await expect(decision).toBeInViewport({ ratio: 1 });
    }
    await expect(dialog.locator("[data-slot='dialog-header']")).toBeInViewport({
      ratio: 1,
    });
    for (const target of [confirm, cancel]) {
      await expect(target).toBeInViewport({ ratio: 1 });
      await expect
        .poll(async () => (await target.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(44);
    }
  };
  const technical = dialog.getByRole("button", {
    name: mode === "update" ? "查看待发布技术配置" : "技术配置（可选查看）",
    exact: true,
  });
  await expect(technical).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.locator("pre")).not.toBeVisible();
  await verifyFooterTargets();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await technical.click();
  await expect(technical).toHaveAttribute("aria-expanded", "true");
  await waitForTechnicalLayout(dialog);
  // Scroll the outer review body as a reader would, not the nested code area.
  // scrollIntoView can leave a fractional border clipped at this narrow width.
  await dialog
    .locator("[data-task-overlay-body]")
    .hover({ position: { x: 8, y: 8 } });
  await page.mouse.wheel(0, 1000);
  await expect(dialog.locator("pre")).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator("pre")).not.toHaveText("");
  await verifyFooterTargets();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await technical.click();
  await expect(technical).toHaveAttribute("aria-expanded", "false");
  await verifyFooterTargets();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.screenshot({ path: screenshotPath, animations: "disabled" });
}

/** Controlled text-size simulation, not browser-native zoom or a human usability result. */
async function auditReflowAndTextScale(
  page: Page,
  testInfo: TestInfo,
  context: string,
  scope: Locator,
  primary: Locator,
  sampleText: Locator,
  readingTarget?: Locator,
  inspectLayout?: () => Promise<void>,
) {
  const originalViewport = page.viewportSize()!;
  const geometry = async () => scope.evaluate(auditTextGeometry);
  await page.setViewportSize({ width: 320, height: 844 });
  if (readingTarget) {
    await readingTarget.scrollIntoViewIfNeeded();
    await expect(readingTarget).toBeInViewport({ ratio: 1 });
  }
  await primary.scrollIntoViewIfNeeded();
  await expect(primary).toBeInViewport({ ratio: 1 });
  await inspectLayout?.();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  const narrowGeometry = await geometry();
  await page.screenshot({
    path: testInfo.outputPath(`${context}-320-reflow.png`),
    animations: "disabled",
  });
  await testInfo.attach(`${context}-320-geometry`, {
    body: JSON.stringify(narrowGeometry),
    contentType: "application/json",
  });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
  expect(
    narrowGeometry.issues,
    "320px visible control/label text is not vertically clipped",
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  const originalFont = await sampleText.evaluate((element) =>
    parseFloat(getComputedStyle(element).fontSize),
  );
  await page.evaluate(() => {
    type Entry = {
      element: HTMLElement;
      font: string;
      fontPriority: string;
      line: string;
      linePriority: string;
      computedFont: number;
      computedLine: string;
    };
    const host = window as typeof window & { __routeweaverTextScale?: Entry[] };
    if (host.__routeweaverTextScale)
      throw new Error("Text-size audit was not restored");
    // Snapshot all computed values before mutating any ancestor, avoiding 2x/4x inheritance.
    host.__routeweaverTextScale = Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )
      .filter(
        (element) =>
          element instanceof HTMLElement &&
          !["SCRIPT", "STYLE", "LINK"].includes(element.tagName),
      )
      .map((element) => ({
        element,
        font: element.style.getPropertyValue("font-size"),
        fontPriority: element.style.getPropertyPriority("font-size"),
        line: element.style.getPropertyValue("line-height"),
        linePriority: element.style.getPropertyPriority("line-height"),
        computedFont: parseFloat(getComputedStyle(element).fontSize),
        computedLine: getComputedStyle(element).lineHeight,
      }));
    for (const value of host.__routeweaverTextScale) {
      value.element.style.setProperty(
        "font-size",
        `${value.computedFont * 2}px`,
        "important",
      );
      if (value.computedLine !== "normal")
        value.element.style.setProperty(
          "line-height",
          `${parseFloat(value.computedLine) * 2}px`,
          "important",
        );
    }
  });
  try {
    // AntD inputs transition `all`, including the simulated font-size. Observe
    // the actual doubled size rather than measuring an interpolation frame.
    await expect
      .poll(() =>
        sampleText.evaluate((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        ),
      )
      .toBeCloseTo(originalFont * 2, 2);
    const enlargedFont = await sampleText.evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    );
    expect(enlargedFont).toBeCloseTo(originalFont * 2, 2);
    if (readingTarget) {
      await readingTarget.scrollIntoViewIfNeeded();
      await expect(readingTarget).toBeInViewport({ ratio: 1 });
    }
    await primary.scrollIntoViewIfNeeded();
    await expect(primary).toBeInViewport({ ratio: 1 });
    await inspectLayout?.();
    const enlargedGeometry = await geometry();
    await page.screenshot({
      path: testInfo.outputPath(`${context}-200pct-text-simulation.png`),
      animations: "disabled",
    });
    await testInfo.attach(`${context}-200pct-geometry`, {
      body: JSON.stringify({
        simulation:
          "computed font and line-height doubled; not browser-native zoom",
        viewport: "390x844",
        originalFont,
        enlargedFont,
        ...enlargedGeometry,
      }),
      contentType: "application/json",
    });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    expect(
      enlargedGeometry.issues,
      "200% text is not vertically clipped within controls or labels",
    ).toEqual([]);
  } finally {
    await page.evaluate(() => {
      const host = window as typeof window & {
        __routeweaverTextScale?: Array<{
          element: HTMLElement;
          font: string;
          fontPriority: string;
          line: string;
          linePriority: string;
        }>;
      };
      for (const value of host.__routeweaverTextScale || []) {
        if (value.font)
          value.element.style.setProperty(
            "font-size",
            value.font,
            value.fontPriority,
          );
        else value.element.style.removeProperty("font-size");
        if (value.line)
          value.element.style.setProperty(
            "line-height",
            value.line,
            value.linePriority,
          );
        else value.element.style.removeProperty("line-height");
      }
      delete host.__routeweaverTextScale;
    });
    await expect
      .poll(() =>
        sampleText.evaluate((element) =>
          parseFloat(getComputedStyle(element).fontSize),
        ),
      )
      .toBeCloseTo(originalFont, 2);
    await page.setViewportSize(originalViewport);
  }
}

test("controlled empty inventories name the task and server registration does not imply deployment", async ({
  page,
}, testInfo) => {
  // Empty read-side fixtures are explicit: other files may already have created
  // synthetic records in the shared demo. Never delete them to fake freshness.
  // Authentication and all potential writes still use the real loopback API.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "登录 RouteWeaver", exact: true }),
  ).toBeVisible();
  const login = page.getByRole("region", { name: "恢复登录", exact: true });
  await expect(login.getByRole("heading")).toHaveCount(1);
  await expect(login.locator("p")).toHaveText([
    "邀请制工作空间", "你的来源仅由你管理",
  ]);
  await expect(page.getByLabel("账号", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  await page.screenshot({
    path: testInfo.outputPath("login-task-content-desktop.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "进入工作空间", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("login-task-content-mobile.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page);
  const inventories = ["/hosts", "/server-deployments", "/me/collections"];
  const before = new Map<string, unknown[]>();
  for (const path of inventories) {
    before.set(path, await readJSON<unknown[]>(page, path));
    await page.route(`**/api${path}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: [] })
        : route.continue(),
    );
  }

  const writes: string[] = [];
  const observeWrite = (request: import("@playwright/test").Request) => {
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/api/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    )
      writes.push(`${request.method()} ${path}`);
  };
  page.on("request", observeWrite);
  await page.getByText("网络资源", { exact: true }).click();
  await navigateWorkspace(page, "服务器");
  await expect(
    page.getByRole("heading", { name: "服务器", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("暂无服务器", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("server-empty-task-desktop.png"),
    animations: "disabled",
  });
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "添加服务器", exact: true })
    .click();
  const registration = page.getByRole("dialog", {
    name: "添加服务器",
    exact: true,
  });
  const consequence = registration.getByText(
    "将服务器信息登记到控制平面；服务器连接与配置需另行操作。",
    { exact: true },
  );
  const save = registration.getByRole("button", { name: /^保\s*存$/ });
  await expect(
    registration.getByLabel("服务器名称", { exact: true }),
  ).toHaveValue("");
  await expect(
    registration.getByLabel("服务器连接地址", { exact: true }),
  ).toHaveValue("");
  await expect(consequence).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("server-registration-consequence-desktop.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await save.scrollIntoViewIfNeeded();
  await expect(consequence).toBeInViewport({ ratio: 1 });
  await expect(save).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("server-registration-consequence-mobile.png"),
    animations: "disabled",
  });
  await registration.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(registration).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("navigation", { name: "工作空间导航", exact: true }),
  ).toBeVisible();
  await navigateWorkspace(page, "转发路径");
  await expect(
    page.getByRole("heading", { name: "转发路径", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("暂无服务器转发路径", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".page-heading")
      .getByRole("button", { name: "新建转发路径", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("route-empty-task-desktop.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByText("暂无服务器转发路径", { exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("route-empty-task-mobile.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByText("订阅素材", { exact: true }).click();
  await navigateWorkspace(page, "节点集合");
  await expect(
    page.getByRole("heading", { name: "节点集合", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("暂无节点集合", { exact: true })).toBeVisible();
  await expect(
    page
      .locator(".page-heading")
      .getByRole("button", { name: "新建集合", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("collection-empty-task-desktop.png"),
    animations: "disabled",
  });
  page.off("request", observeWrite);
  expect(
    writes,
    "Viewing empty pages and cancelling registration does not mutate the backend",
  ).toEqual([]);
  for (const path of inventories)
    expect(
      await readJSON<unknown[]>(page, path),
      `${path} remains unchanged`,
    ).toEqual(before.get(path));
  await report(
    testInfo,
    "controlled empty pages and registration consequence",
    {
      realDemoAuthentication: true,
      loginScreenshotsBeforeCredentialEntry: true,
      inventoryScope: "controlled GET-only empty fixtures",
      emptyObjects: ["servers", "server routes", "node collections"],
      registrationOnlyConsequenceAtDecision: true,
      registrationSubmitted: false,
      backendWrites: 0,
      existingBackendInventoriesUnchanged: true,
      deployedOrConnectedServer: false,
    },
  );
});

for (const intent of ["endpoint", "direct"] as const) {
  test(`first-use ${intent}: two imported connections are only routed by an explicit user choice`, async ({
    page,
  }, testInfo) => {
    await openWorkspace(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const suffix = Date.now().toString(36);
    const profileName = `First use ${intent} ${suffix}`;
    const sourceName = `Two choices ${suffix}`;
    const outputName = `Personal phone ${intent} ${suffix}`;
    const beforeProfiles = await readJSON<SavedProfile[]>(page, "/me/profiles");
    const beforeOutputs = await readJSON<PublishedOutput[]>(
      page,
      "/me/outputs",
    );
    await startConfiguration(page);
    await page.getByLabel("配置名称", { exact: true }).fill(profileName);
    const task = page.getByRole("region", { name: "连接与流量", exact: true });
    await expect(
      page.getByRole("button", { name: "保存草稿", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存并检查", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "策略组", exact: true }).click();
    const groups = page.getByRole("tabpanel", { name: "策略组", exact: true });
    await expect(groups.getByText("暂无策略组", { exact: true })).toBeVisible();
    await expect(
      groups.getByRole("button", { name: "添加策略组", exact: true }),
    ).toBeVisible();
    await expect(
      groups.getByText("让连接各司其职", { exact: true }),
    ).toHaveCount(0);
    if (intent === "endpoint")
      await page.screenshot({
        path: testInfo.outputPath("first-use-empty-content-desktop.png"),
        animations: "disabled",
      });
    await task.getByRole("button", { name: /^(?:loading )?添加来源$/ }).click();
    const sourceDialog = page.getByRole("dialog", {
      name: "添加订阅来源",
      exact: true,
    });
    await sourceDialog.getByLabel("来源名称").fill(sourceName);
    const syntheticNodes =
      "socks5://north.example:1080#North Gate\nsocks5://south.example:1081#South Gate";
    const fileButton = sourceDialog.getByRole("button", {
      name: "选择配置文件",
      exact: true,
    });
    await expect(fileButton).toBeVisible();
    await expect
      .poll(async () => (await fileButton.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    if (intent === "endpoint") {
      const beforeImport = (
        await readJSON<Array<{ id: string }>>(page, "/me/sources")
      )
        .map((item) => item.id)
        .sort();
      const chooser = page.waitForEvent("filechooser");
      await fileButton.click();
      await (
        await chooser
      ).setFiles({
        name: "synthetic-connections.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(syntheticNodes),
      });
      await expect(sourceDialog.getByLabel("节点链接或配置内容")).toHaveValue(
        syntheticNodes,
      );
      await expect(sourceDialog.getByRole("status")).toHaveText(
        "已选择文件：synthetic-connections.txt",
      );
      expect(
        (await readJSON<Array<{ id: string }>>(page, "/me/sources"))
          .map((item) => item.id)
          .sort(),
      ).toEqual(beforeImport);
    } else {
      await sourceDialog.getByLabel("节点链接或配置内容").fill(syntheticNodes);
    }
    // Necessary privacy facts stay visible at the real commit decision, outside optional help.
    const privacy = sourceDialog.locator(".privacy-note");
    await expect(privacy).toContainText("订阅信息由平台解析");
    await expect(privacy).toContainText("加密保存");
    await expect(privacy).toContainText("仅供你的账号使用");
    await expect(
      sourceDialog.getByRole("button", { name: "导入选项", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    const importAction = sourceDialog.getByRole("button", {
      name: "导入来源",
      exact: true,
    });
    await importAction.scrollIntoViewIfNeeded();
    await expect(importAction).toBeInViewport({ ratio: 1 });
    await expect(privacy).toBeInViewport({ ratio: 1 });
    if (intent === "endpoint") {
      await page.screenshot({
        path: testInfo.outputPath("source-import-privacy-before-submit.png"),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await importAction.scrollIntoViewIfNeeded();
      await expect(importAction).toBeInViewport({ ratio: 1 });
      await expect(privacy).toBeInViewport({ ratio: 1 });
      await page.screenshot({
        path: testInfo.outputPath("source-import-privacy-mobile.png"),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await sourceDialog
      .getByRole("button", { name: "导入来源", exact: true })
      .click();
    await expect(sourceDialog).not.toBeVisible();
    await expect(task.getByText("2 个有效连接", { exact: true })).toBeVisible();
    await expect(
      task.locator(".default-route [role='combobox']"),
    ).toContainText("直连");
    await expect(
      task.getByText("已导入的连接尚未用于分流。", { exact: true }),
    ).toHaveCount(1);
    await expect(
      task.getByText("已导入的连接尚未用于分流。", { exact: true }),
    ).toBeVisible();
    expect(
      (await readJSON<SavedProfile[]>(page, "/me/profiles"))
        .map((item) => item.id)
        .sort(),
    ).toEqual(beforeProfiles.map((item) => item.id).sort());
    expect(
      (await readJSON<PublishedOutput[]>(page, "/me/outputs"))
        .map((item) => item.id)
        .sort(),
    ).toEqual(beforeOutputs.map((item) => item.id).sort());
    await expect(
      task.getByLabel("默认流量行为", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`first-use-${intent}-intent-desktop.png`),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const defaultControl = task.locator(".default-route [role='combobox']");
    await task.locator(".profile-traffic-task").scrollIntoViewIfNeeded();
    await expect(
      task.getByRole("heading", { name: "流量去向", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(task.locator("label.default-route")).toBeInViewport({
      ratio: 1,
    });
    await expect(task.locator("label.default-route")).toContainText("所有流量");
    await expect(defaultControl).toHaveText("直连");
    await expect(
      task.getByLabel("默认流量行为", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(defaultControl).toBeInViewport({ ratio: 1 });
    await expect
      .poll(async () => (await defaultControl.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`first-use-${intent}-intent-mobile.png`),
      animations: "disabled",
    });
    if (intent === "endpoint")
      await auditReflowAndTextScale(
        page,
        testInfo,
        "intent-editor",
        page.locator(".profile-intent-editor"),
        defaultControl,
        task.getByRole("heading", { name: "流量去向", exact: true }),
      );
    const choice = task.getByLabel("默认流量行为", { exact: true });
    await choice.click();
    const search = page.getByRole("combobox", {
      name: "搜索选项",
      exact: true,
    });
    await search.fill(intent === "endpoint" ? "North Gate" : "直连");
    await expect(
      page.getByRole("option", {
        name: intent === "endpoint" ? "North Gate" : "直连",
        exact: true,
      }),
    ).toHaveCount(1);
    await search.press("Enter");
    await expect(defaultControl).toContainText(
      intent === "endpoint" ? "North Gate" : "直连",
    );
    if (intent === "endpoint")
      await expect(
        task.getByText("已导入的连接尚未用于分流。", { exact: true }),
      ).not.toBeVisible();
    else
      await expect(
        task.getByText("已导入的连接尚未用于分流。", { exact: true }),
      ).toBeVisible();
    await page.getByRole("button", { name: "保存并检查", exact: true }).click();
    // A fresh zero-linked read goes directly to explicit creation options;
    // it neither checks nor creates a subscription by itself.
    const create = page.getByRole("dialog", {
      name: "新增客户端订阅",
      exact: true,
    });
    await expect(create).toContainText(profileName);
    await expect(
      page.getByRole("dialog", {
        name: "选择客户端订阅",
        exact: true,
      }),
    ).toHaveCount(0);
    await create.getByLabel("订阅名称", { exact: true }).fill(outputName);
    await expect(create.getByLabel("订阅名称", { exact: true })).toHaveValue(
      outputName,
    );
    await create.getByLabel("目标客户端", { exact: true }).click();
    await page
      .getByRole("option", { name: "sing-box 1.14.3", exact: true })
      .click();
    await create
      .getByRole("button", { name: "检查发布内容", exact: true })
      .click();
    await expect(
      create.getByRole("definition").filter({
        hasText: intent === "endpoint" ? "节点「North Gate」" : /^直连$/,
      }),
    ).toBeVisible();
    const publish = create.getByRole("button", {
      name: `创建并发布「${outputName}」`,
      exact: true,
    });
    await expect(publish).toBeEnabled();
    await expect(publish).toBeInViewport({ ratio: 1 });
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`first-use-${intent}-review-mobile.png`),
      animations: "disabled",
    });
    await publish.click();
    const access = page.getByRole("dialog", {
      name: `获取「${outputName}」`,
      exact: true,
    });
    await expect(access).toBeVisible();
    const link = access.getByLabel("订阅链接", { exact: true });
    await expect(link).toBeVisible();
    const deliveredPath = new URL(await link.inputValue()).pathname;
    await page.keyboard.press("Escape");
    await expect(access).not.toBeVisible();
    const response = await page.request.get(deliveredPath);
    expect(response.ok(), "Newly obtained loopback delivery succeeds").toBe(
      true,
    );
    const config = JSON.parse(await response.text()) as {
      route: { final: string };
      outbounds: Array<{
        type: string;
        tag: string;
        server?: string;
        server_port?: number;
      }>;
    };
    const north = config.outbounds.find(
      (item) => item.server === "north.example",
    );
    const south = config.outbounds.find(
      (item) => item.server === "south.example",
    );
    expect(
      Boolean(north && south),
      "Both imported synthetic choices are exported",
    ).toBe(true);
    expect(north?.server_port).toBe(1080);
    expect(south?.server_port).toBe(1081);
    const direct = config.outbounds.find((item) => item.type === "direct");
    expect(config.route.final).toBe(
      intent === "endpoint" ? north!.tag : direct!.tag,
    );
    const profiles = await readJSON<SavedProfile[]>(page, "/me/profiles");
    const createdProfile = profiles.find((item) => item.name === profileName)!;
    expect(profiles).toHaveLength(beforeProfiles.length + 1);
    expect(createdProfile.ir.defaultAction.kind).toBe(intent);
    const outputs = await readJSON<PublishedOutput[]>(page, "/me/outputs");
    const createdOutput = outputs.find((item) => item.name === outputName)!;
    expect(outputs).toHaveLength(beforeOutputs.length + 1);
    expect(createdOutput.profileId).toBe(createdProfile.id);
    expect(createdOutput.target.adapterId).toBe("sing-box");
    expect(createdOutput.mode).toBe("full");
    expect(createdOutput.routingSummary).toMatchObject({
      kind: "advanced",
      advanced: {
        nodeCount: 2,
        defaultAction:
          intent === "endpoint"
            ? { kind: "endpoint", label: "North Gate" }
            : { kind: "direct" },
      },
    });
    expect(digest(deliveredPath)).toBe(
      (await frozenState(page, createdOutput.id)).accessFingerprint,
    );
    await report(testInfo, `first-use ${intent}`, {
      sourceImportPerformedThroughUI: true,
      effectiveConnections: 2,
      importDidNotChangeRouting: true,
      explicitDefault: intent,
      client: "sing-box",
      createdProfiles: 1,
      createdOutputs: 1,
      immediateAccessAndFrozenRouteAgree: true,
      liveTrafficVerified: false,
    });
  });
}

test("existing strategy groups remain editable and revoked recovery replaces only the selected client link", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { profile, outputs } = await seedIndependentOutputs(page);
  const [selected, sibling] = outputs;
  const beforeSelected = await frozenState(page, selected.id);
  const beforeSibling = await frozenState(page, sibling.id);
  const oldAccess = await readJSON<{ feedPath: string }>(
    page,
    `/me/outputs/${selected.id}/access`,
  );
  // Keep access identities only in memory; assertions/reporting use fingerprints.
  const oldPath = new URL(oldAccess.feedPath, "http://127.0.0.1:4173").pathname;
  const profilesBefore = (await readJSON<SavedProfile[]>(page, "/me/profiles"))
    .map((item) => item.id)
    .sort();
  const outputIdsBefore = (
    await readJSON<PublishedOutput[]>(page, "/me/outputs")
  )
    .map((item) => item.id)
    .sort();
  const session = await readJSON<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const groupName = "Work choices";
  const configured = {
    ...profile,
    ir: {
      ...profile.ir,
      groups: [
        {
          id: `group-${profile.id}`,
          name: groupName,
          kind: "manual",
          members: [{ kind: "direct" }],
        },
      ],
    },
  };
  // Fixture setup only: a previously saved group and already-revoked link.
  // Recovery, review, and obtaining the replacement access are real UI actions below.
  const saved = await page.request.put(`/api/me/profiles/${profile.id}`, {
    headers: await currentProfileFixtureHeaders(
      page.request,
      profile.id,
      headers,
    ),
    data: configured,
  });
  expect(saved.ok(), "Existing manual-group setup succeeds").toBe(true);
  const revoked = await page.request.post(
    `/api/me/outputs/${selected.id}/revoke`,
    { headers },
  );
  expect(revoked.ok(), "Existing revoked-link setup succeeds").toBe(true);
  expect(
    (await page.request.get(oldPath)).status(),
    "Revoked access is unavailable before the UI task",
  ).toBe(404);
  await page.goto(`/#subscriptions?profile=${profile.id}`);
  await page.reload();
  const article = page.getByRole("article", {
    name: `分流配置 ${profile.name}`,
    exact: true,
  });
  await article.getByRole("button", { name: "编辑配置", exact: true }).click();
  await page.getByRole("tab", { name: "策略组", exact: true }).click();
  const groups = page.getByRole("tabpanel", { name: "策略组", exact: true });
  await expect(groups.getByLabel("策略组名称", { exact: true })).toHaveValue(
    groupName,
  );
  await expect(groups.getByText("暂无策略组", { exact: true })).toHaveCount(0);
  await expect(
    groups.getByRole("button", { name: "添加策略组", exact: true }),
  ).toHaveCount(1);
  await expect(groups.getByText("让连接各司其职", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator(".default-route [role='combobox']")).toContainText(
    "直连",
  );
  await groups.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("populated-group-content-desktop.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await groups
    .getByLabel("策略组名称", { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(groups.getByLabel("策略组名称", { exact: true })).toBeInViewport(
    { ratio: 1 },
  );
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: testInfo.outputPath("populated-group-content-mobile.png"),
    animations: "disabled",
  });
  const groupField = groups.getByLabel("策略组名称", { exact: true });
  const editedGroupName = "Work choices adjusted on mobile";
  await groupField.fill(editedGroupName);
  await page.setViewportSize({ width: 390, height: 600 });
  await verifyLowerEditorCompletion(page, groupField);
  await page.screenshot({
    path: testInfo.outputPath("lower-group-sticky-completion-390-short.png"),
    animations: "disabled",
  });
  await auditReflowAndTextScale(
    page,
    testInfo,
    "lower-group-completion",
    page.locator(".profile-intent-editor"),
    page.getByRole("button", { name: "保存草稿", exact: true }),
    groupField,
    groupField,
    () => verifyLowerEditorCompletion(page, groupField),
  );
  await verifyLowerEditorCompletion(page, groupField);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "保存与检查配置", exact: true })
      .getByRole("status"),
  ).toHaveText("草稿已保存");
  await page.getByRole("tab", { name: "分流规则", exact: true }).click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  const ruleField = page.getByLabel("规则匹配值", { exact: true });
  await ruleField.fill("mobile-routing.example");
  const ruleDestination = page.getByRole("combobox", {
    name: "规则 1 的流量去向",
    exact: true,
  });
  await ruleDestination.click();
  const destinationList = await ruleDestination.getAttribute("aria-controls");
  const destinationPopup = page
    .locator(`[id="${destinationList}"]`)
    .locator('xpath=ancestor-or-self::*[@data-slot="popover-content"]');
  await destinationPopup
    .locator("[role='option']")
    .getByText("直连", { exact: true })
    .click();
  await page.setViewportSize({ width: 320, height: 568 });
  await verifyLowerEditorCompletion(page, ruleField);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("lower-rule-sticky-completion-320-short.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "保存与检查配置", exact: true })
      .getByRole("status"),
  ).toHaveText("草稿已保存");
  expect(await frozenState(page, sibling.id)).toEqual(beforeSibling);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByLabel("配置名称", { exact: true })).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  const targetRow = article.getByRole("group", {
    name: `客户端订阅 ${selected.name}`,
    exact: true,
  });
  await targetRow
    .getByRole("button", { name: "检查重新发布", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: `检查订阅更新「${selected.name}」`,
    exact: true,
  });
  await expect(
    review.getByText("兼容检查通过。", { exact: true }),
  ).toBeVisible();
  const consequence = review
    .getByRole("group", { name: "更新确认", exact: true })
    .getByText("发布后请在客户端换用新链接，其他订阅保留原状。", {
      exact: true,
    });
  await expect(consequence).toBeVisible();
  await expect(
    review.getByText("沿用当前链接，其他订阅保留原状。", { exact: true }),
  ).toHaveCount(0);
  const confirm = review.getByRole("button", {
    name: `重新发布并生成新链接「${selected.name}」`,
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await expect(consequence).toBeInViewport({ ratio: 1 });
  await expect(confirm).toBeInViewport({ ratio: 1 });
  expect(
    (await page.request.get(oldPath)).status(),
    "Preview does not recover a revoked link",
  ).toBe(404);
  expect(
    (await readJSON<PublishedOutput[]>(page, "/me/outputs")).find(
      (item) => item.id === selected.id,
    )?.status,
  ).toBe("revoked");
  expect(await frozenState(page, sibling.id)).toEqual(beforeSibling);
  await page.screenshot({
    path: testInfo.outputPath("revoked-republication-review-desktop.png"),
    animations: "disabled",
  });
  await verifyMobilePublicationReview(
    page,
    review,
    confirm,
    testInfo.outputPath("revoked-republication-review-mobile.png"),
    "update",
  );
  await expect(consequence).toBeInViewport({ ratio: 1 });
  await confirm.click();
  await expect(review).not.toBeVisible();
  // Successful recovery itself hands off to this exact Output's new access.
  const access = page.getByRole("dialog", {
    name: `获取「${selected.name}」`,
    exact: true,
  });
  await expect(access).toBeVisible();
  const link = access.getByLabel("订阅链接", { exact: true });
  await expect(link).toBeVisible();
  const newPath = new URL(await link.inputValue()).pathname;
  const newFingerprint = digest(newPath);
  await page.keyboard.press("Escape");
  await expect(access).not.toBeVisible();
  // Access is closed before any assertion can trigger an automatic failure image.
  expect(
    (await page.request.get(newPath)).status(),
    "Replacement local delivery succeeds",
  ).toBe(200);
  expect(
    (await page.request.get(oldPath)).status(),
    "Old access stays invalid after recovery",
  ).toBe(404);
  const recovered = await frozenState(page, selected.id);
  expect(recovered.accessFingerprint).toBe(newFingerprint);
  expect(recovered.accessFingerprint).not.toBe(
    beforeSelected.accessFingerprint,
  );
  expect(recovered.id).toBe(beforeSelected.id);
  expect(recovered.profileId).toBe(beforeSelected.profileId);
  expect(recovered.target).toEqual(beforeSelected.target);
  expect(recovered.mode).toBe(beforeSelected.mode);
  expect(recovered.status).toBe("published");
  expect(await frozenState(page, sibling.id)).toEqual(beforeSibling);
  expect(
    (await readJSON<SavedProfile[]>(page, "/me/profiles"))
      .map((item) => item.id)
      .sort(),
  ).toEqual(profilesBefore);
  expect(
    (await readJSON<PublishedOutput[]>(page, "/me/outputs"))
      .map((item) => item.id)
      .sort(),
  ).toEqual(outputIdsBefore);
  const finalProfile = await readJSON<typeof configured>(
    page,
    `/me/profiles/${profile.id}`,
  );
  expect(finalProfile.ir.groups).toEqual(
    configured.ir.groups.map((group) => ({ ...group, name: editedGroupName })),
  );
  expect(finalProfile.ir.rules).toHaveLength(1);
  expect(finalProfile.ir.rules[0]).toMatchObject({
    match: { op: "domain-suffix", value: "mobile-routing.example" },
    action: { kind: "direct" },
  });
  expect(finalProfile.ir.defaultAction).toEqual({ kind: "direct" });
  await report(testInfo, "existing groups and revoked recovery", {
    fixtureSetup:
      "one existing manual group and one revoked Output, local synthetic account",
    populatedGroupEditableWithoutTutorialSlogan: true,
    lowerGroupAndRuleSavedThroughSingleStickyCompletion: true,
    lowerEditorShortViewports: ["390x600", "320x568"],
    lowerGroupReflowAndDoubledTextUncovered: true,
    reviewDidNotRecoverAccess: true,
    userExplicitlyConfirmedNewLink: true,
    replacementDeliveryWorks: true,
    oldDeliveryRemainsInvalid: true,
    sameOutputIdentityAndTarget: true,
    siblingFrozenStateAndAccessUnchanged: true,
    profileAndOutputCountsUnchanged: true,
    mobileReviewViewport: "390x844",
    mobileFooterTouchTargetMinimumHeight: 44,
  });
});

for (const entry of ["workspace", "legacy-profile"] as const) {
  test(`${entry}: explicit publication changes only one of two independent client links`, async ({
    page,
  }, testInfo) => {
    await openWorkspace(page);
    const { profile, outputs } = await seedIndependentOutputs(page);
    const [laptop, phone] = outputs;
    const selected = entry === "workspace" ? phone : laptop;
    const sibling = entry === "workspace" ? laptop : phone;
    const beforeSelected = await frozenState(page, selected.id);
    const beforeSibling = await frozenState(page, sibling.id);
    if (entry === "workspace") {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`/#subscriptions?profile=${profile.id}`);
      const overviewProfile = page.getByRole("article", {
        name: `分流配置 ${profile.name}`,
      });
      await expect(overviewProfile).toContainText("2 个客户端订阅");
      await expect(overviewProfile).toContainText(laptop.name);
      await expect(overviewProfile).toContainText(phone.name);
      await expect(
        page.getByRole("region", { name: "已发布分流", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("workspace-two-independent-clients.png"),
        animations: "disabled",
      });
      await overviewProfile
        .getByRole("button", { name: `查看订阅 ${laptop.name}`, exact: true })
        .click();
      await expect(
        page.getByText("与已保存草稿一致", { exact: true }),
      ).toBeVisible();
      await editSelectedOutputConfiguration(page, laptop.name);
    } else {
      await page.goto(`/#profiles?profile=${profile.id}`);
      await page
        .getByRole("article", { name: `分流配置 ${profile.name}` })
        .getByRole("button", { name: "编辑配置", exact: true })
        .click();
      // Existing Output target must win over the Profile's new-output default.
      await page.getByRole("tab", { name: "检查与预览", exact: true }).click();
      await page
        .getByLabel("预览客户端", { exact: true })
        .click();
      await page.getByRole("option", { name: "sing-box", exact: true }).click();
    }
    await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
      profile.name,
    );
    await page.getByText("关联订阅（2）", { exact: true }).click();
    const linked = page.locator(".profile-linked-details");
    await expect(linked.getByRole("listitem")).toHaveCount(2);
    await expect(
      linked.getByRole("listitem").filter({ hasText: laptop.name }),
    ).toHaveCount(1);
    await expect(
      linked.getByRole("listitem").filter({ hasText: phone.name }),
    ).toHaveCount(1);
    await changeDefault(page, "拒绝连接");
    await page.getByRole("button", { name: "保存并检查", exact: true }).click();
    const target = page.getByRole("dialog", {
      name: "选择客户端订阅",
      exact: true,
    });
    await expect(target).toBeVisible();
    // Target loading is a separate live status; the save confirmation must remain exact.
    await expect(
      target.getByRole("status").filter({ hasText: /^草稿已保存$/ }),
    ).toHaveText("草稿已保存");
    await expect(target).toContainText(profile.name);
    if (entry === "workspace") {
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("publication-target-selection-desktop.png"),
        animations: "disabled",
      });
      // Returning from a check does not undo the named save action.
      await target
        .getByRole("button", { name: "返回编辑", exact: true })
        .click();
      await expect(target).not.toBeVisible();
      await expect(
        page
          .getByRole("group", { name: "保存与检查配置", exact: true })
          .getByRole("status"),
      ).toHaveText("草稿已保存");
      const savedProfile = await readJSON<SavedProfile>(
        page,
        `/me/profiles/${profile.id}`,
      );
      expect(savedProfile.ir.defaultAction.kind).toBe("reject");
      // AntD's decorative loading icon can remain in the AX name after motion.
      // Match the exact visible action, but independently require real readiness.
      const checkSaved = page
        .getByRole("button")
        .filter({ hasText: /^检查发布$/ });
      await expect(checkSaved).toHaveCount(1);
      await expect(checkSaved).toHaveText("检查发布");
      await expect(checkSaved).toBeEnabled();
      await expect(checkSaved).not.toHaveAttribute("aria-busy", "true");
      const unexpectedWrites: string[] = [];
      const observeWrite = (request: import("@playwright/test").Request) => {
        const path = new URL(request.url()).pathname;
        if (
          ["POST", "PUT", "PATCH"].includes(request.method()) &&
          (/^\/api\/me\/profiles(?:\/[^/]+)?$/.test(path) ||
            /^\/api\/me\/outputs\/[^/]+\/publish$/.test(path))
        )
          unexpectedWrites.push(request.method());
      };
      page.on("request", observeWrite);
      await checkSaved.click();
      await expect(target).toBeVisible();
      await expect(
        target.getByRole("button", { name: "检查所选订阅", exact: true }),
      ).toBeEnabled();
      expect(
        unexpectedWrites,
        "Checking the saved draft neither saves it again nor publishes",
      ).toEqual([]);
      page.off("request", observeWrite);
    }
    if (entry === "legacy-profile") {
      await expect(
        target.getByRole("button", { name: "检查所选订阅", exact: true }),
      ).toBeDisabled();
    } else {
      await expect(
        target.getByRole("radio", {
          name: new RegExp(`更新「${laptop.name}」`),
        }),
      ).toBeChecked();
    }
    // Auto-save must not change either frozen publication.
    expect(await frozenState(page, selected.id)).toEqual(beforeSelected);
    expect(await frozenState(page, sibling.id)).toEqual(beforeSibling);
    await target
      .getByRole("radio", { name: new RegExp(`更新「${selected.name}」`) })
      .check();
    const previewResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/me/profiles/${profile.id}/preview`) &&
        response.request().method() === "POST",
    );
    await target
      .getByRole("button", { name: "检查所选订阅", exact: true })
      .click();
    const preview = await (await previewResponse).json();
    expect(preview.previewScope).toBe("output-update");
    expect(preview.outputId).toBe(selected.id);
    const review = page.getByRole("dialog", {
      name: `检查订阅更新「${selected.name}」`,
      exact: true,
    });
    await expect(
      review.getByText("兼容检查通过。", { exact: true }),
    ).toBeVisible();
    await expect(review).toContainText(
      `${selected.target.adapterId} ${selected.target.version}`,
    );
    await expect(review).toContainText("沿用当前链接，其他订阅保留原状。");
    const confirm = review.getByRole("button", {
      name: `确认更新「${selected.name}」`,
      exact: true,
    });
    const technical = review.getByRole("button", {
      name: "查看待发布技术配置",
      exact: true,
    });
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(review.locator("pre")).not.toBeVisible();
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await technical.click();
    await expect(technical).toHaveAttribute("aria-expanded", "true");
    await waitForTechnicalLayout(review);
    await review.locator("pre").scrollIntoViewIfNeeded();
    await recordTechnicalScrollGeometry(review);
    await expect(review.locator("pre")).toBeInViewport();
    await expect(review.locator("pre")).not.toHaveText("");
    await technical.click();
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: testInfo.outputPath(`${entry}-explicit-target-review.png`),
      fullPage: false,
      animations: "disabled",
    });
    if (entry === "workspace") {
      await verifyMobilePublicationReview(
        page,
        review,
        confirm,
        testInfo.outputPath("workspace-explicit-target-review-mobile.png"),
        "update",
      );
    }
    if (entry === "workspace")
      await auditReflowAndTextScale(
        page,
        testInfo,
        "publication-review",
        review,
        confirm,
        review.locator("[data-slot='dialog-title']"),
        review
          .getByRole("region", { name: "分流比较", exact: true })
          .locator(".routing-intent-versions > div")
          .filter({ has: page.getByText("待发布", { exact: true }) })
          .getByText("拒绝连接", { exact: true }),
      );
    await confirm.click();
    await expect(review).not.toBeVisible();
    const afterSelected = await frozenState(page, selected.id);
    const afterSibling = await frozenState(page, sibling.id);
    expect(afterSelected.accessFingerprint).toBe(
      beforeSelected.accessFingerprint,
    );
    expect(afterSelected.contentFingerprint).not.toBe(
      beforeSelected.contentFingerprint,
    );
    expect(afterSelected.target).toEqual(beforeSelected.target);
    expect(afterSelected.mode).toBe(beforeSelected.mode);
    expect(afterSibling).toEqual(beforeSibling);
    const all = await readJSON<PublishedOutput[]>(page, "/me/outputs");
    expect(
      all
        .filter((item) => item.profileId === profile.id)
        .map((item) => item.id)
        .sort(),
    ).toEqual(outputs.map((item) => item.id).sort());
    await report(testInfo, entry, {
      oneOutputUpdated: true,
      siblingFrozenStateUnchanged: true,
      originalAccessIdentityPreserved: true,
      outputCount: 2,
      selectedTarget: afterSelected.target,
      selectedMode: afterSelected.mode,
      ...(entry === "workspace"
        ? {
            mobileReviewViewport: "390x844",
            mobileConfirmationEntirelyVisible: true,
            mobileFooterTouchTargetMinimumHeight: 44,
            mobileNoHorizontalOverflow: true,
            mobileTechnicalPanelEntirelyVisibleWhenExpanded: true,
          }
        : {}),
    });
  });
}

test("saving a draft leaves frozen advanced published summary and delivery unchanged", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const { profile, outputs } = await seedIndependentOutputs(page);
  const output = outputs[0];
  const before = await frozenState(page, output.id);
  await page.goto(`/#subscriptions?profile=${profile.id}&output=${output.id}`);
  const summary = page.getByRole("region", { name: "已发布分流", exact: true });
  await expect(summary.getByText("直连", { exact: true })).toBeVisible();
  await editSelectedOutputConfiguration(page, output.name);
  await changeDefault(page, "拒绝连接");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: `${output.name} 的订阅详情`, exact: true })
      .getByText("已保存的修改尚未发布", { exact: true }),
  ).toBeVisible();
  await expect(summary.getByText("直连", { exact: true })).toBeVisible();
  await expect(summary.getByText("拒绝连接", { exact: true })).toHaveCount(0);
  expect(await frozenState(page, output.id)).toEqual(before);
  const saved = await readJSON<SavedProfile>(
    page,
    `/me/profiles/${profile.id}`,
  );
  expect(saved.ir.defaultAction.kind).toBe("reject");
  await page.screenshot({
    path: testInfo.outputPath("frozen-summary-desktop.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await summary.scrollIntoViewIfNeeded();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: testInfo.outputPath("frozen-summary-mobile.png"),
    fullPage: false,
    animations: "disabled",
  });
  await report(testInfo, "draft-only", {
    draftDefault: "reject",
    publishedDefault: "direct",
    frozenDeliveryUnchanged: true,
    mobileOverflow: false,
  });
});

test("invalid JSON, cancel, and Back retain the draft until an explicit retry succeeds", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const name = `Recovery draft ${Date.now().toString(36)}`;
  await startConfiguration(page);
  await page.getByLabel("配置名称", { exact: true }).fill(name);
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
  const valid = await editor.inputValue();
  const invalid = '{"keep_this_draft":';
  await editor.fill(invalid);
  await drawer.getByRole("button", { name: "应用到草稿", exact: true }).click();
  await expect(editor).toHaveValue(invalid);
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "放弃尚未应用的 JSON 修改？",
    exact: true,
  });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toHaveValue(invalid);
  await page.screenshot({
    path: testInfo.outputPath("invalid-json-retained.png"),
    fullPage: false,
    animations: "disabled",
  });
  const corrected = JSON.parse(valid);
  corrected.defaultAction = { kind: "reject" };
  await editor.fill(JSON.stringify(corrected, null, 2));
  await drawer.getByRole("button", { name: "应用到草稿", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  const leave = page.getByRole("alertdialog", {
    name: "放弃未保存的修改？",
    exact: true,
  });
  await leave.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(name);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
  const profiles = await readJSON<SavedProfile[]>(page, "/me/profiles");
  const saved = profiles.find((profile) => profile.name === name);
  expect(saved?.ir.defaultAction.kind).toBe("reject");
  const outputs = await readJSON<PublishedOutput[]>(page, "/me/outputs");
  expect(
    outputs.filter((output) => output.profileId === saved!.id),
  ).toHaveLength(0);
  await report(testInfo, "JSON recovery", {
    invalidTextRetained: true,
    cancelKeptText: true,
    backKeptDraft: true,
    correctedSaveSucceeded: true,
    outputCount: 0,
  });
});

test("invalid and mismatched deep-link scope never silently selects a different configuration", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const { profile, outputs } = await seedIndependentOutputs(page);
  const other = await seedIndependentOutputs(page, 1);
  const before = await Promise.all(
    outputs.map((output) => frozenState(page, output.id)),
  );
  const scopedOverview = `#subscriptions?profile=${profile.id}&output=${outputs[0].id}`;
  const scopedProfiles = `#profiles?profile=${profile.id}&output=${outputs[0].id}`;
  const scopedOutputs = `#outputs?profile=${profile.id}&output=${outputs[0].id}`;
  const expectScope = async (hash: string) =>
    expect.poll(() => page.evaluate(() => location.hash)).toBe(hash);
  await page.goto(`/${scopedOverview}`);
  // Historical entrypoints are real scoped URLs, not tabs in the new hierarchy.
  await page.goto(`/${scopedProfiles}`);
  await editSelectedOutputConfiguration(page, outputs[0].name);
  const unsavedName = `${profile.name} retained`;
  await page.getByLabel("配置名称", { exact: true }).fill(unsavedName);
  await page.goBack();
  const guard = page.getByRole("alertdialog", {
    name: "放弃未保存的修改？",
    exact: true,
  });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(guard).not.toBeVisible();
  await expectScope(scopedProfiles);
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
    unsavedName,
  );
  await page.goto("/#profiles?profile=unavailable-profile");
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(guard).not.toBeVisible();
  await expectScope(scopedProfiles);
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
    unsavedName,
  );
  const discardEditor = async () => {
    await page.getByRole("button", { name: "返回", exact: true }).click();
    const local = page.getByRole("alertdialog", {
      name: "放弃未保存的修改？",
      exact: true,
    });
    await local.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(local).not.toBeVisible();
    await expect(page.getByLabel("配置名称", { exact: true })).toHaveCount(0);
  };
  await discardEditor();
  // Build an actual forward entry while clean, then dirty the restored source.
  await page.goto(`/${scopedOutputs}`);
  await page.goBack();
  await expectScope(scopedProfiles);
  await editSelectedOutputConfiguration(page, outputs[0].name);
  await page
    .getByLabel("配置名称", { exact: true })
    .fill(`${unsavedName} forward`);
  await page.goForward();
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(guard).not.toBeVisible();
  await expectScope(scopedProfiles);
  await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
    `${unsavedName} forward`,
  );
  await discardEditor();
  await page.goto(
    "/#subscriptions?profile=unavailable-profile&output=unavailable-output",
  );
  await expect(
    page.getByText("此分流配置不可用", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("所选客户端订阅不在当前可访问范围", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "已发布分流", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "编辑配置", exact: true }),
  ).toHaveCount(0);
  await page.goto(
    "/#outputs?profile=unavailable-profile&output=unavailable-output",
  );
  await expectScope(
    "#outputs?profile=unavailable-profile&output=unavailable-output",
  );
  await expect(
    page.getByRole("button", { name: `管理 ${outputs[0].name}`, exact: true }),
  ).toHaveCount(0);
  await page.goto(
    `/#subscriptions?profile=${profile.id}&output=${other.outputs[0].id}`,
  );
  await expect(
    page.getByText("客户端订阅不属于当前分流配置", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "已发布分流", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", {
      name: `${other.outputs[0].name} 的订阅详情`,
      exact: true,
    }),
  ).toHaveCount(0);
  await page.goto(
    `/#subscriptions?profile=${profile.id}&output=unavailable-output`,
  );
  await expect(
    page.getByText("所选客户端订阅不在当前可访问范围", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除订阅选择", exact: true }).click();
  await expectScope(`#subscriptions?profile=${profile.id}`);
  const selectedProfile = page.getByRole("article", {
    name: `分流配置 ${profile.name}`,
    exact: true,
  });
  await expect(selectedProfile).toBeVisible();
  await expect(selectedProfile).toContainText(outputs[0].name);
  await expect(selectedProfile).toContainText(outputs[1].name);
  await expect(
    page.getByRole("region", { name: "已发布分流", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("article", {
      name: `分流配置 ${other.profile.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (await readJSON<SavedProfile>(page, `/me/profiles/${profile.id}`)).name,
  ).toBe(profile.name);
  expect(
    await Promise.all(outputs.map((output) => frozenState(page, output.id))),
  ).toEqual(before);
  await page.screenshot({
    path: testInfo.outputPath("explicit-scope-recovery.png"),
    animations: "disabled",
  });
  await report(testInfo, "scope safety", {
    browserBackCancelRetainsScopedDraft: true,
    browserForwardCancelRetainsScopedDraft: true,
    queryOnlyNavigationCancelRetainsScopedDraft: true,
    unknownProfileNeverFallsBack: true,
    unknownOutputNeverFallsBack: true,
    knownButMismatchedOutputNeverFallsBack: true,
    legacyURLsRetainScope: true,
    explicitClearRestoresOnlySelectedProfileAndNoAutomaticOutput: true,
    backendUnchanged: true,
  });
});

test("operator keeps line and user context through authorization, entry preparation, and a non-executing scoped batch plan", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const session = await readJSON<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const suffix = Date.now().toString(36);
  const create = async (kind: string, data: unknown) => {
    const response = await page.request.post(`/api/${kind}`, { headers, data });
    expect(response.ok(), `Synthetic ${kind} setup succeeds`).toBe(true);
    return response.json();
  };
  const host = {
    id: `journey-host-${suffix}`,
    name: "Synthetic operator host",
    address: "operator.example",
  };
  const instance = {
    id: `journey-core-${suffix}`,
    hostId: host.id,
    name: "Synthetic operator core",
    adapterId: "routeweaver/managed-xray",
    version: "26.3.27-rw1",
  };
  const endpoint = {
    id: `journey-endpoint-${suffix}`,
    instanceId: instance.id,
    name: "Synthetic operator entry",
    connection: {
      protocol: "vless",
      host: "0.0.0.0",
      port: 12345,
      uuid: "00000000-0000-4000-8000-000000000099",
    },
  };
  const deployment = {
    id: `journey-path-${suffix}`,
    name: `Operator path ${suffix}`,
    ir: {
      schemaVersion: "1.0",
      id: `journey-path-${suffix}`,
      topologyRevision: "t1",
      programs: [
        { instance, listener: endpoint, egress: [], rules: [], resources: [] },
      ],
    },
  };
  const line = {
    id: `journey-line-${suffix}`,
    name: `Operator line ${suffix}`,
    deploymentId: deployment.id,
    endpointIds: [endpoint.id],
    publicHost: "127.0.0.1",
    publicPort: 12345,
  };
  const user = {
    id: `journey-user-${suffix}`,
    name: `Operator user ${suffix}`,
    enabled: true,
    quotaBytes: 0,
    usedBytes: 0,
  };
  await create("hosts", host);
  await create("core-instances", instance);
  await create("managed-endpoints", endpoint);
  await create("server-deployments", deployment);
  await create("published-routes", line);
  await create("users", user);
  const service = {
    id: `journey-service-${suffix}`,
    name: "Synthetic operator access",
    routeIds: [line.id],
    quotaBytes: 0,
    cycle: { mode: "none", timezone: "UTC+8", anchor: "2026-01-01T00:00:00Z" },
  };
  await create("services", service);
  const entitlement = await page.request.put(
    `/api/users/${user.id}/entitlement`,
    { headers, data: { serviceId: service.id, cycle: service.cycle } },
  );
  expect(
    entitlement.ok(),
    "Synthetic operator entitlement setup succeeds",
  ).toBe(true);

  await page.goto(`/#published-routes?line=${line.id}`);
  const detail = page.getByRole("dialog", { name: line.name, exact: true });
  await expect(detail).toBeVisible();
  await detail.getByLabel("线路使用用户", { exact: true }).click();
  await page.getByRole("option", { name: user.name, exact: true }).click();
  await expect(detail.getByText(/已获准使用此线路/)).toBeVisible();
  await expect(
    detail.getByText("尚未准备此用户的独立入口", { exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText("尚未确认应用");
  await expect(detail).toContainText("获取订阅时，会按当时的授权、额度与入口状态重新检查是否可交付。");
  await detail
    .getByRole("button", { name: "检查或调整用户授权", exact: true })
    .click();
  const policy = page.getByRole("dialog", {
    name: `${user.name} 的服务授权`,
    exact: true,
  });
  await expect(policy).toBeVisible();
  await policy.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(policy).not.toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`#published-routes\\?line=${line.id}&user=${user.id}$`),
  );
  await detail
    .getByRole("button", { name: "准备独立入口", exact: true })
    .click();
  const principal = page.getByRole("dialog", {
    name: `配置「${line.name}」的用户入口`,
    exact: true,
  });
  await expect(
    principal.getByRole("combobox", { name: /^\*?\s*用户$/ }),
  ).toBeDisabled();
  await expect(principal).toContainText(user.name);
  await principal
    .getByRole("button", { name: "检查此用户授权", exact: true })
    .click();
  await expect(policy).toBeVisible();
  await policy.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(principal).toBeVisible();
  await principal.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(principal).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("operator-line-progress.png"),
    fullPage: false,
    animations: "disabled",
  });
  await detail
    .getByRole("link", { name: "检查并应用转发路径", exact: true })
    .click();
  const path = page.getByRole("dialog", { name: deployment.name, exact: true });
  await expect(path).toBeVisible();
  await path
    .getByRole("button", { name: "分阶段应用修改", exact: true })
    .click();
  const plan = page.getByRole("dialog", {
    name: `${deployment.name}的应用配置`,
    exact: true,
  });
  await expect(plan).toBeVisible();
  await expect(
    plan.getByRole("combobox", { name: "批量操作", exact: true }),
  ).toHaveCount(0);
  await expect(
    plan.getByRole("combobox", { name: "批量变更转发路径", exact: true }),
  ).toHaveCount(0);
  await expect(
    plan.getByRole("checkbox", {
      name: `选择实例 ${instance.name}`,
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    plan.getByText("已选择 0 个实例", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("operator-locked-empty-scope.png"),
    fullPage: false,
    animations: "disabled",
  });
  await plan.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(plan).not.toBeVisible();

  // One global discard decision must resolve a same-page destination without
  // keeping the old editor or asking the user to discard the same draft twice.
  const pathsBeforeDraft = await readJSON<{ id: string }[]>(
    page,
    "/server-deployments",
  );
  await path.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(path).not.toBeVisible();
  const pathListHash = `#routes?line=${line.id}&user=${user.id}`;
  const destinationHash = `#routes?deployment=${deployment.id}&line=${line.id}&user=${user.id}`;
  await page.evaluate((hash) => {
    location.hash = hash;
  }, pathListHash);
  await page.getByRole("button", { name: "新建转发路径", exact: true }).click();
  const routeDraft = page.getByRole("dialog", {
    name: "新建转发路径",
    exact: true,
  });
  await routeDraft
    .getByRole("textbox", { name: "转发路径名称", exact: true })
    .fill("Discard this synthetic path draft");
  await page.evaluate((hash) => {
    location.hash = hash;
  }, destinationHash);
  const globalDiscard = page.getByRole("alertdialog", {
    name: "放弃未保存的修改？",
    exact: true,
  });
  await expect(globalDiscard).toBeVisible();
  // A native hash destination has no owned lineage: do not rewrite that entry
  // before the user's decision. Continuing this editor would create a new entry.
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe(destinationHash);
  await expect(
    globalDiscard.getByText(
      "继续编辑会建立新的历史记录，并清除浏览器的前进记录。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    globalDiscard.getByRole("button", { name: "继续编辑", exact: true }),
  ).toBeFocused();
  await globalDiscard
    .getByRole("button", { name: "继续编辑", exact: true })
    .click();
  await expect(globalDiscard).not.toBeVisible();
  await expect(routeDraft).toBeVisible();
  await expect(
    routeDraft.getByRole("textbox", { name: "转发路径名称", exact: true }),
  ).toHaveValue("Discard this synthetic path draft");
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe(pathListHash);
  // Cancel pushed a disclosed return entry; the untouched target remains Back.
  await page.goBack();
  await expect(globalDiscard).toBeVisible();
  await expect(
    globalDiscard.getByText(
      "继续编辑会建立新的历史记录，并清除浏览器的前进记录。",
      { exact: true },
    ),
  ).toBeVisible();
  await globalDiscard
    .getByRole("button", { name: "放弃修改并离开", exact: true })
    .click();
  await expect(globalDiscard).not.toBeVisible();
  await expect(routeDraft).not.toBeVisible();
  await expect(path).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toBe(destinationHash);
  await expect(
    page.getByRole("alertdialog", {
      name: "放弃尚未保存的转发路径修改？",
      exact: true,
    }),
  ).toHaveCount(0);
  const pathsAfterDiscard = await readJSON<{ id: string }[]>(
    page,
    "/server-deployments",
  );
  expect(pathsAfterDiscard.map((item) => item.id).sort()).toEqual(
    pathsBeforeDraft.map((item) => item.id).sort(),
  );
  await path.getByRole("link", { name: "返回线路", exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(user.name);
  await expect(page).toHaveURL(
    new RegExp(`#published-routes\\?line=${line.id}&user=${user.id}$`),
  );
  const state = await readJSON<{ phase: string }>(
    page,
    `/agent/instances/${instance.id}/state`,
  );
  expect(state.phase).toBe("unregistered");
  const entries = await readJSON<unknown[]>(page, `/users/${user.id}/entries`);
  expect(entries).toHaveLength(0);
  await report(testInfo, "operator continuity", {
    lineAndUserPreserved: true,
    unknownDeliveryNotClaimed: true,
    scopedPlanLocked: true,
    initialTargets: 0,
    credentialsCreated: false,
    agentPhase: state.phase,
    samePageDiscardOpensRequestedPath: true,
    duplicateDiscardPrompt: false,
    pathCreatedFromDiscardedDraft: false,
    executed: false,
  });
});

test("scoped configuration creates one independent second-client subscription and immediately exposes its new link", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const { profile, outputs } = await seedIndependentOutputs(page, 1);
  const original = outputs[0];
  const beforeOriginal = await frozenState(page, original.id);
  const beforeProfileIds = (
    await readJSON<SavedProfile[]>(page, "/me/profiles")
  )
    .map((item) => item.id)
    .sort();
  await page.goto(`/#outputs?profile=${profile.id}`);
  await page
    .getByRole("article", { name: `分流配置 ${profile.name}`, exact: true })
    .getByRole("button", {
      name: `为 ${profile.name} 新增客户端订阅`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog", { name: "选择要发布的配置", exact: true }),
  ).not.toBeVisible();
  const create = page.getByRole("dialog", {
    name: "新增客户端订阅",
    exact: true,
  });
  await expect(create).toBeVisible();
  await expect(create).toContainText(`分流配置：${profile.name}`);
  const newName = `Second client ${Date.now().toString(36)}`;
  await expect(create.getByLabel("订阅名称", { exact: true })).toHaveValue(
    profile.name,
  );
  await create.getByLabel("订阅名称", { exact: true }).fill(newName);
  await create.getByLabel("目标客户端", { exact: true }).click();
  await page
    .getByRole("option", { name: "sing-box 1.14.3", exact: true })
    .click();
  await expect(
    create.getByRole("combobox", { name: "目标客户端", exact: true }),
  ).toHaveText("sing-box 1.14.3");
  const selectedTarget = { adapterId: "sing-box", version: "1.14.3" };
  // Observe only this UI operation; do not replace requests or responses.
  const previewRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/me/outputs/preview",
  );
  await create
    .getByRole("button", { name: "检查发布内容", exact: true })
    .click();
  const reviewedCreation = (await previewRequest).postDataJSON();
  expect(reviewedCreation).toMatchObject({
    name: newName,
    profileId: profile.id,
    target: selectedTarget,
    mode: "full",
  });
  expect(reviewedCreation.id).toEqual(expect.any(String));
  expect(reviewedCreation.id).not.toBe(original.id);
  const publish = create.getByRole("button", {
    name: `创建并发布「${newName}」`,
    exact: true,
  });
  await expect(publish).toBeEnabled();
  const technical = create.getByRole("button", {
    name: "技术配置（可选查看）",
    exact: true,
  });
  await expect(technical).toHaveAttribute("aria-expanded", "false");
  await expect(create.locator("pre")).not.toBeVisible();
  await expect(publish).toBeInViewport({ ratio: 1 });
  await technical.click();
  await expect(technical).toHaveAttribute("aria-expanded", "true");
  await waitForTechnicalLayout(create);
  await create.locator("pre").scrollIntoViewIfNeeded();
  await recordTechnicalScrollGeometry(create);
  await expect(create.locator("pre")).toBeInViewport();
  await expect(create.locator("pre")).not.toHaveText("");
  await technical.click();
  await expect(technical).toHaveAttribute("aria-expanded", "false");
  await expect(publish).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("new-independent-output-review.png"),
    animations: "disabled",
  });
  await verifyMobilePublicationReview(
    page,
    create,
    publish,
    testInfo.outputPath("new-independent-output-review-mobile.png"),
    "create",
  );
  const creationRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/me/outputs",
  );
  await publish.click();
  const submittedCreation = (await creationRequest).postDataJSON();
  expect(submittedCreation).toMatchObject({
    ...reviewedCreation,
    target: selectedTarget,
    previewDigest: expect.any(String),
  });
  const access = page.getByRole("dialog", {
    name: `获取「${newName}」`,
    exact: true,
  });
  await expect(access).toBeVisible();
  const link = access.getByLabel("订阅链接", { exact: true });
  await expect(link).toBeVisible();
  const uiPathFingerprint = digest(new URL(await link.inputValue()).pathname);
  await page.keyboard.press("Escape");
  await expect(access).not.toBeVisible();
  const all = await readJSON<PublishedOutput[]>(page, "/me/outputs");
  const related = all.filter((item) => item.profileId === profile.id);
  expect(related).toHaveLength(2);
  const created = related.find((item) => item.id !== original.id)!;
  expect(created.name).toBe(newName);
  expect(created.id).toBe(reviewedCreation.id);
  expect(created.profileId).toBe(profile.id);
  expect(created.target).toEqual({ adapterId: "sing-box", version: "1.14.3" });
  expect(created.mode).toBe("full");
  const createdState = await frozenState(page, created.id);
  expect(uiPathFingerprint).toBe(createdState.accessFingerprint);
  expect(await frozenState(page, original.id)).toEqual(beforeOriginal);
  expect(
    (await readJSON<SavedProfile[]>(page, "/me/profiles"))
      .map((item) => item.id)
      .sort(),
  ).toEqual(beforeProfileIds);
  await expect(
    page.getByRole("button", { name: `管理 ${newName}`, exact: true }),
  ).toBeVisible();
  await report(testInfo, "create second client", {
    selectedTarget,
    previewTarget: reviewedCreation.target,
    creationTarget: submittedCreation.target,
    returnedTarget: created.target,
    reviewedIdentityPublished: created.id === reviewedCreation.id,
    createdOutputs: 1,
    relatedOutputs: 2,
    copiedProfiles: 0,
    originalFrozenStateUnchanged: true,
    immediateNewAccessVisible: true,
    newAccessMatchesCreatedOutput: true,
    extraAlreadyScopedProfileConfirmation: false,
    confirmationWithinViewport: true,
    technicalDetailsDefaultCollapsedAndReadableOnDemand: true,
    mobileConfirmationEntirelyVisible: true,
    mobileFooterTouchTargetMinimumHeight: 44,
    mobileNoHorizontalOverflow: true,
    mobileReviewViewport: "390x844",
    mobileTechnicalPanelEntirelyVisibleWhenExpanded: true,
  });
});

test("same rule counts are not represented as identical routing when rule contents changed", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const { profile, outputs } = await seedIndependentOutputs(page, 2, true);
  const [selected, sibling] = outputs;
  const before = await frozenState(page, selected.id);
  const beforeSibling = await frozenState(page, sibling.id);
  await page.goto(`/#profiles?profile=${profile.id}`);
  await page
    .getByRole("article", { name: `分流配置 ${profile.name}`, exact: true })
    .getByRole("button", { name: "编辑配置", exact: true })
    .click();
  await page.getByRole("tab", { name: "分流规则", exact: true }).click();
  await expect(page.getByLabel("规则匹配值", { exact: true })).toHaveValue(
    "before.example",
  );
  await page.getByLabel("规则匹配值", { exact: true }).fill("after.example");
  await page.getByRole("button", { name: "保存并检查", exact: true }).click();
  const target = page.getByRole("dialog", {
    name: "选择客户端订阅",
    exact: true,
  });
  await expect(
    target.getByRole("button", { name: "检查所选订阅", exact: true }),
  ).toBeDisabled();
  await target
    .getByRole("radio", { name: new RegExp(`更新「${selected.name}」`) })
    .check();
  await target
    .getByRole("button", { name: "检查所选订阅", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: `检查订阅更新「${selected.name}」`,
    exact: true,
  });
  const changes = review.getByRole("region", { name: "分流比较", exact: true });
  const scope = changes.getByRole("group", {
    name: "比较结论与范围",
    exact: true,
  });
  await expect(scope).toHaveText("未比较规则文件内容和客户端运行设置。");
  await expect(
    review.getByText("策略组和连接未变化。", { exact: true }),
  ).toBeVisible();
  await expect(changes).not.toContainText("完全一致");
  await expect(changes).not.toContainText("已展示的分流规则和默认去向相同。");
  const ruleList = changes.getByRole("list", {
    name: "分流规则变更",
    exact: true,
  });
  const changedRule = ruleList.getByRole("listitem");
  await expect(changedRule).toHaveCount(1);
  await expect(
    changedRule.getByRole("heading", { name: "规则 1", exact: true }),
  ).toBeVisible();
  await expect(
    changedRule.getByText("匹配条件已更改", { exact: true }),
  ).toBeVisible();
  const beforeRule = changedRule
    .locator(".routing-intent-versions > div")
    .filter({ has: page.getByText("已发布", { exact: true }) });
  const afterRule = changedRule
    .locator(".routing-intent-versions > div")
    .filter({ has: page.getByText("待发布", { exact: true }) });
  await expect(beforeRule).toHaveCount(1);
  await expect(afterRule).toHaveCount(1);
  await expect(beforeRule.locator(":scope > span")).toHaveText([
    "已发布",
    "域名后缀 before.example",
    "拒绝连接",
  ]);
  await expect(afterRule.locator(":scope > span, :scope > strong")).toHaveText([
    "待发布",
    "域名后缀 after.example",
    "拒绝连接",
  ]);
  await expect(changes.getByRole("definition")).toHaveText("直连");
  await expect(
    review.getByRole("button", { name: "查看待发布技术配置", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  const confirm = review.getByRole("button", {
    name: `确认更新「${selected.name}」`,
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  // Read the precise changed rule first, then reach the complete decision block.
  await changes.scrollIntoViewIfNeeded();
  await expect(scope).toBeInViewport({ ratio: 1 });
  await expect(changedRule).toBeInViewport({ ratio: 1 });
  const decision = review.getByRole("group", { name: "更新确认", exact: true });
  await decision.scrollIntoViewIfNeeded();
  await expect(decision).toBeInViewport({ ratio: 1 });
  await expect(decision).toContainText(`更新订阅：${selected.name}`);
  await expect(
    decision.getByText("沿用当前链接，其他订阅保留原状。", { exact: true }),
  ).toBeInViewport({ ratio: 1 });
  const technical = review.getByRole("button", {
    name: "查看待发布技术配置",
    exact: true,
  });
  // The evidence body scrolls independently of the fixed decision footer.
  // Reaching that footer does not scroll the body's last optional disclosure.
  await review
    .locator("[data-task-overlay-body]")
    .hover({ position: { x: 8, y: 8 } });
  await page.mouse.wheel(0, 1000);
  await page.screenshot({
    path: testInfo.outputPath("equal-counts-not-equal-rules-mobile.png"),
    // Diagnostic capture must not fast-forward motion before geometry assertions.
    animations: "allow",
  });
  await expect(technical).toBeInViewport({ ratio: 1 });
  await expect(review.locator("[data-task-overlay-header]")).toBeInViewport({
    ratio: 1,
  });
  await expect(decision).toBeInViewport({ ratio: 1 });
  await expect(
    decision.getByText("沿用当前链接，其他订阅保留原状。", { exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(confirm).toBeInViewport({ ratio: 1 });
  await expect(
    decision.getByRole("button", { name: "取消", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect
    .poll(async () => (await confirm.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await confirm.click();
  await expect(review).not.toBeVisible();
  const after = await frozenState(page, selected.id);
  expect(after.routingSummary).toEqual(before.routingSummary);
  expect(after.contentFingerprint).not.toBe(before.contentFingerprint);
  expect(after.accessFingerprint).toBe(before.accessFingerprint);
  expect(await frozenState(page, sibling.id)).toEqual(beforeSibling);
  const saved = await readJSON<{
    ir: { rules: Array<{ match: { value: string } }> };
  }>(page, `/me/profiles/${profile.id}`);
  expect(saved.ir.rules.map((rule) => rule.match.value)).toEqual([
    "after.example",
  ]);
  const access = await readJSON<{ feedPath: string }>(
    page,
    `/me/outputs/${selected.id}/access`,
  );
  const artifact = await page.request.get(
    new URL(access.feedPath, "http://127.0.0.1:4173").pathname,
  );
  expect(artifact.ok()).toBe(true);
  const delivered = await artifact.text();
  expect(
    delivered.includes("after.example"),
    "The changed rule is exported",
  ).toBe(true);
  expect(
    delivered.includes("before.example"),
    "The former rule is no longer exported",
  ).toBe(false);
  await report(testInfo, "same count different rules", {
    ruleCount: 1,
    frozenSummaryFieldsEqual: true,
    exactRuleChangeAndComparisonScopeExplicit: true,
    actualExportedRuleChanged: true,
    accessIdentityUnchanged: true,
    siblingFrozenStateUnchanged: true,
    liveTrafficVerified: false,
  });
});

/** Public API fixture setup for a bounded display/search exercise, not a usability study. */
test("25 synthetic configurations and 100 independent links remain searchable, bounded, and explicitly scoped", async ({
  page,
}, testInfo) => {
  await openWorkspace(page);
  const { csrfToken } = await readJSON<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": csrfToken };
  const suffix = Date.now().toString(36);
  const prefix = `Matrix ${suffix}`;
  const profiles: Array<{ id: string; name: string }> = [];
  const outputs: PublishedOutput[] = [];
  const createProfile = async (index: number, name: string) => {
    const id = `matrix-profile-${suffix}-${index}`;
    const profile = {
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
        endpoints: [
          {
            id: `node-${suffix}-${index}`,
            name: "Synthetic choice",
            origin: "imported",
            connection: {
              protocol: "socks",
              host: "fixture.example",
              port: 1080,
            },
          },
        ],
        groups: [],
        rules: [],
        resources: [],
        defaultAction: { kind: "direct" },
        runtime: { mixedPort: 7890 },
      },
    };
    const response = await page.request.post("/api/me/profiles", {
      headers,
      data: profile,
    });
    expect(response.ok(), "Public API synthetic Profile setup succeeds").toBe(
      true,
    );
    return { id, name };
  };
  let target!: PublishedOutput;
  let longOutput!: PublishedOutput;
  for (let index = 0; index < 25; index++) {
    const name =
      index === 0
        ? `${prefix} Long named ${"Travel_Work_".repeat(12)}`
        : index < 3
          ? `${prefix} Duplicate configuration`
          : `${prefix} Configuration ${index}`;
    const profile = await createProfile(index, name);
    profiles.push(profile);
    const count = index === 0 ? 20 : index <= 7 ? 4 : 3;
    for (let link = 0; link < count; link++) {
      const wanted = index === 18 && link === 0;
      const adapterId = wanted || link % 2 ? "sing-box" : "mihomo";
      const name = wanted
        ? `${prefix} Personal phone`
        : index === 0 && link === 0
          ? `${prefix} ${"Phone_for_".repeat(13)}`
          : index === 0 && (link === 1 || link === 2)
            ? `${prefix} Duplicate tablet`
            : `${prefix} Client ${index}-${link}`;
      const response = await page.request.post("/api/me/outputs", {
        headers,
        data: {
          id: `matrix-output-${suffix}-${index}-${link}`,
          name,
          profileId: profile.id,
          target: {
            adapterId,
            version: adapterId === "sing-box" ? "1.14.3" : "1.19.32",
          },
          mode: link % 5 === 4 ? "nodes-only" : "full",
        },
      });
      expect(response.ok(), "Public API synthetic Output setup succeeds").toBe(
        true,
      );
      const output = (await response.json()) as PublishedOutput;
      outputs.push(output);
      if (wanted) target = output;
      if (index === 0 && link === 0) longOutput = output;
      if (index === 2 && link === 0) {
        const revoked = await page.request.post(
          `/api/me/outputs/${output.id}/revoke`,
          { headers },
        );
        expect(revoked.ok(), "Synthetic revoked link setup succeeds").toBe(
          true,
        );
      }
    }
  }
  const orphanProfile = await createProfile(
    25,
    `${prefix} Removed configuration`,
  );
  const orphanResponse = await page.request.post("/api/me/outputs", {
    headers,
    data: {
      id: `matrix-orphan-${suffix}`,
      name: `${prefix} Retained orphan`,
      profileId: orphanProfile.id,
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
    },
  });
  expect(orphanResponse.ok()).toBe(true);
  const orphan = (await orphanResponse.json()) as PublishedOutput;
  outputs.push(orphan);
  expect(
    (
      await page.request.post(`/api/me/outputs/${orphan.id}/revoke`, {
        headers,
      })
    ).ok(),
  ).toBe(true);
  // The public API correctly forbids deleting a configuration with active links.
  // Revoke first; its retained metadata then forms a truthful recoverable orphan.
  expect(
    (
      await page.request.delete(`/api/me/profiles/${orphanProfile.id}`, {
        headers,
      })
    ).ok(),
  ).toBe(true);
  expect(outputs).toHaveLength(100);
  const actualProfiles = await readJSON<SavedProfile[]>(page, "/me/profiles");
  expect(
    actualProfiles.filter((item) => item.name.startsWith(prefix)),
  ).toHaveLength(25);
  const actualOutputs = await readJSON<PublishedOutput[]>(page, "/me/outputs");
  expect(
    actualOutputs.filter((item) => item.name.startsWith(prefix)),
  ).toHaveLength(100);
  expect(actualOutputs.find((item) => item.id === orphan.id)?.status).toBe(
    "revoked",
  );
  const statusIDs: string[] = [];
  const previews: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    const status = pathname.match(/^\/api\/me\/outputs\/([^/]+)\/status$/);
    if (status) statusIDs.push(status[1]);
    if (/^\/api\/me\/.*\/preview$/.test(pathname)) previews.push(pathname);
  });
  await page.goto("/#subscriptions");
  await page.reload();
  const search = page.getByRole("textbox", {
    name: "搜索配置或客户端订阅",
    exact: true,
  });
  await search.fill(prefix);
  await expect(
    page.getByText("26 组配置 100 个客户端订阅", { exact: true }),
  ).toBeVisible();
  const inventory = page.getByRole("region", {
    name: "分流配置与客户端订阅",
    exact: true,
  });
  await expect(inventory.getByRole("article")).toHaveCount(10);
  expect(
    await inventory.getByRole("group", { name: /^客户端订阅 / }).count(),
  ).toBeLessThanOrEqual(50);
  await expect(
    page.getByRole("region", { name: "已发布分流", exact: true }),
  ).toHaveCount(0);
  const configurationPages = page.getByRole("navigation", {
    name: "配置清单分页",
    exact: true,
  });
  const firstPageNames = await inventory
    .getByRole("heading", { level: 2 })
    .allTextContents();
  await configurationPages
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await expect(inventory.getByRole("article")).toHaveCount(10);
  await expect
    .poll(() => inventory.getByRole("heading", { level: 2 }).allTextContents())
    .not.toEqual(firstPageNames);
  expect(statusIDs).toEqual([]);
  expect(previews).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });
  await search.fill(target.name);
  await expect(inventory.getByRole("article")).toHaveCount(1);
  const found = inventory.getByRole("article", {
    name: `分流配置 ${profiles[18].name}`,
    exact: true,
  });
  await expect(
    found.getByRole("group", {
      name: `客户端订阅 ${target.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: / 的订阅详情$/ })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: testInfo.outputPath("client-name-search-desktop.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: testInfo.outputPath("client-name-search-mobile.png"),
    animations: "disabled",
  });
  await auditReflowAndTextScale(
    page,
    testInfo,
    "client-inventory",
    inventory,
    found.getByRole("button", { name: `查看订阅 ${target.name}`, exact: true }),
    found.getByRole("heading", { level: 2 }),
  );
  expect(statusIDs).toEqual([]);
  const detailLoaded = page.waitForResponse((response) =>
    response.url().endsWith(`/api/me/outputs/${target.id}/status`),
  );
  await found
    .getByRole("button", { name: `查看订阅 ${target.name}`, exact: true })
    .click();
  expect((await detailLoaded).ok()).toBe(true);
  const detail = page.getByRole("dialog", {
    name: `${target.name} 的订阅详情`,
    exact: true,
  });
  await expect(detail).toContainText(profiles[18].name);
  await expect(detail).toContainText("sing-box");
  await expect(
    detail.getByRole("region", { name: "已发布分流", exact: true }),
  ).toContainText("直连");
  expect([...new Set(statusIDs)]).toEqual([target.id]);
  expect(previews).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await search.fill(`${prefix} no-such-client`);
  await expect(inventory.getByRole("article")).toHaveCount(0);
  await expect(
    page.getByText("没有匹配的配置或客户端订阅", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: / 的订阅详情$/ })).toHaveCount(
    0,
  );
  // Duplicate display names are independent identities, not guaranteed to share
  // a paginated page. Search each name to expose both without changing page size.
  await search.fill(`${prefix} Duplicate configuration`);
  await expect(
    inventory.getByRole("article", {
      name: `分流配置 ${prefix} Duplicate configuration`,
      exact: true,
    }),
  ).toHaveCount(2);
  await search.fill(`${prefix} Duplicate tablet`);
  await expect(inventory.getByRole("article")).toHaveCount(1);
  await expect(
    inventory.getByRole("group", {
      name: `客户端订阅 ${prefix} Duplicate tablet`,
      exact: true,
    }),
  ).toHaveCount(2);
  await expect(page.getByRole("dialog", { name: / 的订阅详情$/ })).toHaveCount(
    0,
  );
  await search.fill(`${prefix} Long named`);
  const longProfile = inventory.getByRole("article", {
    name: `分流配置 ${profiles[0].name}`,
    exact: true,
  });
  await expect(
    longProfile.getByRole("group", { name: /^客户端订阅 / }),
  ).toHaveCount(5);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  const longHeading = longProfile.getByRole("heading", {
    level: 2,
    name: profiles[0].name,
    exact: true,
  });
  await expect(longHeading).toHaveText(profiles[0].name);
  await longHeading.scrollIntoViewIfNeeded();
  await expect(longHeading).toBeInViewport({ ratio: 1 });
  // Body scrollWidth cannot detect text clipped by the owning card. Measure
  // every painted line of the full identity, not just its containing element.
  const headingGeometry = await longHeading.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const card = element.closest("article")!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      textOverflow: getComputedStyle(element).textOverflow,
      bounds: {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      },
      card: { left: card.left, right: card.right },
      viewportWidth: innerWidth,
      lines: Array.from(range.getClientRects())
        .filter((line) => line.width > 0 && line.height > 0)
        .map((line) => ({
          left: line.left,
          right: line.right,
          top: line.top,
          bottom: line.bottom,
        })),
    };
  });
  await testInfo.attach("long-profile-heading-geometry", {
    body: JSON.stringify(headingGeometry),
    contentType: "application/json",
  });
  expect(headingGeometry.textOverflow).not.toBe("ellipsis");
  expect(headingGeometry.lines.length).toBeGreaterThan(1);
  for (const line of headingGeometry.lines) {
    expect(line.left).toBeGreaterThanOrEqual(
      Math.max(headingGeometry.bounds.left, headingGeometry.card.left, 0) - 1,
    );
    expect(line.right).toBeLessThanOrEqual(
      Math.min(
        headingGeometry.bounds.right,
        headingGeometry.card.right,
        headingGeometry.viewportWidth,
      ) + 1,
    );
    expect(line.top).toBeGreaterThanOrEqual(headingGeometry.bounds.top - 1);
    expect(line.bottom).toBeLessThanOrEqual(headingGeometry.bounds.bottom + 1);
  }
  await page.screenshot({
    path: testInfo.outputPath("long-names-bounded-links-mobile.png"),
    animations: "disabled",
  });
  const linksPage = longProfile.getByRole("navigation", {
    name: `${profiles[0].name}的客户端订阅分页`,
    exact: true,
  });
  await linksPage.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(
    longProfile.getByRole("group", { name: /^客户端订阅 / }),
  ).toHaveCount(5);
  await expect(
    longProfile.getByRole("button", {
      name: `查看订阅 ${longOutput.name}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await search.fill(orphan.name);
  const orphanGroup = inventory.getByRole("article", {
    name: `关联配置不可用 ${orphanProfile.id}`,
    exact: true,
  });
  await expect(orphanGroup).toBeVisible();
  await expect(
    orphanGroup.getByRole("button", { name: "检查重新发布", exact: true }),
  ).toBeDisabled();
  await expect(
    orphanGroup.getByRole("button", { name: "获取订阅", exact: true }),
  ).toBeDisabled();
  const orphanStatus = page.waitForResponse((response) =>
    response.url().endsWith(`/api/me/outputs/${orphan.id}/status`),
  );
  await orphanGroup
    .getByRole("button", { name: `查看订阅 ${orphan.name}`, exact: true })
    .click();
  await orphanStatus;
  const orphanDetail = page.getByRole("dialog", {
    name: `${orphan.name} 的订阅详情`,
    exact: true,
  });
  await expect(orphanDetail).toContainText("关联配置不可用");
  await expect(
    orphanDetail.getByRole("button", { name: "检查重新发布", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(orphanDetail).not.toBeVisible();
  await search.fill("");
  await expect(inventory.getByRole("article")).toHaveCount(10);
  expect([...new Set(statusIDs)].sort()).toEqual([target.id, orphan.id].sort());
  expect(previews).toEqual([]);
  await report(testInfo, "bounded synthetic inventory", {
    setup: "public local demo API only",
    activeConfigurations: 25,
    retainedClientLinks: 100,
    largestConfigurationLinks: 20,
    maximumRenderedConfigurations: 10,
    maximumRenderedLinksPerConfiguration: 5,
    clientNameSearchFindsOwningConfiguration: true,
    explicitDetailStatusIDs: 2,
    listStatusOrPreviewRequestsObservedBeforeExplicitOpen: 0,
    noMatchDoesNotSelectFallback: true,
    duplicateNamesRetained: true,
    orphan: "revoked via public API before deleting configuration",
    mobileHorizontalOverflow: false,
    humanUsabilityStudy: false,
    capacityBenchmark: false,
  });
});
