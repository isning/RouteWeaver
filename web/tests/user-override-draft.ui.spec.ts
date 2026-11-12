import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App/session and editor, exact synthetic GETs plus one local preview response.
// No apply/save request can reach a backend. HTTP routing does not cover WebSockets.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const user = { id: "synthetic-override-user", name: "Synthetic override user", enabled: true, quotaBytes: 0, usedBytes: 0 };
const entitlement = { userId: user.id, startsAt: "2026-01-01T00:00:00Z", paused: false,
  cycle: { mode: "monthly", day: 1, anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
  quotaOverride: 50 * 1024 ** 3, onlineIpLimitOverride: 17, connectionLimitOverride: 9, entryRateBpsOverride: 125000 };
type EntitlementFixture = Omit<typeof entitlement, "quotaOverride" | "onlineIpLimitOverride" | "connectionLimitOverride" | "entryRateBpsOverride"> & {
  serviceId?: string; routeIdsOverride?: string[] | null; expiresAt?: string | null;
  quotaOverride?: number | null; onlineIpLimitOverride?: number | null; connectionLimitOverride?: number | null; entryRateBpsOverride?: number | null;
};
// Match the top-level omitempty fields exercised by this fixture. The real
// preview decodes PolicyChange into service.Entitlement and encodes a typed
// PolicyResourceReview; it does not echo the request map. Keep [] and 0 explicit.
function responseEntitlement(ent: EntitlementFixture): EntitlementFixture {
  const response = { ...ent };
  if (response.serviceId === "") delete response.serviceId;
  for (const field of ["expiresAt", "routeIdsOverride", "quotaOverride", "onlineIpLimitOverride", "connectionLimitOverride", "entryRateBpsOverride"] as const)
    if (response[field] == null) delete response[field];
  return response;
}
const effective = (ent: EntitlementFixture) => ({ userId: user.id, groupIds: [], routeIds: [], quotaBytes: ent.quotaOverride ?? 0,
  onlineIpLimit: ent.onlineIpLimitOverride ?? 0, connectionLimit: ent.connectionLimitOverride ?? 0,
  entryRateBps: ent.entryRateBpsOverride ?? 0, status: "active", provenance: {}, entitlement: responseEntitlement(ent) });
const precondition = { exists: true, revision: "synthetic-override-opening" };
const contextPath = `/api/access-policy/edit-context/entitlement/${user.id}`;
const scenarios = [
  { name: "quota", field: "quotaOverride", label: "个人周期额度（GiB）", saved: "50", value: 3 * 1024 ** 3, reviewRow: "个人周期额度", after: "3 GiB" },
  { name: "ip", field: "onlineIpLimitOverride", label: "个人在线 IP 数上限", saved: "17", value: 3, reviewRow: "个人在线 IP 上限", after: "3 个" },
  { name: "connection", field: "connectionLimitOverride", label: "个人并发逻辑流数上限", saved: "9", value: 3, reviewRow: "个人并发逻辑流上限", after: "3 条" },
  { name: "rate", field: "entryRateBpsOverride", label: "个人入口限速（Mbps）", saved: "1", value: 375000, reviewRow: "个人入口限速", after: "3 Mbps" },
] as const;
type Scenario = typeof scenarios[number];

// Observe real DOM events without changing focus, scrolling or animation timing.
// Only whitelisted synthetic control categories and geometry are retained.
async function observeLimitMotion(page: Page) {
  await page.addInitScript(() => {
    const observations: unknown[] = [];
    Object.defineProperty(window, "__userOverrideMotionObservations", { value: observations });
    const take = (event: string, node: EventTarget | null) => {
      if (!(node instanceof HTMLInputElement) || observations.length >= 50) return;
      const names = Array.from(node.labels ?? []).map(label => label.textContent?.trim());
      const field = names.includes("个人入口限速（Mbps）") ? "rate" : names.includes("个人在线 IP 数上限") ? "ip" : names.includes("个人并发逻辑流数上限") ? "connection" : names.includes("个人周期额度（GiB）") ? "quota" : null;
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

async function fixture(page: Page, baseURL: string | undefined, scenario: Scenario) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic user-override sampler requires loopback");
  const origin = new URL(baseURL).origin;
  const corrected = { ...entitlement, serviceId: "", routeIdsOverride: null, [scenario.field]: scenario.value };
  const inherited = { ...corrected, [scenario.field]: null };
  let expectedPhase: "correction" | "inheritance" = "correction";
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-override-admin", name: "Synthetic admin", role: "admin" }, csrfToken: "synthetic-override-only" },
    "/api/state": { users: [user], nodes: [], routes: [], revisions: [], capabilities: [], deploymentAvailable: false },
    "/api/services": [], "/api/published-routes": [], "/api/rates": [], "/api/settings": {}, "/api/user-groups": [],
    [`/api/users/${user.id}/admission-status`]: { asOf: "2026-01-01T00:00:00Z", maxLeaseSeconds: 30, onlineIps: [], activeStreams: 0, entries: [] },
    [contextPath]: { target: { kind: "entitlement", id: user.id }, record: { entitlement: responseEntitlement(entitlement) }, precondition, effective: effective(entitlement) },
  };
  const ledger = { contextReads: 0, authReads: 0, previewCommands: 0, previewRequests: 0,
    acceptedPreviews: 0, previewPhases: [] as string[], rejected: [] as string[], pageErrors: 0 };
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
      const after = expectedPhase === "correction" ? corrected : inherited;
      if (!isDeepStrictEqual(body, { change: { entitlement: after }, precondition }))
        return reject("unexpected synthetic preview intent");
      ledger.acceptedPreviews++; ledger.previewPhases.push(expectedPhase);
      return route.fulfill({ json: { revision: "synthetic-override-preview", guard: "opened-record", affected: [{ userId: user.id, before: effective(entitlement), after: effective(after) }], blockers: [],
        resource: { target: { kind: "entitlement", id: user.id }, before: { entitlement: responseEntitlement(entitlement) }, after: { entitlement: responseEntitlement(after) } } } });
    }
    if (method !== "GET") return reject("API mutation attempt");
    if (!Object.hasOwn(reads, url.pathname)) return reject("unexpected API read");
    if (url.pathname === contextPath) ledger.contextReads++;
    if (url.pathname === "/api/auth/me") ledger.authReads++;
    return route.fulfill({ json: reads[url.pathname] });
  });
  return { ledger, expectInheritance: () => { expectedPhase = "inheritance"; } };
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
  throw new Error("User-override task control was not reachable by ordinary keyboard traversal");
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
    const pixels = await page.screenshot({ path: info.outputPath(`user-override-${stage}.png`), fullPage: false, mask: [
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
    await writeFile(info.outputPath(`user-override-${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "User-override original capture or geometry failed");
  return geometry;
}

for (const width of [390, 1440]) for (const scenario of scenarios) {
  test(`user override ${scenario.name} blank correction at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 });
    const fixtureState = await fixture(page, baseURL, scenario), ledger = fixtureState.ledger, failures: unknown[] = [];
    await observeLimitMotion(page);
    const editor = page.getByRole("dialog", { name: `${user.name} 的服务授权`, exact: true });
    const limits = editor.getByRole("button", { name: "个人额度与限制", exact: true });
    const input = editor.getByRole("spinbutton", { name: scenario.label, exact: true });
    const enabled = editor.getByRole("checkbox", { name: `覆盖${scenario.label}`, exact: true });
    const mounted = editor.getByRole("spinbutton", { name: scenario.label, exact: true, includeHidden: true });
    const preview = editor.getByRole("button", { name: "预览影响", exact: true });
    const cancel = editor.getByRole("button", { name: "取消", exact: true });
    const review = page.getByRole("dialog", { name: "确认授权变更", exact: true });
    const activate = async (target: Locator, scope = editor, key = "Enter") => { await tabTo(page, scope, target); await page.keyboard.press(key); };
    const openEditor = async () => {
      await page.getByRole("button", { name: `更多操作 ${user.name}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "授权与续期", exact: true }).click();
      await expect(editor.getByLabel("开通时间", { exact: true })).toBeVisible();
      await settledTask(editor);
    };
    const collapse = async () => {
      await activate(limits); await expect(limits).toHaveAttribute("aria-expanded", "false");
      await settledTask(editor); await expect(mounted).toHaveCount(0);
    };
    const fieldFocus = { focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true, ring3px: true, ringInsideClips: true };
    let readyReads: number | undefined, authBaseline: number | undefined;
    try {
      await page.goto("/#users"); await openEditor();
      readyReads = ledger.contextReads; authBaseline = ledger.authReads;
      await activate(limits); await expect(input).toHaveValue(scenario.saved); await expect(enabled).toBeChecked();
      await tabTo(page, editor, input); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("Backspace");
      await expect(input).toHaveValue("");
      expect(await capture(page, info, "blank-input", editor, input, "")).toMatchObject(fieldFocus);
      ledger.previewCommands++; await activate(preview);
      await expect(input).toBeFocused(); await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(review).toHaveCount(0); expect(ledger.previewRequests).toBe(0);
      expect(await capture(page, info, "visible-blocked", editor, input, "")).toMatchObject({ ...fieldFocus, invalid: true });
      await collapse(); await capture(page, info, "collapsed-draft", editor, limits);
      ledger.previewCommands++; await activate(preview);
      await expect(limits).toHaveAttribute("aria-expanded", "true"); await expect(input).toBeFocused();
      await expect(input).toHaveValue(""); await expect(enabled).toBeChecked();
      await expect(review).toHaveCount(0); expect(ledger.previewRequests).toBe(0);
      expect(await capture(page, info, "collapsed-blocked", editor, input, "")).toMatchObject({ ...fieldFocus, invalid: true });
      await activate(cancel);
      const decision = page.getByRole("alertdialog", { name: "放弃尚未保存的授权修改？", exact: true });
      const keep = decision.getByRole("button", { name: "继续编辑", exact: true });
      await expect(decision).toBeVisible(); await capture(page, info, "discard-decision", decision, keep);
      await activate(keep, decision); await expect(decision).toHaveCount(0);
      await expect(input).toHaveValue(""); await expect(enabled).toBeChecked();
      await capture(page, info, "continued-draft", editor, cancel);
      await tabTo(page, editor, input); await page.keyboard.type("3");
      await collapse(); await activate(limits); await expect(input).toHaveValue("3");
      await tabTo(page, editor, input);
      expect(await capture(page, info, "corrected-remount", editor, input, "3")).toMatchObject(fieldFocus);
      ledger.previewCommands++; await activate(preview); await expect(review).toBeVisible();
      await expect(review.getByRole("row", { name: new RegExp(scenario.reviewRow) }).getByRole("cell").nth(1)).toHaveText(scenario.after);
      const correctionRows = review.getByRole("table", { name: "个人授权变更", exact: true }).getByRole("rowheader");
      await expect(correctionRows).toHaveText([scenario.reviewRow]);
      await capture(page, info, "correction-review", review);
      expect(ledger.previewPhases).toEqual(["correction"]);
      await activate(review.getByRole("button", { name: "返回编辑", exact: true }), review); await expect(review).toHaveCount(0);
      // Explicitly disable the previously blank/corrected override: this alone means inheritance.
      await activate(enabled, editor, "Space"); await expect(enabled).not.toBeChecked(); await expect(mounted).toHaveCount(0);
      fixtureState.expectInheritance(); ledger.previewCommands++; await activate(preview); await expect(review).toBeVisible();
      await expect(review.getByRole("row", { name: new RegExp(scenario.reviewRow) }).getByRole("cell").nth(1)).toHaveText("继承");
      const inheritanceRows = review.getByRole("table", { name: "个人授权变更", exact: true }).getByRole("rowheader");
      await expect(inheritanceRows).toHaveText([scenario.reviewRow]);
      await capture(page, info, "inheritance-review", review);
      expect(ledger.previewPhases).toEqual(["correction", "inheritance"]);
      expect(ledger.previewRequests).toBe(2); expect(ledger.acceptedPreviews).toBe(2);
      expect(ledger.contextReads).toBe(readyReads); expect(ledger.authReads).toBe(authBaseline);
      await activate(review.getByRole("button", { name: "返回编辑", exact: true }), review); await expect(review).toHaveCount(0); await settledTask(editor); await activate(cancel);
      await expect(decision).toBeVisible(); await activate(decision.getByRole("button", { name: "放弃修改", exact: true }), decision);
      await expect(editor).toHaveCount(0); await openEditor(); await activate(limits);
      await expect(input).toHaveValue(scenario.saved); await expect(enabled).toBeChecked(); await tabTo(page, editor, input);
      expect(await capture(page, info, "fresh-reset", editor, input, scenario.saved)).toMatchObject(fieldFocus);
      expect(ledger.previewRequests).toBe(2); expect(ledger.authReads).toBe(authBaseline);
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), undefined, undefined, false); } catch (error) { failures.push(error); }
      try {
        const motionTimeline = await page.evaluate(() => (window as unknown as { __userOverrideMotionObservations?: unknown[] }).__userOverrideMotionObservations ?? []);
        const body = JSON.stringify({ width, scenario: scenario.name, readyReads, authBaseline, motionTimeline, ...ledger,
          scope: "Synthetic native user-override draft and preview only; no apply/backend enforcement" }, null, 2);
        await writeFile(info.outputPath("user-override-request-ledger.json"), body);
        await info.attach("user-override-request-ledger", { body, contentType: "application/json" });
        expect(ledger.rejected).toEqual([]); expect(ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "User-override journey or evidence failed");
  });
}


// Pure serializer checks; no page fixture is requested.
test("user-override fixture mirrors typed optional-field omission without changing request intent", () => {
  const request: EntitlementFixture = { ...entitlement, serviceId: "", routeIdsOverride: null, expiresAt: null,
    quotaOverride: null, onlineIpLimitOverride: null, connectionLimitOverride: null, entryRateBpsOverride: null };
  expect(responseEntitlement(request)).toEqual({ userId: user.id, startsAt: "2026-01-01T00:00:00Z", paused: false,
    cycle: { mode: "monthly", day: 1, anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" } });
  expect(request).toEqual({ ...entitlement, serviceId: "", routeIdsOverride: null, expiresAt: null,
    quotaOverride: null, onlineIpLimitOverride: null, connectionLimitOverride: null, entryRateBpsOverride: null });
  const explicit: EntitlementFixture = { ...request, serviceId: "explicit-plan", routeIdsOverride: [],
    quotaOverride: 0, onlineIpLimitOverride: 0, connectionLimitOverride: 0, entryRateBpsOverride: 0 };
  expect(responseEntitlement(explicit)).toEqual({ userId: user.id, startsAt: "2026-01-01T00:00:00Z", paused: false,
    cycle: { mode: "monthly", day: 1, anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
    serviceId: "explicit-plan", routeIdsOverride: [], quotaOverride: 0, onlineIpLimitOverride: 0, connectionLimitOverride: 0, entryRateBpsOverride: 0 });
  expect(responseEntitlement({ ...explicit, routeIdsOverride: ["chosen-route"], expiresAt: "2027-01-01T00:00:00Z" }))
    .toMatchObject({ routeIdsOverride: ["chosen-route"], expiresAt: "2027-01-01T00:00:00Z" });
});
