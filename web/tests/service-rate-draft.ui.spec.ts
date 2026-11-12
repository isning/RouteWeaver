import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App/session and editor, exact synthetic GETs plus one local preview response.
// No apply/save request can reach a backend. HTTP routing does not cover WebSockets.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const service = {
  id: "synthetic-rate-plan", name: "Synthetic rate plan", quotaBytes: 1073741824,
  routeIds: [], onlineIpLimit: 2, connectionLimit: 10, entryRateBps: 250000,
  cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "UTC+8" },
};
const precondition = { exists: true, revision: "synthetic-rate-opening" };
const corrected = { ...service, entryRateBps: 375000 };
const contextPath = "/api/access-policy/edit-context/service/synthetic-rate-plan";
const scenarios = [{ name: "visible-minus", raw: "-", collapse: false },
  { name: "collapsed-exponent", raw: "1e", collapse: true }] as const;

// Observe real DOM events without changing focus, scrolling or animation timing.
// Only whitelisted synthetic control categories and geometry are retained.
async function observeLimitMotion(page: Page) {
  await page.addInitScript(() => {
    const observations: unknown[] = [];
    Object.defineProperty(window, "__serviceRateMotionObservations", { value: observations });
    const take = (event: string, node: EventTarget | null) => {
      if (!(node instanceof HTMLInputElement) || observations.length >= 50) return;
      const names = Array.from(node.labels ?? []).map(label => label.textContent?.trim());
      const field = names.includes("每个入口限速（Mbps）") ? "rate" : names.includes("账号在线 IP 数上限") ? "ip" : names.includes("账号并发逻辑流数上限") ? "connection" : null;
      const content = node.closest<HTMLElement>('[data-slot="accordion-content"]');
      const body = node.closest<HTMLElement>("[data-task-overlay-body]");
      if (!field || !content || !body) return;
      const box = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      };
      observations.push({ event, field, time: performance.now(), focused: document.activeElement === node,
        input: box(node), accordion: box(content), body: box(body), state: content.getAttribute("data-state"),
        taskScroll: body.closest('[role="dialog"]')?.getAttribute("data-task-scroll") ?? null });
    };
    document.addEventListener("focusin", event => take("focus-capture", event.target), true);
    document.addEventListener("focusin", event => take("focus-bubble", event.target));
    document.addEventListener("beforeinput", event => take("beforeinput", event.target), true);
    document.addEventListener("input", event => take("input-bubble", event.target));
    const opening = (event: AnimationEvent, phase: string) => {
      const content = event.target;
      if (event.animationName !== "accordion-down" || !(content instanceof HTMLElement) ||
          !content.matches('[data-slot="accordion-content"][data-state="open"]')) return;
      const target = document.activeElement;
      if (content.contains(target)) take(phase, target);
    };
    document.addEventListener("animationend", event => opening(event, "opening-end-capture"), true);
    document.addEventListener("animationend", event => opening(event, "opening-end-bubble"));
  });
}

async function fixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic service-rate sampler requires loopback");
  const origin = new URL(baseURL).origin;
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-rate-admin", name: "Synthetic admin", role: "admin" }, csrfToken: "synthetic-rate-only" },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/services": [service], "/api/published-routes": [], "/api/rates": [],
    [contextPath]: { target: { kind: "service", id: service.id }, record: { service }, precondition },
  };
  const ledger = { contextReads: 0, authReads: 0, previewCommands: 0, previewRequests: 0,
    acceptedPreviews: 0, previewRateBytes: [] as number[], rejected: [] as string[], pageErrors: 0 };
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    // Only categories and already-validated synthetic numeric values are logged.
    const reject = (reason: string) => { ledger.rejected.push(reason); return route.abort("blockedbyclient"); };
    if (url.origin !== origin || url.username || url.password || url.hash) return reject("external or metadata-bearing request");
    if (!url.pathname.startsWith("/api/")) {
      const staticPath = ["/", "/favicon.ico", "/@vite/client", "/@react-refresh"].includes(url.pathname) ||
        /^\/(?:src|node_modules|assets)\/[^?#]+\.(?:[cm]?[jt]sx?|css|woff2?|ttf|svg)$/.test(url.pathname);
      const staticQuery = [...url.searchParams].every(([key, value]) =>
        (key === "v" && /^[a-zA-Z0-9_-]+$/.test(value)) ||
        (key === "t" && /^\d+$/.test(value)) || (key === "import" && value === ""));
      if (method === "GET" && staticPath && staticQuery) return route.continue();
      return reject("unexpected static request");
    }
    if (url.search) return reject("API query metadata");
    if (method === "POST" && url.pathname === "/api/access-policy/preview") {
      ledger.previewRequests++;
      let body: unknown;
      try { body = request.postDataJSON(); } catch { return reject("invalid synthetic preview JSON"); }
      if (!isDeepStrictEqual(body, { change: { service: corrected }, precondition }))
        return reject("unexpected synthetic preview intent");
      ledger.acceptedPreviews++; ledger.previewRateBytes.push(375000);
      return route.fulfill({ json: { revision: "synthetic-rate-preview", guard: "opened-record", affected: [], blockers: [],
        resource: { target: { kind: "service", id: service.id }, before: { service }, after: { service: corrected } } } });
    }
    if (method !== "GET") return reject("API mutation attempt");
    if (!Object.hasOwn(reads, url.pathname)) return reject("unexpected API read");
    if (url.pathname === contextPath) ledger.contextReads++;
    if (url.pathname === "/api/auth/me") ledger.authReads++;
    return route.fulfill({ json: reads[url.pathname] });
  });
  return ledger;
}

