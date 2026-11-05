import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Diagnostic only: deliberately NOT named *.ui.spec.ts. Both projects run the
// same synthetic user journey. This is layout/interaction evidence, not backend
// delivery, persistence, production readiness, or a preferred design verdict.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

const retainedReason = "刷新失败，保留已接纳文件。新发布前请重试或替换。";
const shortName = "已接纳的常用规则";
const longName =
  "跨区域规则文件用于核对东京伦敦法兰克福入口的更新状态请保留完整名称便于确认正在重试的目标资源并检查已接纳文件的交付范围" +
  "SyntheticResourceIdentityWithoutWordSeparators".repeat(2) + "LongNameFixture";
const resources = [
  { id: "accepted-short", name: shortName },
  { id: "accepted-long", name: longName },
  { id: "healthy-control", name: "正常的对照规则" },
] as const;
type ResourceID = (typeof resources)[number]["id"];
const requestReasons: Record<ResourceID, string> = {
  "accepted-short": "远程文件暂时无法读取，请稍后重试。",
  "accepted-long":
    "远程文件暂时无法读取，请稍后重试。此响应仅用于隔离布局检查。" +
    "SyntheticRemoteReadFailureWithoutWordSeparators".repeat(2),
  "healthy-control": "The healthy control must never be refreshed in this diagnostic.",
};

