import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App/session and editor, exact synthetic GETs plus one local preview response.
// No apply/save request can reach a backend. HTTP routing does not cover WebSockets.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const serviceFor = (mode: "monthly" | "fixed-days") => ({
  id: "synthetic-cycle-plan", name: "Synthetic cycle plan", quotaBytes: 1073741824,
  routeIds: [], onlineIpLimit: 2, connectionLimit: 10, entryRateBps: 250000,
  cycle: { mode, day: 1, days: 23, anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
});
const precondition = { exists: true, revision: "synthetic-cycle-opening" };
const contextPath = "/api/access-policy/edit-context/service/synthetic-cycle-plan";
const scenarios = [
  { mode: "monthly", field: "day", label: "每月几号", saved: "1", incomplete: "-", fraction: "1.0000000000000001", correction: "2e0", value: 2, reviewRow: "每月重置日", after: "2 日", modeLabel: "每月固定日" },
  { mode: "fixed-days", field: "days", label: "每周期天数", saved: "23", incomplete: "1e", fraction: "23.0000000000000001", correction: "24.000", value: 24, reviewRow: "周期天数", after: "24 天", modeLabel: "固定天数周期" },
] as const;
type Scenario = typeof scenarios[number];

async function fixture(page: Page, baseURL: string | undefined, scenario: Scenario) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic service-cycle sampler requires loopback");
  const origin = new URL(baseURL).origin;
  const service = serviceFor(scenario.mode);
  const corrected = { ...service, cycle: { ...service.cycle, [scenario.field]: scenario.value } };
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-cycle-admin", name: "Synthetic admin", role: "admin" }, csrfToken: "synthetic-cycle-only" },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/services": [service], "/api/published-routes": [], "/api/rates": [],
    [contextPath]: { target: { kind: "service", id: service.id }, record: { service }, precondition },
  };
  const ledger = { contextReads: 0, authReads: 0, previewCommands: 0, previewRequests: 0,
    acceptedPreviews: 0, previewValues: [] as number[], rejected: [] as string[], pageErrors: 0 };
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
      ledger.acceptedPreviews++; ledger.previewValues.push(scenario.value);
      return route.fulfill({ json: { revision: "synthetic-cycle-preview", guard: "opened-record", affected: [], blockers: [],
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
  throw new Error("Service-cycle task control was not reachable by ordinary keyboard traversal");
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
    const pixels = await page.screenshot({ path: info.outputPath(`service-cycle-${stage}.png`), fullPage: false, mask: [
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
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        shadow, clipLeft, clipTop, clipRight, clipBottom,
        // Official shadcn input/button ring; independently verify settled paint.
        ring3px: /(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/.test(shadow),
        ringInsideClips: r.left - 3 >= clipLeft - 0.5 && r.right + 3 <= clipRight + 0.5 &&
          r.top - 3 >= clipTop - 0.5 && r.bottom + 3 <= clipBottom + 0.5,
        inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
        hit: hit === node || node.contains(hit),
        invalid: node.getAttribute("aria-invalid") === "true",
        nativeValid: node instanceof HTMLInputElement ? node.validity.valid : null,
        nativeCustomError: node instanceof HTMLInputElement ? node.validity.customError : null,
        inputMatches: expected !== undefined && node instanceof HTMLInputElement ? node.value === expected : null };
    }, expectedRaw) : null;
    const body = JSON.stringify({ viewport, geometry, count, settlingFailed }, null, 2);
    await writeFile(info.outputPath(`service-cycle-${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Service-cycle original capture or geometry failed");
  return geometry;
}

for (const width of [390, 1440]) for (const scenario of scenarios) {
  test(`service cycle ${scenario.mode} exact draft at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 });
    const service = serviceFor(scenario.mode), ledger = await fixture(page, baseURL, scenario), failures: unknown[] = [];
    const editor = page.getByRole("dialog", { name: `编辑 ${service.name}`, exact: true });
    const input = editor.getByRole("spinbutton", { name: scenario.label, exact: true });
    const mode = editor.getByRole("combobox", { name: "默认重置规则", exact: true });
    const preview = editor.getByRole("button", { name: "预览影响", exact: true });
    const cancel = editor.getByRole("button", { name: "取消", exact: true });
    const review = page.getByRole("dialog", { name: "确认授权变更", exact: true });
    const activate = async (target: Locator, scope = editor) => { await tabTo(page, scope, target); await page.keyboard.press("Enter"); };
    const openEditor = async () => {
      await page.getByRole("group", { name: `${service.name} 的操作`, exact: true }).getByRole("button", { name: "编辑", exact: true }).click();
      await expect(editor.getByRole("textbox", { name: "服务方案名称", exact: true })).toHaveValue(service.name);
      await settledTask(editor);
    };
    const type = async (raw: string) => { await tabTo(page, editor, input); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type(raw); await expect(input).toHaveValue(raw); };
    const fieldFocus = { focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true, ring3px: true, ringInsideClips: true };
    let readyReads: number | undefined, authBaseline: number | undefined;
    try {
      await page.goto("/#services"); await openEditor();
      readyReads = ledger.contextReads; authBaseline = ledger.authReads;
      await expect(input).toHaveValue(scenario.saved); await expect(mode).toHaveText(scenario.modeLabel);
      await type(scenario.incomplete);
      expect(await capture(page, info, "incomplete-input", editor, input, scenario.incomplete)).toMatchObject({ ...fieldFocus, nativeValid: false, nativeCustomError: true });
      ledger.previewCommands++; await activate(preview); await expect(input).toBeFocused();
      await expect(review).toHaveCount(0); expect(ledger.previewRequests).toBe(0);
      expect(await capture(page, info, "native-blocked", editor, input, scenario.incomplete)).toMatchObject({ ...fieldFocus, nativeValid: false, nativeCustomError: true });
      await activate(cancel);
      const decision = page.getByRole("alertdialog", { name: "放弃尚未保存的授权修改？", exact: true });
      const keep = decision.getByRole("button", { name: "继续编辑", exact: true });
      await expect(decision).toBeVisible(); await capture(page, info, "discard-decision", decision, keep);
      await activate(keep, decision); await expect(decision).toHaveCount(0);
      await expect(input).toHaveValue(scenario.incomplete); await expect(mode).toHaveText(scenario.modeLabel);
      await capture(page, info, "continued-draft", editor, cancel);
      // Native Number(raw) rounds this tiny fraction to the old valid integer.
      // The caller's exact decimal check must still refuse Preview with the mode unchanged.
      await type(scenario.fraction);
      expect(await capture(page, info, "fraction-input", editor, input, scenario.fraction)).toMatchObject({ ...fieldFocus, nativeValid: true, nativeCustomError: false });
      ledger.previewCommands++; await activate(preview); await expect(input).toBeFocused();
      await expect(review).toHaveCount(0); expect(ledger.previewRequests).toBe(0);
      await expect(mode).toHaveText(scenario.modeLabel);
      expect(await capture(page, info, "fraction-blocked", editor, input, scenario.fraction)).toMatchObject({ ...fieldFocus, invalid: true, nativeValid: true, nativeCustomError: false });
      await type(scenario.correction);
      expect(await capture(page, info, "corrected-input", editor, input, scenario.correction)).toMatchObject({ ...fieldFocus, nativeValid: true, nativeCustomError: false });
      ledger.previewCommands++; await activate(preview); await expect(review).toBeVisible();
      await expect(review.getByRole("row", { name: new RegExp(scenario.reviewRow) }).getByRole("cell").nth(1)).toHaveText(scenario.after);
      await capture(page, info, "preview-review", review);
      expect(ledger.previewRequests).toBe(1); expect(ledger.acceptedPreviews).toBe(1); expect(ledger.previewValues).toEqual([scenario.value]);
      expect(ledger.contextReads).toBe(readyReads); expect(ledger.authReads).toBe(authBaseline);
      await activate(review.getByRole("button", { name: "返回编辑", exact: true }), review);
      await expect(review).toHaveCount(0); await settledTask(editor); await activate(cancel);
      await expect(decision).toBeVisible(); await activate(decision.getByRole("button", { name: "放弃修改", exact: true }), decision);
      await expect(editor).toHaveCount(0); await openEditor(); await expect(input).toHaveValue(scenario.saved); await expect(mode).toHaveText(scenario.modeLabel);
      await tabTo(page, editor, input);
      expect(await capture(page, info, "fresh-reset", editor, input, scenario.saved)).toMatchObject(fieldFocus);
      expect(ledger.previewRequests).toBe(1); expect(ledger.authReads).toBe(authBaseline);
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), undefined, undefined, false); } catch (error) { failures.push(error); }
      try {
        const body = JSON.stringify({ width, mode: scenario.mode, readyReads, authBaseline, ...ledger,
          scope: "Synthetic native active service-cycle draft and preview only; no apply/backend enforcement or latest-read race coverage" }, null, 2);
        await writeFile(info.outputPath("service-cycle-request-ledger.json"), body);
        await info.attach("service-cycle-request-ledger", { body, contentType: "application/json" });
        expect(ledger.rejected).toEqual([]); expect(ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Service-cycle journey or evidence failed");
  });
}