async function tabTo(page: Page, scope: Locator, target: Locator) {
  await expect(target).toBeVisible();
  for (let step = 0; step < 40; step++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    const backwards = await target.evaluate((node) => !!(
      document.activeElement?.compareDocumentPosition(node)! & Node.DOCUMENT_POSITION_PRECEDING));
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    expect(await scope.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  throw new Error("Service-rate task control was not reachable by ordinary keyboard traversal");
}

async function capture(page: Page, info: TestInfo, stage: string, surface: Locator,
  target?: Locator, expectedRaw?: string, settle = true) {
  const failures: unknown[] = [];
  let settlingFailed = false;
  try { if (settle) await settledTask(surface); }
  catch (error) { settlingFailed = true; failures.push(error); }
  // Preserve original current-viewport pixels before any geometry assertion.
  // No script focus, forced scrolling, motion override or overlay removal.
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`service-rate-${stage}.png`), fullPage: false, mask: [
      page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]'),
    ] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  let geometry: Record<string, number | boolean | string | null> | null = null;
  try {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, focusedTag: document.activeElement?.tagName || null }));
    const count = target ? await target.count() : 0;
    geometry = target && count === 1 ? await target.evaluate((node, expected) => {
      const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      let clipLeft = 0, clipTop = 0, clipRight = innerWidth, clipBottom = innerHeight;
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          clipLeft = Math.max(clipLeft, box.left + ancestor.clientLeft);
          clipRight = Math.min(clipRight, box.left + ancestor.clientLeft + ancestor.clientWidth);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          clipTop = Math.max(clipTop, box.top + ancestor.clientTop);
          clipBottom = Math.min(clipBottom, box.top + ancestor.clientTop + ancestor.clientHeight);
        }
      }
      const shadow = getComputedStyle(node).boxShadow;
      const error = (node.getAttribute("aria-describedby") ?? "").split(/\s+/)
        .map(id => document.getElementById(id)).find(element => element?.textContent?.trim() ===
          "请输入非负 Mbps 数值，需为 0.000008 Mbps 的整数倍且不超过上限");
      const errorBox = error?.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        shadow, clipLeft, clipTop, clipRight, clipBottom,
        errorTextMatches: !!error,
        errorInViewport: !!errorBox && errorBox.width > 0 && errorBox.height > 0 &&
          errorBox.left >= clipLeft && errorBox.right <= clipRight && errorBox.top >= clipTop && errorBox.bottom <= clipBottom,
        // Official shadcn input/button ring; independently verify settled paint.
        ring3px: /(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/.test(shadow),
        ringInsideClips: r.left - 3 >= clipLeft - 0.5 && r.right + 3 <= clipRight + 0.5 &&
          r.top - 3 >= clipTop - 0.5 && r.bottom + 3 <= clipBottom + 0.5,
        inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
        hit: hit === node || node.contains(hit),
        invalid: node.getAttribute("aria-invalid") === "true",
        nativeValid: node instanceof HTMLInputElement ? node.validity.valid : null,
        inputMatches: expected !== undefined && node instanceof HTMLInputElement ? node.value === expected : null };
    }, expectedRaw) : null;
    const body = JSON.stringify({ viewport, geometry, count, settlingFailed }, null, 2);
    await writeFile(info.outputPath(`service-rate-${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Service-rate original capture or geometry failed");
  return geometry;
}

for (const width of [390, 1440]) for (const scenario of scenarios) {
  test(`service rate ${scenario.name} correction at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 });
    const ledger = await fixture(page, baseURL), failures: unknown[] = [];
    await observeLimitMotion(page);
    const editor = page.getByRole("dialog", { name: `编辑 ${service.name}`, exact: true });
    const limits = editor.getByRole("button", { name: "在线、并发与速率限制", exact: true });
    const rate = editor.getByRole("spinbutton", { name: "每个入口限速（Mbps）", exact: true });
    const preview = editor.getByRole("button", { name: "预览影响", exact: true });
    const cancel = editor.getByRole("button", { name: "取消", exact: true });
    const review = page.getByRole("dialog", { name: "确认授权变更", exact: true });
    const mountedRate = editor.getByRole("spinbutton", { name: "每个入口限速（Mbps）", exact: true, includeHidden: true });
    let readyReads: number | undefined, authBaseline: number | undefined;
    const activate = async (target: Locator, scope = editor) => {
      await tabTo(page, scope, target); await page.keyboard.press("Enter");
    };
    const collapseLimits = async () => {
      await activate(limits); await expect(limits).toHaveAttribute("aria-expanded", "false");
      await settledTask(editor);
      // Include hidden controls: aria-expanded alone does not prove that the
      // animated content has unmounted before the next open/submit gesture.
      await expect(mountedRate).toHaveCount(0);
    };
    try {
      await page.goto("/#services");
      await page.getByRole("group", { name: `${service.name} 的操作`, exact: true })
        .getByRole("button", { name: "编辑", exact: true }).click();
      await expect(editor.getByRole("textbox", { name: "服务方案名称", exact: true })).toHaveValue(service.name);
      await settledTask(editor);
      readyReads = ledger.contextReads; authBaseline = ledger.authReads;
      await activate(limits); await expect(rate).toHaveValue("2");
      await tabTo(page, editor, rate); await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(scenario.raw);
      await expect(rate).toHaveValue(scenario.raw);
      const raw = await capture(page, info, "raw-input", editor, rate, scenario.raw);
      expect(raw).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true, ring3px: true, ringInsideClips: true });
      if (scenario.collapse) {
        await collapseLimits();
        await capture(page, info, "collapsed-draft", editor, limits);
      }
      ledger.previewCommands++;
      await activate(preview);
      await expect(limits).toHaveAttribute("aria-expanded", "true");
      await expect(rate).toBeFocused(); await expect(rate).toHaveValue(scenario.raw);
      await expect(editor.getByText("请输入非负 Mbps 数值，需为 0.000008 Mbps 的整数倍且不超过上限", { exact: true })).toBeVisible();
      await expect(review).toHaveCount(0);
      expect(ledger.previewRequests).toBe(0);
      const invalid = await capture(page, info, "blocked-preview", editor, rate, scenario.raw);
      expect(invalid).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, invalid: true, inputMatches: true, ring3px: true, ringInsideClips: true });
      if (scenario.collapse) expect(invalid).toMatchObject({ errorTextMatches: true, errorInViewport: true });
      await activate(cancel);
      const decision = page.getByRole("alertdialog", { name: "放弃尚未保存的授权修改？", exact: true });
      const continueEditing = decision.getByRole("button", { name: "继续编辑", exact: true });
      await expect(decision).toBeVisible();
      const choice = await capture(page, info, "discard-decision", decision, continueEditing);
      expect(choice).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await activate(continueEditing, decision); await expect(decision).toHaveCount(0);
      await expect(rate).toHaveValue(scenario.raw); expect(ledger.previewRequests).toBe(0);
      const continued = await capture(page, info, "continued-draft", editor, cancel);
      expect(continued).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await tabTo(page, editor, rate); await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("+03.000");
      await collapseLimits();
      await activate(limits); await expect(rate).toHaveValue("+03.000");
      await tabTo(page, editor, rate);
      const corrected = await capture(page, info, "corrected-remount", editor, rate, "+03.000");
      expect(corrected).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true, ring3px: true, ringInsideClips: true });
      ledger.previewCommands++;
      await activate(preview); await expect(review).toBeVisible();
      await expect(review.getByRole("row", { name: /每个逻辑入口速率/ }).getByRole("cell").nth(1)).toHaveText("3 Mbps");
      await capture(page, info, "preview-review", review);
      expect(ledger.previewRequests).toBe(1); expect(ledger.acceptedPreviews).toBe(1);
      expect(ledger.previewRateBytes).toEqual([375000]);
      expect(ledger.contextReads).toBe(readyReads); expect(ledger.authReads).toBe(authBaseline);
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), undefined, undefined, false); }
      catch (error) { failures.push(error); }
      try {
        const motionTimeline = await page.evaluate(() =>
          (window as unknown as { __serviceRateMotionObservations?: unknown[] }).__serviceRateMotionObservations ?? []);
        const body = JSON.stringify({ width, scenario: scenario.name, readyReads, authBaseline, motionTimeline, ...ledger,
          scope: "Synthetic native service-rate draft and preview only; no save/apply/backend enforcement" }, null, 2);
        await writeFile(info.outputPath("service-rate-request-ledger.json"), body);
        await info.attach("service-rate-request-ledger", { body, contentType: "application/json" });
        expect(ledger.rejected).toEqual([]); expect(ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Service-rate journey or evidence failed");
  });
}