async function setup(page: Page, { includeLong = true }: { includeLong?: boolean } = {}) {
  const baseURL = test.info().project.use.baseURL;
  const variant = test.info().project.name;
  if (!baseURL || !["baseline", "proposal"].includes(variant))
    throw new Error("Use the explicit baseline/proposal diagnostic configuration.");
  const url = new URL(baseURL);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.port !== (variant === "baseline" ? "4181" : "4182")
  ) throw new Error("Resource layout diagnostics require their isolated loopback origin.");
  const unexpected: string[] = [];
  const refreshRequests: { id: ResourceID; path: string; status: number; csrf: string | undefined }[] = [];
  const fixture = resources.filter((resource) => includeLong || resource.id !== "accepted-long").map((resource) => ({
    ...resource,
    revision: "1",
    format: "mihomo-yaml",
    behavior: "domain",
    location: "remote",
    url: `https://example.test/synthetic/${resource.id}.yaml`,
    updatePolicy: "pinned",
    acceptedVersion: `synthetic-${resource.id}-1`,
    digest: "a".repeat(64),
    sizeBytes: 2450,
    canRefresh: true,
    refreshStatus: "accepted",
    visibility: "private",
  }));
  const responses: Record<string, unknown> = {
    "/api/auth/me": {
      user: { id: "resource-layout-review", name: "隔离审查管理员", role: "admin" },
      csrfToken: "synthetic-resource-layout-csrf",
    },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/admin/announcements": [],
    "/api/me/resources": fixture,
  };
  // Context routing also catches popups. No API request can fall through to a
  // server, and even a non-API write is rejected. No backend is needed or used.
  await page.context().route("**/*", (route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (target.origin !== url.origin) {
      unexpected.push(`external ${request.method()} ${target.origin}${target.pathname}`);
      return route.abort();
    }
    const method = request.method();
    const resource = fixture.find((candidate) =>
      target.pathname === `/api/me/resources/${candidate.id}/refresh`,
    );
    if (method === "POST" && resource && resource.id !== "healthy-control") {
      const csrf = request.headers()["x-csrf-token"];
      const priorAttempts = refreshRequests.filter((item) => item.id === resource.id).length;
      if (csrf !== "synthetic-resource-layout-csrf" || priorAttempts >= 2) {
        unexpected.push(`unexpected refresh authorization or attempt: ${resource.id}`);
        return route.fulfill({ status: 503, json: { error: "Unexpected synthetic refresh" } });
      }
      const failed = priorAttempts === 0;
      const status = failed ? 503 : 200;
      refreshRequests.push({ id: resource.id, path: target.pathname, status, csrf });
      resource.refreshStatus = failed ? "failed" : "accepted";
      return route.fulfill({ status, json: failed ? { error: requestReasons[resource.id] } : {} });
    }
    if (target.pathname.startsWith("/api/")) {
      if (method === "GET" && target.pathname in responses)
        return route.fulfill({ json: responses[target.pathname] });
      unexpected.push(`${method} ${target.pathname}`);
      return route.fulfill({ status: 503, json: { error: "Unexpected controlled API request" } });
    }
    if (!["GET", "HEAD"].includes(method)) {
      unexpected.push(`non-API write ${method} ${target.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  // A Vite HMR socket is unnecessary for a fixed fixture. Refuse sockets too,
  // including external sockets that HTTP request routing would not intercept.
  await page.context().routeWebSocket("**/*", (socket) => {
    const target = new URL(socket.url());
    if (target.host !== url.host) unexpected.push(`external WebSocket ${target.host}`);
    socket.close();
  });
  return { unexpected, refreshRequests };
}

function controls(page: Page, id: ResourceID) {
  const resource = resources.find((candidate) => candidate.id === id)!;
  const row = page.locator(`[data-row-key="${id}"]`);
  const actions = row.getByRole("group", { name: `${resource.name} 的操作`, exact: true });
  return {
    resource, row, actions,
    refresh: actions.getByRole("button", { name: "刷新文件", exact: true }),
    replace: actions.getByRole("button", { name: "替换文件", exact: true }),
    reason: row.getByText(retainedReason, { exact: true }),
    primaryIdentity: row.getByRole("button", { name: resource.name, exact: true }),
    actionIdentity: actions.getByText(resource.name, { exact: true }),
  };
}

async function healthyControl(page: Page) {
  const control = controls(page, "healthy-control");
  await expect(control.reason).toHaveCount(0);
  await expect(control.row.getByText("刷新失败", { exact: true })).toHaveCount(0);
  await expect(control.refresh).not.toHaveAttribute("aria-describedby");
  await expect(control.replace).not.toHaveAttribute("aria-describedby");
  await expect(control.row.getByText("随配置打包", { exact: true })).toHaveCount(1);
}

function expectsActionReason(page: Page, proposal: boolean) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("A fixed viewport is required for the narrow-only experiment.");
  return proposal && viewport.width < 768;
}

async function assertFailure(page: Page, id: ResourceID, proposal: boolean) {
  const { reason, actions, refresh, replace } = controls(page, id);
  await expect(reason).toHaveCount(1);
  await expect(reason).toHaveText(retainedReason);
  await expect(reason).not.toHaveAttribute("role", "alert");
  await expect(reason).not.toHaveAttribute("aria-live");
  await expect(refresh).toHaveAccessibleDescription(retainedReason);
  await expect(replace).toHaveAccessibleDescription(retainedReason);
  await expect(reason).toHaveAttribute("id", await refresh.getAttribute("aria-describedby") || "missing-description");
  await expect(replace).toHaveAttribute("aria-describedby", await refresh.getAttribute("aria-describedby") || "missing-description");
  expect(await reason.evaluate((node) => document.querySelectorAll(`[id="${CSS.escape(node.id)}"]`).length)).toBe(1);
  if (expectsActionReason(page, proposal)) {
    await expect(actions.getByText(retainedReason, { exact: true })).toHaveCount(1);
    // The emphasized words within the full reason are allowed. A second,
    // speech-hidden short failure badge is not part of this proposal.
    await expect(actions.locator('[aria-hidden="true"]').filter({ hasText: /^刷新失败$/ })).toHaveCount(0);
  } else {
    // The baseline always uses delivery context. This proposal preserves that
    // desktop placement too, switching only below the actual 768px breakpoint.
    await expect(actions.getByText(retainedReason, { exact: true })).toHaveCount(0);
  }
  const css = await reason.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      text: node.textContent,
      fitsX: node.scrollWidth <= node.clientWidth + 1,
      fitsY: node.scrollHeight <= node.clientHeight + 1,
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      lineClamp: style.webkitLineClamp,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    };
  });
  expect(css.text).toBe(retainedReason);
  expect(css.fitsX).toBe(true);
  expect(css.fitsY).toBe(true);
  expect(css.whiteSpace).not.toBe("nowrap");
  expect(css.textOverflow).not.toBe("ellipsis");
  expect(["", "none", "0"]).toContain(css.lineClamp);
  expect(["hidden", "clip"]).not.toContain(css.overflowX);
  expect(["hidden", "clip"]).not.toContain(css.overflowY);
}

async function failAndCancel(page: Page, id: ResourceID, harness: Awaited<ReturnType<typeof setup>>, proposal: boolean) {
  const { resource, refresh, replace } = controls(page, id);
  const before = harness.refreshRequests.length;
  await refresh.focus();
  await refresh.press("Enter");
  const decision = page.getByRole("alertdialog");
  await settledTask(decision);
  await expect(decision).toHaveAccessibleName(`重新读取并接纳「${resource.name}」的远程规则文件？`);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await decision.getByRole("button", { name: "读取并接纳", exact: true }).click();
  await expect(decision.getByRole("alert")).toHaveText(requestReasons[id]);
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByText(requestReasons[id], { exact: true })).toHaveCount(1);
  await decision.press("Escape");
  await expect(decision).toHaveCount(0);
  await expect(refresh).toBeFocused();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText(requestReasons[id]);
  await expect(page.getByText(requestReasons[id], { exact: true })).toHaveCount(1);
  await assertFailure(page, id, proposal);
  expect(harness.refreshRequests).toHaveLength(before + 1);

  await refresh.press("Enter");
  await settledTask(decision);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await decision.getByRole("button", { name: "取消", exact: true }).click();
  await expect(decision).toHaveCount(0);
  await expect(refresh).toBeFocused();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText(requestReasons[id]);
  await expect(page.getByText(requestReasons[id], { exact: true })).toHaveCount(1);
  expect(harness.refreshRequests).toHaveLength(before + 1);

  await replace.click();
  const replacement = page.getByRole("dialog", { name: `替换 ${resource.name}`, exact: true });
  await settledTask(replacement);
  await replacement.getByRole("button", { name: "取消", exact: true }).click();
  await expect(replacement).toHaveCount(0);
  await expect(replace).toBeFocused();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText(requestReasons[id]);
  await expect(page.getByText(requestReasons[id], { exact: true })).toHaveCount(1);
  expect(harness.refreshRequests).toHaveLength(before + 1);
  await assertFailure(page, id, proposal);
  await healthyControl(page);
}

// No helper scrolls to a reason to make it look visible. Measurements describe
// exactly what the actual focus flow and current table scroll position expose.
async function measureRow(row: Locator) {
  return row.evaluate((element, reasonText) => {
    const row = element as HTMLElement;
    const rect = (box: DOMRect | DOMRectReadOnly) => ({
      x: box.x, y: box.y, top: box.top, right: box.right,
      bottom: box.bottom, left: box.left, width: box.width, height: box.height,
    });
    const measure = (node: HTMLElement | null) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const range = document.createRange();
      range.selectNodeContents(node);
      const textRects = Array.from(range.getClientRects()).filter((part) => part.width > 0 && part.height > 0);
      const textBounds = range.getBoundingClientRect();
      let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
      let top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
      const clippingAncestors: { tag: string; slot: string | null; overflowX: string; overflowY: string; rect: ReturnType<typeof rect> }[] = [];
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        const clipX = ["hidden", "clip", "scroll", "auto"].includes(ancestorStyle.overflowX);
        const clipY = ["hidden", "clip", "scroll", "auto"].includes(ancestorStyle.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = ancestor.getBoundingClientRect();
        const clientLeft = bounds.left + ancestor.clientLeft;
        const clientTop = bounds.top + ancestor.clientTop;
        if (clipX) {
          left = Math.max(left, clientLeft);
          right = Math.min(right, clientLeft + ancestor.clientWidth);
        }
        if (clipY) {
          top = Math.max(top, clientTop);
          bottom = Math.min(bottom, clientTop + ancestor.clientHeight);
        }
        clippingAncestors.push({
          tag: ancestor.tagName, slot: ancestor.getAttribute("data-slot"),
          overflowX: ancestorStyle.overflowX, overflowY: ancestorStyle.overflowY, rect: rect(bounds),
        });
      }
      const rendered = style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      const visibleArea = rendered ? Math.max(0, right - left) * Math.max(0, bottom - top) : 0;
      return {
        text: node.textContent,
        id: node.id || null, role: node.getAttribute("role"),
        ariaDescribedBy: node.getAttribute("aria-describedby"),
        rect: rect(box), clientWidth: node.clientWidth, clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
        rendered, focused: document.activeElement === node,
        focusVisible: node.matches(":focus-visible"),
        visibleRatio: box.width * box.height ? visibleArea / (box.width * box.height) : 0,
        viewportClipping: {
          left: Math.max(0, -box.left), right: Math.max(0, box.right - innerWidth),
          top: Math.max(0, -box.top), bottom: Math.max(0, box.bottom - innerHeight),
        },
        clippingAncestors,
        textBounds: rect(textBounds),
        textRects: textRects.map(rect),
        lineCount: new Set(textRects.map((part) => Math.round(part.top))).size,
        contentFitsX: node.scrollWidth <= node.clientWidth + 1,
        contentFitsY: node.scrollHeight <= node.clientHeight + 1,
        css: {
          display: style.display, visibility: style.visibility, color: style.color,
          whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, wordBreak: style.wordBreak,
          textOverflow: style.textOverflow, overflowX: style.overflowX, overflowY: style.overflowY,
          lineClamp: style.webkitLineClamp, fontSize: style.fontSize, lineHeight: style.lineHeight,
          minWidth: style.minWidth, maxWidth: style.maxWidth,
        },
      };
    };
    const actions = row.querySelector<HTMLElement>('[role="group"]');
    const reason = Array.from(row.querySelectorAll<HTMLElement>("p")).find((node) => node.textContent === reasonText) ?? null;
    return {
      id: row.dataset.rowKey, rect: rect(row.getBoundingClientRect()),
      rowHeight: row.getBoundingClientRect().height,
      reasonInsideActionGroup: !!(reason && actions?.contains(reason)),
      fullReasonCount: Array.from(row.querySelectorAll("p")).filter((node) => node.textContent === reasonText).length,
      reasonIdOccurrences: reason ? document.querySelectorAll(`[id="${CSS.escape(reason.id)}"]`).length : 0,
      actionGroup: measure(actions),
      reason: measure(reason),
      primaryIdentity: measure(row.querySelector<HTMLElement>(".table-name")),
      actionIdentity: measure(actions?.querySelector<HTMLElement>(".table-row-action-target") ?? null),
      buttons: Array.from(actions?.querySelectorAll<HTMLButtonElement>("button") ?? []).map(measure),
    };
  }, retainedReason);
}

async function snapshot(page: Page, stage: string) {
  const table = await page.locator('[data-slot="table-container"]').evaluate((node) => {
    const viewport = node as HTMLElement;
    const style = getComputedStyle(viewport);
    const table = viewport.querySelector("table")!;
    return {
      clientWidth: viewport.clientWidth, scrollWidth: viewport.scrollWidth,
      scrollLeft: viewport.scrollLeft, clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight, scrollTop: viewport.scrollTop,
      overflowPixels: Math.max(0, viewport.scrollWidth - viewport.clientWidth),
      measuredOverflow: viewport.scrollWidth > viewport.clientWidth + 1,
      cssOverflowX: style.overflowX, cssOverflowY: style.overflowY,
      dataOverflow: viewport.closest(".data-table")?.getAttribute("data-overflow"),
      tableWidth: table.getBoundingClientRect().width, tableHeight: table.getBoundingClientRect().height,
    };
  });
  const document = await page.evaluate(() => ({
    innerWidth, innerHeight, scrollX, scrollY,
    documentClientWidth: window.document.documentElement.clientWidth,
    documentScrollWidth: window.document.documentElement.scrollWidth,
    bodyScrollWidth: window.document.body.scrollWidth,
  }));
  return {
    stage, table, document,
    rows: await Promise.all((await page.locator("[data-row-key]").all()).map(measureRow)),
  };
}

async function noPageOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth, viewport: innerWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
}

async function focusActions(page: Page, id: ResourceID, proposal: boolean, capture: (stage: string) => Promise<void>) {
  const target = controls(page, id);
  // Establish keyboard modality without navigating or scrolling to text.
  await page.keyboard.press("Shift");
  for (const [name, button] of [["replace", target.replace], ["refresh", target.refresh]] as const) {
    await button.focus();
    await expect(button).toBeFocused();
    await expect(target.replace).toBeInViewport({ ratio: 1 });
    await expect(target.refresh).toBeInViewport({ ratio: 1 });
    const identity = await target.actionIdentity.isVisible() ? target.actionIdentity : target.primaryIdentity;
    await expect(identity).toHaveText(target.resource.name);
    await expect(identity).toBeInViewport({ ratio: 1 });
    if (expectsActionReason(page, proposal)) await expect(target.reason).toBeInViewport({ ratio: 1 });
    // With delivery-context placement the reason may be clipped off to the left.
    // Preserve that finding instead of scrolling it into view or failing it.
    await capture(`${id}-${name}-focused`);
    await noPageOverflow(page);
  }
}

async function retrySuccessfully(page: Page, id: ResourceID) {
  const { reason, refresh, replace } = controls(page, id);
  await refresh.focus();
  await refresh.press("Enter");
  const decision = page.getByRole("alertdialog");
  await settledTask(decision);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await decision.getByRole("button", { name: "读取并接纳", exact: true }).click();
  await expect(decision).toHaveCount(0);
  await expect(refresh).toBeFocused();
  await expect(reason).toHaveCount(0);
  await expect(refresh).not.toHaveAttribute("aria-describedby");
  await expect(replace).not.toHaveAttribute("aria-describedby");
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await healthyControl(page);
}

async function resizeSettlement(page: Page, width: number, proposal: boolean) {
  await page.setViewportSize({ width, height: 1000 });
  const frames = await page.locator('[data-slot="table-container"]').evaluate(async (node) => {
    const viewport = node as HTMLElement;
    const actions = viewport.querySelector<HTMLElement>('[data-row-key="accepted-long"] [role="group"]')!;
    const row = actions.closest("tr")!;
    const frames = [];
    // A bounded observation of rendered geometry, not a claim that every future
    // ResizeObserver cycle is proven. No animations or observers are disabled.
    for (let frame = 0; frame < 32; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const bounds = actions.getBoundingClientRect();
      frames.push({
        frame, time: performance.now(), clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth, scrollLeft: viewport.scrollLeft,
        actionWidth: bounds.width, actionHeight: bounds.height,
        actionX: bounds.x, actionY: bounds.y, rowHeight: row.getBoundingClientRect().height,
      });
    }
    return frames;
  });
  const signatures = frames.map(({ frame: _frame, time: _time, ...geometry }) =>
    JSON.stringify(Object.values(geometry).map((value) => Math.round(value * 10) / 10)),
  );
  expect(new Set(signatures.slice(-12)).size, "resize geometry must settle during the final 12 observed frames").toBe(1);
  const target = controls(page, "accepted-long");
  // Do not refocus: the table's own resize handling must retain the focused
  // action and reveal its context after the viewport changes in either direction.
  await expect(target.refresh).toBeFocused();
  await expect(target.refresh).toBeInViewport({ ratio: 1 });
  await expect(target.replace).toBeInViewport({ ratio: 1 });
  const identity = await target.actionIdentity.isVisible() ? target.actionIdentity : target.primaryIdentity;
  await expect(identity).toBeInViewport({ ratio: 1 });
  if (expectsActionReason(page, proposal)) await expect(target.reason).toBeInViewport({ ratio: 1 });
  await assertFailure(page, "accepted-short", proposal);
  await assertFailure(page, "accepted-long", proposal);
  await healthyControl(page);
  await noPageOverflow(page);
  return {
    width, height: 1000, observedFrames: frames.length, stableTrailingFrames: 12,
    geometryTransitions: signatures.slice(1).filter((value, index) => value !== signatures[index]).length,
    frames,
  };
}

for (const width of [1280, 1440, 390]) {
  test(`resource full-error/action grouping comparison at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const proposal = info.project.name === "proposal";
    const harness = await setup(page);
    const snapshots: Awaited<ReturnType<typeof snapshot>>[] = [];
    const capture = async (stage: string) => { snapshots.push(await snapshot(page, stage)); };
    const screenshots: string[] = [];
    const screenshotErrors: string[] = [];
    const resizeMeasurements: Awaited<ReturnType<typeof resizeSettlement>>[] = [];
    const screenshot = async (name: string) => {
      const filename = `${info.project.name}-${width}-${name}.png`;
      await page.screenshot({ path: info.outputPath(filename), fullPage: false });
      screenshots.push(filename);
    };
    try {
      await page.goto("/#resources");
      await expect(page.getByRole("heading", { name: "规则资源", exact: true })).toBeVisible();
      await expect(page.locator("[data-row-key]")).toHaveCount(resources.length);
      await page.evaluate(async () => { await document.fonts.ready; });
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
      for (const { id } of resources) await expect(controls(page, id).reason).toHaveCount(0);
      await healthyControl(page);
      await capture("healthy-start");
      await noPageOverflow(page);

      await failAndCancel(page, "accepted-short", harness, proposal);
      await failAndCancel(page, "accepted-long", harness, proposal);
      await assertFailure(page, "accepted-short", proposal);
      await assertFailure(page, "accepted-long", proposal);

      // Reset only for the explicitly labelled initial horizontal-position shot.
      // The subsequent focus shots rely solely on the product's focus behavior.
      await page.locator('[data-slot="table-container"]').evaluate((node) => { node.scrollLeft = 0; });
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await capture("both-failed-initial-horizontal-position");
      await screenshot("01-resulting-table-initial-position");
      await focusActions(page, "accepted-short", proposal, capture);
      await screenshot("02-short-failure-focused-actions");
      await focusActions(page, "accepted-long", proposal, capture);
      await screenshot("03-long-failure-focused-actions");
      if (width === 390) {
        for (const resizedWidth of [1440, 390]) {
          resizeMeasurements.push(await resizeSettlement(page, resizedWidth, proposal));
          await capture(`focused-long-row-resized-to-${resizedWidth}`);
        }
      }

      await retrySuccessfully(page, "accepted-short");
      // A successful retry must not erase a different row's retained failure.
      await assertFailure(page, "accepted-long", proposal);
      await expect(controls(page, "accepted-short").row.getByText("刷新失败", { exact: true })).toHaveCount(0);
      await capture("short-recovered-long-still-failed");
      await retrySuccessfully(page, "accepted-long");
      for (const { id } of resources) await expect(controls(page, id).row.getByText("刷新失败", { exact: true })).toHaveCount(0);
      await expect(page.getByText(requestReasons["accepted-long"], { exact: true })).toHaveCount(0);
      await capture("both-recovered");
      await noPageOverflow(page);
      expect(harness.refreshRequests.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "accepted-short", status: 503 },
        { id: "accepted-long", status: 503 },
        { id: "accepted-short", status: 200 },
        { id: "accepted-long", status: 200 },
      ]);
      expect(harness.unexpected).toEqual([]);
      expect(screenshots).toHaveLength(3);
    } catch (error) {
      // Keep early defects reviewable without exceeding the three-image budget.
      if (screenshots.length < 3) {
        try { await screenshot("failure-at-current-position"); }
        catch (captureError) { screenshotErrors.push(String(captureError)); }
      }
      throw error;
    } finally {
      const path = info.outputPath("resource-layout-metrics.json");
      await writeFile(path, JSON.stringify({
        schemaVersion: 1, variant: info.project.name, viewport: { width, height: 1000 },
        fixture: { resources, retainedReason, requestReasons },
        scope: "Synthetic intercepted browser layout and interaction only; no backend or live service.",
        interpretation: "Narrow-only proposal: full reason in actions below 768px, original delivery context at 768px and above. Table overflow and row-height growth are measured design tradeoffs. Visible ratios include viewport and ancestor clipping; delivery-context reason visibility at action focus is diagnostic.",
        screenshots, screenshotErrors, snapshots, resizeMeasurements,
        requests: harness.refreshRequests, unexpectedRequests: harness.unexpected,
      }, null, 2));
      await info.attach("resource-layout-metrics", { path, contentType: "application/json" });
    }
  });
}

// An unbroken stress name can force both designs to overflow even on desktop.
// Measure the ordinary short-name case separately so it cannot hide a proposal
// tradeoff in row height, action width, or table overflow.
for (const width of [1280, 1440]) {
  test(`ordinary resource full-error/action grouping comparison at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const proposal = info.project.name === "proposal";
    const harness = await setup(page, { includeLong: false });
    const ordinaryResources = resources.filter(({ id }) => id !== "accepted-long");
    const snapshots: Awaited<ReturnType<typeof snapshot>>[] = [];
    const capture = async (stage: string) => { snapshots.push(await snapshot(page, stage)); };
    const screenshots: string[] = [];
    const screenshotErrors: string[] = [];
    const screenshot = async (name: string) => {
      const filename = `${info.project.name}-ordinary-${width}-${name}.png`;
      await page.screenshot({ path: info.outputPath(filename), fullPage: false });
      screenshots.push(filename);
    };
    try {
      await page.goto("/#resources");
      await expect(page.getByRole("heading", { name: "规则资源", exact: true })).toBeVisible();
      await expect(page.locator("[data-row-key]")).toHaveCount(2);
      await expect(controls(page, "accepted-long").row).toHaveCount(0);
      await page.evaluate(async () => { await document.fonts.ready; });
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
      await healthyControl(page);
      await expect(controls(page, "accepted-short").reason).toHaveCount(0);
      await capture("ordinary-healthy-start");
      await noPageOverflow(page);

      await failAndCancel(page, "accepted-short", harness, proposal);
      // Cancellation restores the replacement button. Leave that focus owner
      // before resetting scroll, so the next action focus is a real transition
      // rather than focusing the same offscreen control without a focus event.
      await page.getByRole("button", { name: "添加公开引用", exact: true }).focus();
      await page.locator('[data-slot="table-container"]').evaluate((node) => { node.scrollLeft = 0; });
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await capture("ordinary-failed-initial-horizontal-position");
      await focusActions(page, "accepted-short", proposal, capture);
      await screenshot("failed-focused-actions");
      await retrySuccessfully(page, "accepted-short");
      await capture("ordinary-recovered");
      await noPageOverflow(page);
      expect(harness.refreshRequests.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "accepted-short", status: 503 },
        { id: "accepted-short", status: 200 },
      ]);
      expect(harness.unexpected).toEqual([]);
      expect(screenshots).toHaveLength(1);
    } catch (error) {
      if (screenshots.length === 0) {
        try { await screenshot("failure-at-current-position"); }
        catch (captureError) { screenshotErrors.push(String(captureError)); }
      }
      throw error;
    } finally {
      const path = info.outputPath("resource-layout-metrics.json");
      await writeFile(path, JSON.stringify({
        schemaVersion: 1, scenario: "ordinary-short-names", variant: info.project.name,
        viewport: { width, height: 1000 },
        fixture: { resources: ordinaryResources, retainedReason, requestReasons },
        scope: "Synthetic intercepted browser layout and interaction only; no backend or live service.",
        interpretation: "Short-name desktop control. Both variants retain the full reason outside actions at these widths. Table overflow and row-height growth are measured design tradeoffs, not automatic failures; compare actual geometry across projects.",
        screenshots, screenshotErrors, snapshots,
        requests: harness.refreshRequests, unexpectedRequests: harness.unexpected,
      }, null, 2));
      await info.attach("resource-layout-metrics", { path, contentType: "application/json" });
    }
  });
}

test("resource reason crosses the 767/768/769 breakpoint without losing focused context", async ({ page }, info) => {
  await page.setViewportSize({ width: 767, height: 1000 });
  const proposal = info.project.name === "proposal";
  const harness = await setup(page);
  const snapshots: Awaited<ReturnType<typeof snapshot>>[] = [];
  const capture = async (stage: string) => { snapshots.push(await snapshot(page, stage)); };
  const resizeMeasurements: Awaited<ReturnType<typeof resizeSettlement>>[] = [];
  const screenshots: string[] = [];
  const screenshotErrors: string[] = [];
  const screenshot = async (name: string) => {
    const filename = `${info.project.name}-breakpoint-${name}.png`;
    await page.screenshot({ path: info.outputPath(filename), fullPage: false });
    screenshots.push(filename);
  };
  try {
    await page.goto("/#resources");
    await expect(page.getByRole("heading", { name: "规则资源", exact: true })).toBeVisible();
    await expect(page.locator("[data-row-key]")).toHaveCount(resources.length);
    await page.evaluate(async () => { await document.fonts.ready; });
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await healthyControl(page);
    for (const { id } of resources) await expect(controls(page, id).reason).toHaveCount(0);
    await capture("breakpoint-healthy-at-767");
    await failAndCancel(page, "accepted-short", harness, proposal);
    await failAndCancel(page, "accepted-long", harness, proposal);
    await focusActions(page, "accepted-long", proposal, capture);
    // refresh remains focused throughout every breakpoint crossing. Neither
    // the harness nor a text locator refocuses or scrolls the row into view.
    for (const [index, width] of [767, 768, 769, 767].entries()) {
      resizeMeasurements.push(await resizeSettlement(page, width, proposal));
      await capture(`breakpoint-${index + 1}-focused-long-row-at-${width}`);
      await expect(page.locator('[role="alert"]')).toHaveCount(1);
      await expect(page.getByText(requestReasons["accepted-long"], { exact: true })).toHaveCount(1);
      if (index < 2) await screenshot(`focused-at-${width}`);
    }
    await retrySuccessfully(page, "accepted-short");
    await assertFailure(page, "accepted-long", proposal);
    await capture("breakpoint-short-recovered-long-still-failed");
    await retrySuccessfully(page, "accepted-long");
    await capture("breakpoint-both-recovered");
    await noPageOverflow(page);
    expect(harness.refreshRequests.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "accepted-short", status: 503 },
      { id: "accepted-long", status: 503 },
      { id: "accepted-short", status: 200 },
      { id: "accepted-long", status: 200 },
    ]);
    expect(harness.unexpected).toEqual([]);
    expect(screenshots).toHaveLength(2);
  } catch (error) {
    if (screenshots.length < 2) {
      try { await screenshot("failure-at-current-position"); }
      catch (captureError) { screenshotErrors.push(String(captureError)); }
    }
    throw error;
  } finally {
    const path = info.outputPath("resource-layout-metrics.json");
    await writeFile(path, JSON.stringify({
      schemaVersion: 1, scenario: "narrow-breakpoint-focus-retention", variant: info.project.name,
      viewport: { width: 767, height: 1000 }, sequence: [767, 768, 769, 767],
      fixture: { resources, retainedReason, requestReasons },
      scope: "Synthetic intercepted browser layout and interaction only; no backend or live service.",
      interpretation: "Narrow-only proposal moves one full reason at the 768px breakpoint. Measurements include actual geometry, placement, clipping and description IDs. Focus remains on the same refresh action across resize; no cross-project geometry equality is assumed.",
      screenshots, screenshotErrors, snapshots, resizeMeasurements,
      requests: harness.refreshRequests, unexpectedRequests: harness.unexpected,
    }, null, 2));
    await info.attach("resource-layout-metrics", { path, contentType: "application/json" });
  }
});
