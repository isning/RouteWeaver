import { isDeepStrictEqual } from "node:util";
import { writeFile } from "node:fs/promises";
import { expect, test, type JSHandle, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App + exact synthetic loopback HTTP. Default cases are GET-only.
// The two delayed-success outcomes may each arm one exact reset POST, held and
// fulfilled locally. All other API writes are aborted; none reach a server.
// HTTP interception does not cover WebSockets or prove backend enforcement.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

const csrf = "synthetic-reset-review-only";
const account = { id: "synthetic-reset-user", name: "合成用量用户", enabled: true, quotaBytes: 0, usedBytes: 0 };
const entitlement = {
  userId: account.id, serviceId: "", startsAt: "2026-02-03T04:05:06Z", paused: false,
  cycle: { mode: "monthly", day: 1, anchor: "2026-02-03T04:05:06Z", timezone: "UTC+8" },
  quotaOverride: null, onlineIpLimitOverride: null, connectionLimitOverride: null,
  entryRateBpsOverride: null, routeIdsOverride: null,
};
const contextPath = `/api/access-policy/edit-context/entitlement/${account.id}`;
const admissionPath = `/api/users/${account.id}/admission-status`;
const draftText = "  Synthetic audit reason\nKeep exact spacing  ";
const stages = [
  "reason-draft", "reset-review", "reset-canceled", "discard-review", "draft-continued",
  "reopened-clean", "navigation-review", "navigation-stayed", "navigation-left", "forward-clean",
  "pending-reset", "navigation-after-reset", "success-stayed", "success-left", "final-original",
] as const;
type Stage = typeof stages[number];

type WriteMode = "forbid" | "held-reset";
function validReset(request: Request) {
  try {
    const bytes = request.postDataBuffer();
    if (!bytes || bytes.length > 4096 ||
      request.headers()["content-type"]?.split(";")[0].trim() !== "application/json" ||
      request.headers()["x-csrf-token"] !== csrf) return false;
    return isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), { reason: draftText });
  } catch { return false; }
}

async function fixture(page: Page, baseURL: string | undefined, writeMode: WriteMode = "forbid") {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic usage-reset ownership requires loopback");
  const origin = new URL(baseURL).origin;
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-reset-admin", name: "合成管理员", role: "admin" }, csrfToken: csrf },
    "/api/state": { users: [account], nodes: [], routes: [], revisions: [], capabilities: [] },
    // Back/Forward journeys visit Services, which mounts RateSettings.
    // Fulfill only its exact GET; query metadata and all writes remain guarded.
    "/api/rates": [],
    "/api/services": [], "/api/published-routes": [], "/api/user-groups": [], "/api/invites": [], "/api/me/notifications": [],
    [contextPath]: { target: { kind: "entitlement", id: account.id }, record: { entitlement },
      precondition: { exists: true, revision: "synthetic-reset-opened" },
      effective: { userId: account.id, groupIds: [], routeIds: [], quotaBytes: 0,
        onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, status: "active", provenance: {}, entitlement } },
    [admissionPath]: { asOf: entitlement.startsAt, maxLeaseSeconds: 30, onlineIps: [], activeStreams: 0, entries: [] },
  };
  const ledger = {
    writeMode, contextReads: 0, admissionReads: 0, apiWriteAttempts: 0, resetWriteAttempts: 0, policyWriteAttempts: 0,
    resetReviews: 0, resetCancels: 0, discardReviews: 0, continuedDraft: false, reopenedClean: false,
    navigationReviews: 0, stayedWithLiveReview: false, departedWithReviewRetired: false, forwardWithoutResurrection: false,
    authorizedResets: 0, resetPayloadChecks: [] as boolean[], resetSettlements: 0, abortedHeldResets: 0,
    responseReleased: false, successWithNavigationFocus: false, reasonFocusBeforeDecision: 0, reasonFocusAfterDecision: 0,
    pageErrors: 0, rejected: [] as string[],
  };
  let resetArmed = false, closing = false;
  let releaseHeldReset: (() => void) | undefined, heldResetDone: Promise<void> | undefined;
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (reason: string) => {
      // Persist fixed categories/counters only, never request URLs, payloads,
      // headers, query values, cookies, credentials or arbitrary error text.
      ledger.rejected.push(reason);
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin || url.username || url.password || url.hash)
      return reject("external or metadata-bearing request");
    if (!url.pathname.startsWith("/api/")) {
      const staticPath = ["/", "/favicon.ico", "/@vite/client", "/@react-refresh"].includes(url.pathname) ||
        /^\/(?:src|node_modules|assets)\/[^?#]+\.(?:[cm]?[jt]sx?|css|woff2?|ttf|svg)$/.test(url.pathname);
      const staticQuery = [...url.searchParams].every(([key, value]) =>
        (key === "v" && /^[a-zA-Z0-9_-]+$/.test(value)) ||
        (key === "t" && /^\d+$/.test(value)) || (key === "import" && value === ""));
      if (method === "GET" && staticPath && staticQuery) return route.continue();
      return reject("unexpected static request");
    }
    if (method !== "GET") {
      ledger.apiWriteAttempts++;
      if (url.pathname === `/api/users/${account.id}/reset`) ledger.resetWriteAttempts++;
      if (["/api/access-policy/preview", "/api/access-policy/apply"].includes(url.pathname)) ledger.policyWriteAttempts++;
      if (writeMode === "held-reset" && method === "POST" && url.pathname === `/api/users/${account.id}/reset` && !url.search) {
        const valid = validReset(request);
        ledger.resetPayloadChecks.push(valid);
        if (!valid || !resetArmed || closing || ledger.authorizedResets !== 0)
          return reject("unexpected or mismatched synthetic reset");
        resetArmed = false;
        ledger.authorizedResets++;
        const responseGate = new Promise<void>(resolve => { releaseHeldReset = resolve; });
        heldResetDone = (async () => {
          await responseGate;
          if (closing) {
            ledger.abortedHeldResets++;
            await route.abort("blockedbyclient");
          } else {
            ledger.resetSettlements++;
            await route.fulfill({ json: {} });
          }
        })();
        return heldResetDone;
      }
      return reject("API mutation attempt");
    }
    if (url.search) return reject("API query metadata");
    if (!Object.hasOwn(reads, url.pathname)) return reject("unexpected API read");
    if (url.pathname === contextPath) ledger.contextReads++;
    if (url.pathname === admissionPath) ledger.admissionReads++;
    return route.fulfill({ json: reads[url.pathname] });
  });
  return {
    ledger,
    authorizeReset() {
      if (writeMode !== "held-reset" || closing || resetArmed || ledger.authorizedResets !== 0)
        throw new Error("Synthetic reset may be armed exactly once in a held-success case");
      resetArmed = true;
    },
    async releaseReset() {
      if (!releaseHeldReset || !heldResetDone || closing || ledger.responseReleased)
        throw new Error("Synthetic reset response is not pending for release");
      ledger.responseReleased = true;
      releaseHeldReset();
      await heldResetDone;
    },
    async dispose() {
      closing = true;
      resetArmed = false;
      releaseHeldReset?.();
      try { await heldResetDone; }
      catch { throw new Error("Synthetic held reset cleanup failed"); }
    },
  };
}

type HTTPFixture = Awaited<ReturnType<typeof fixture>>;

async function tabTo(page: Page, scope: Locator, target: Locator) {
  await expect(target).toBeVisible();
  for (let step = 0; step < 60; step++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    const backwards = await target.evaluate((node) => !!(
      document.activeElement?.compareDocumentPosition(node)! & Node.DOCUMENT_POSITION_PRECEDING));
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    expect(await scope.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  throw new Error("Usage-reset control was not reachable by ordinary keyboard traversal");
}

function controls(page: Page) {
  const opener = page.getByRole("button", { name: `更多操作 ${account.name}`, exact: true });
  const editor = page.getByRole("dialog", { name: `${account.name} 的服务授权`, exact: true });
  const reason = editor.getByRole("textbox", { name: "重置原因", exact: true });
  const reset = editor.getByRole("button", { name: "重置本周期用量", exact: true });
  const review = page.getByRole("alertdialog", { name: `重置「${account.name}」的本周期用量？`, exact: true });
  return { opener, editor, reason, reset, review,
    resetCancel: review.getByRole("button", { name: "取消", exact: true }),
    sheetCancel: editor.getByRole("button", { name: "取消", exact: true }),
  };
}

async function openEditor(page: Page, c: ReturnType<typeof controls>) {
  await c.opener.click();
  const item = page.getByRole("menuitem", { name: "授权与续期", exact: true });
  await expect(item).toBeVisible();
  await page.keyboard.press("Home");
  await expect(item).toBeFocused();
  await page.keyboard.press("Enter");
  // Own the loaded public control, not the replaced loading-sheet element.
  await expect(c.reason).toHaveValue("");
  await settledTask(c.editor);
}

async function editReason(page: Page, c: ReturnType<typeof controls>) {
  await tabTo(page, c.editor, c.reason);
  await page.keyboard.type("  Synthetic audit reason");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Keep exact spacing  ");
  await expect(c.reason).toHaveValue(draftText);
  await expect(c.review).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "确认授权变更", exact: true })).toHaveCount(0);
}

async function enterUsersFromServices(page: Page, width: number) {
  // Create a real in-app history entry; never inject history state or events.
  await page.goto("/#services");
  await expect(page.getByRole("heading", { name: "服务方案", level: 1, exact: true })).toBeVisible();
  if (width === 390) await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("navigation", { name: "工作空间导航", exact: true })
    .getByRole("button", { name: "用户", exact: true }).click();
  await expect(page.getByRole("heading", { name: "用户", level: 1, exact: true })).toBeVisible();
}

async function expectDeparted(page: Page) {
  await expect(page.getByRole("heading", { name: "服务方案", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("#services");
}

async function expectForwardClean(page: Page) {
  await page.goForward();
  await expect(page.getByRole("heading", { name: "用户", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { includeHidden: true })).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("#users");
}

async function capture(page: Page, info: TestInfo, stage: Stage, surface: Locator,
  target?: Locator, expectedRaw?: string, settle = true) {
  const failures: unknown[] = [];
  let settlingFailed = false;
  try { if (settle) await settledTask(surface); }
  catch (error) { settlingFailed = true; failures.push(error); }
  // Original current-viewport pixels before geometry assertions. No script
  // focus, forced scrolling, motion override, DOM rewrite or overlay removal.
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`${stage}.png`), fullPage: false, mask: [
      page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]'),
    ] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  let geometry: Record<string, number | boolean> | null = null;
  try {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, focusedTag: document.activeElement?.tagName || null }));
    const count = target ? await target.count() : 0;
    geometry = target && count === 1 ? await target.evaluate((node, expected) => {
      const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
        hit: hit === node || node.contains(hit),
        inputMatches: expected !== undefined && node instanceof HTMLTextAreaElement && node.value === expected };
    }, expectedRaw) : null;
    const body = JSON.stringify({ viewport, geometry, count, settleRequested: settle, settlingFailed }, null, 2);
    await writeFile(info.outputPath(`${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Usage-reset original capture or geometry failed");
  return geometry;
}

async function finish(page: Page, info: TestInfo, width: number, scenario: string,
  http: HTTPFixture, failures: unknown[]) {
  const { ledger } = http;
  try { await http.dispose(); }
  catch (error) { failures.push(error); }
  try { await capture(page, info, "final-original", page.locator("body"), undefined, undefined, false); }
  catch (error) { failures.push(error); }
  // Attempt sanitized evidence even when a behavioral or screenshot step fails.
  try {
    const body = JSON.stringify({ width, scenario, ...ledger,
      scope: "Synthetic App reason ownership; forbidden writes except one exact locally fulfilled reset in held-success cases. No real reset, backend persistence, WebSocket, publication or full accessibility acceptance" }, null, 2);
    await writeFile(info.outputPath("request-ledger.json"), body);
    await info.attach("usage-reset-request-ledger", { body, contentType: "application/json" });
    expect(ledger.rejected).toEqual([]);
    const expectedResets = ledger.writeMode === "held-reset" ? 1 : 0;
    expect(ledger.apiWriteAttempts).toBe(expectedResets);
    expect(ledger.resetWriteAttempts).toBe(expectedResets);
    expect(ledger.authorizedResets).toBe(expectedResets);
    expect(ledger.resetSettlements).toBe(expectedResets);
    expect(ledger.resetPayloadChecks).toEqual(expectedResets ? [true] : []);
    expect(ledger.responseReleased).toBe(expectedResets === 1);
    expect(ledger.abortedHeldResets).toBe(0);
    expect(ledger.policyWriteAttempts).toBe(0);
    expect(ledger.pageErrors).toBe(0);
    expect(ledger.contextReads).toBeGreaterThanOrEqual(2);
    expect(ledger.admissionReads).toBeGreaterThanOrEqual(1);
    expect(ledger.reopenedClean).toBe(true);
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Usage-reset task or evidence failed");
}

for (const width of [390, 1440]) {
  for (const dismissal of ["cancel", "escape"] as const) {
    test(`usage reset reason survives ${dismissal} before explicit discard at ${width}px`, async ({ page, baseURL }, info) => {
      await page.setViewportSize({ width, height: 560 });
      const http = await fixture(page, baseURL), { ledger } = http, c = controls(page), failures: unknown[] = [];
      const discard = page.getByRole("alertdialog", { name: "放弃重置原因？", exact: true });
      const continueEditing = discard.getByRole("button", { name: "继续编辑", exact: true });
      const dismiss = async () => {
        await tabTo(page, c.editor, dismissal === "cancel" ? c.sheetCancel : c.reason);
        await page.keyboard.press(dismissal === "cancel" ? "Enter" : "Escape");
        await expect(discard).toBeVisible();
        ledger.discardReviews++;
      };
      try {
        await page.goto("/#users");
        await openEditor(page, c);
        await editReason(page, c);
        expect(await capture(page, info, "reason-draft", c.editor, c.reason, draftText))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true });
        await tabTo(page, c.editor, c.reset);
        await page.keyboard.press("Enter");
        await expect(c.review).toBeVisible();
        ledger.resetReviews++;
        await expect(c.review.getByText("本周期已用额度会清零，历史与自动重置日期保留。", { exact: true })).toBeVisible();
        expect(await capture(page, info, "reset-review", c.review, c.resetCancel))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        await page.keyboard.press("Enter");
        await expect(c.review).toHaveCount(0);
        ledger.resetCancels++;
        await expect(c.reason).toHaveValue(draftText);
        expect(await capture(page, info, "reset-canceled", c.editor, c.reset))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        await dismiss();
        await expect(discard.getByText("重置原因尚未提交。放弃后将无法恢复。", { exact: true })).toBeVisible();
        expect(await capture(page, info, "discard-review", discard, continueEditing))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        await page.keyboard.press("Enter");
        await expect(discard).toHaveCount(0);
        await expect(c.reason).toHaveValue(draftText);
        expect(await capture(page, info, "draft-continued", c.editor,
          dismissal === "cancel" ? c.sheetCancel : c.reason, dismissal === "escape" ? draftText : undefined))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        ledger.continuedDraft = true;
        await dismiss();
        await tabTo(page, discard, discard.getByRole("button", { name: "放弃修改", exact: true }));
        await page.keyboard.press("Enter");
        await expect(c.editor).toHaveCount(0);
        await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0);
        await expect(c.opener).toBeFocused();
        await openEditor(page, c);
        await tabTo(page, c.editor, c.reason);
        expect(await capture(page, info, "reopened-clean", c.editor, c.reason, ""))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true });
        await expect(c.reset).toBeDisabled();
        ledger.reopenedClean = true;
        await page.keyboard.press("Escape");
        await expect(c.editor).toHaveCount(0);
        await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0);
        await expect(c.opener).toBeFocused();
        expect(ledger.resetReviews).toBe(1);
        expect(ledger.resetCancels).toBe(1);
        expect(ledger.discardReviews).toBe(2);
        expect(ledger.continuedDraft).toBe(true);
      } catch (error) { failures.push(error); }
      finally { await finish(page, info, width, dismissal, http, failures); }
    });
  }

  test(`usage reset review survives Back cancel and retires on departure at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 560 });
    const http = await fixture(page, baseURL), { ledger } = http, c = controls(page), failures: unknown[] = [];
    const leave = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    const stay = leave.getByRole("button", { name: "继续编辑", exact: true });
    try {
      await enterUsersFromServices(page, width);
      await openEditor(page, c);
      await editReason(page, c);
      expect(await capture(page, info, "reason-draft", c.editor, c.reason, draftText))
        .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true });
      await tabTo(page, c.editor, c.reset);
      await page.keyboard.press("Enter");
      await expect(c.review).toBeVisible();
      ledger.resetReviews++;
      expect(await capture(page, info, "reset-review", c.review, c.resetCancel))
        .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await page.goBack();
      await expect(leave).toBeVisible();
      ledger.navigationReviews++;
      expect(await capture(page, info, "navigation-review", leave, stay))
        .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await page.keyboard.press("Enter");
      await expect(leave).toHaveCount(0);
      await expect(c.review).toBeVisible();
      expect(new URL(page.url()).hash).toBe("#users");
      expect(await capture(page, info, "navigation-stayed", c.review, c.resetCancel))
        .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      // The underlying input is deliberately inert under this surviving review.
      // Read its exact value without focusing or removing the current overlay.
      await expect(page.getByRole("textbox", { name: "重置原因", exact: true, includeHidden: true })).toHaveValue(draftText);
      ledger.stayedWithLiveReview = true;
      await page.goBack();
      await expect(leave).toBeVisible();
      ledger.navigationReviews++;
      await tabTo(page, leave, leave.getByRole("button", { name: "放弃修改并离开", exact: true }));
      await page.keyboard.press("Enter");
      await expectDeparted(page);
      await capture(page, info, "navigation-left", page.getByRole("main"));
      ledger.departedWithReviewRetired = true;
      await expectForwardClean(page);
      await capture(page, info, "forward-clean", page.getByRole("main"));
      ledger.forwardWithoutResurrection = true;
      await openEditor(page, c);
      await tabTo(page, c.editor, c.reason);
      expect(await capture(page, info, "reopened-clean", c.editor, c.reason, ""))
        .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true });
      await expect(c.reset).toBeDisabled();
      ledger.reopenedClean = true;
      await page.keyboard.press("Escape");
      await expect(c.editor).toHaveCount(0);
      await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0);
      await expect(c.opener).toBeFocused();
      expect(ledger.resetReviews).toBe(1);
      expect(ledger.resetCancels).toBe(0);
      expect(ledger.navigationReviews).toBe(2);
      expect(ledger.stayedWithLiveReview).toBe(true);
      expect(ledger.departedWithReviewRetired).toBe(true);
      expect(ledger.forwardWithoutResurrection).toBe(true);
    } catch (error) { failures.push(error); }
    finally { await finish(page, info, width, "navigation-retirement", http, failures); }
  });

  for (const outcome of ["stay", "leave"] as const) {
    test(`usage reset success behind navigation ${outcome} respects native focus at ${width}px`, async ({ page, baseURL }, info) => {
      await page.setViewportSize({ width, height: 560 });
      const http = await fixture(page, baseURL, "held-reset"), { ledger } = http, c = controls(page), failures: unknown[] = [];
      const leave = page.getByRole("alertdialog", { name: "离开当前页面？", exact: true });
      const stay = leave.getByRole("button", { name: "留在当前页面", exact: true });
      const hiddenReason = page.getByRole("textbox", { name: "重置原因", exact: true, includeHidden: true });
      let observation: JSHandle<{ count(): number; dispose(): void }> | undefined;
      try {
        await enterUsersFromServices(page, width);
        await openEditor(page, c);
        await editReason(page, c);
        await tabTo(page, c.editor, c.reset);
        await page.keyboard.press("Enter");
        await expect(c.review).toBeVisible();
        ledger.resetReviews++;
        await tabTo(page, c.review, c.review.getByRole("button", { name: "确认重置", exact: true }));
        http.authorizeReset();
        await page.keyboard.press("Enter");
        await expect.poll(() => ledger.authorizedResets).toBe(1);
        await expect(c.review).toHaveAttribute("aria-busy", "true");
        await expect(hiddenReason).toBeDisabled();
        await expect(page.getByRole("button", { name: "预览影响", exact: true, includeHidden: true })).toHaveAttribute("aria-disabled", "true");
        // Pending spinner is intentionally running: capture it without claiming
        // a settled surface or weakening the shared motion guard.
        await capture(page, info, "pending-reset", c.review, undefined, undefined, false);
        expect(ledger.resetSettlements).toBe(0);
        await page.goBack();
        await expect(leave).toBeVisible();
        ledger.navigationReviews++;
        await expect(leave.getByText("用量重置正在提交。离开不会取消已提交的重置；请返回后核对结果。", { exact: true })).toBeVisible();
        expect(await capture(page, info, "navigation-review", leave, stay))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        // Observe actual focus events, including a transient focus before route
        // unmount. This read-only observer never focuses, scrolls or edits DOM.
        observation = await hiddenReason.evaluateHandle(node => {
          let count = 0;
          const record = () => { count++; };
          node.addEventListener("focus", record);
          return { count: () => count, dispose: () => node.removeEventListener("focus", record) };
        });
        // The only approved response is released after the real navigation
        // review visibly owns focus, not after an arbitrary delay.
        await http.releaseReset();
        await expect(page.getByRole("alertdialog", { name: `重置「${account.name}」的本周期用量？`, exact: true, includeHidden: true })).toHaveCount(0);
        await expect(hiddenReason).toHaveValue("");
        await expect(hiddenReason).toBeEnabled();
        await expect(leave).toBeVisible();
        expect(await capture(page, info, "navigation-after-reset", leave, stay))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        ledger.reasonFocusBeforeDecision = await observation.evaluate(value => value.count());
        expect(ledger.reasonFocusBeforeDecision).toBe(0);
        ledger.successWithNavigationFocus = true;
        if (outcome === "stay") {
          await page.keyboard.press("Enter");
          await expect(leave).toHaveCount(0);
          await expect(c.reason).toBeFocused();
          expect(await capture(page, info, "success-stayed", c.editor, c.reason, ""))
            .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true });
          ledger.reasonFocusAfterDecision = await observation.evaluate(value => value.count());
          expect(ledger.reasonFocusAfterDecision).toBeGreaterThan(0);
          expect(new URL(page.url()).hash).toBe("#users");
          await expect(c.reset).toBeDisabled();
          await page.keyboard.press("Escape");
          await expect(c.editor).toHaveCount(0);
          await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0);
          await expect(c.opener).toBeFocused();
        } else {
          await tabTo(page, leave, leave.getByRole("button", { name: "仍然离开", exact: true }));
          await page.keyboard.press("Enter");
          await expectDeparted(page);
          await capture(page, info, "success-left", page.getByRole("main"));
          ledger.reasonFocusAfterDecision = await observation.evaluate(value => value.count());
          expect(ledger.reasonFocusAfterDecision, "Confirmed departure must not briefly focus its retiring reason input").toBe(0);
          ledger.departedWithReviewRetired = true;
          await expectForwardClean(page);
          await capture(page, info, "forward-clean", page.getByRole("main"));
          ledger.forwardWithoutResurrection = true;
        }
        // Stop observing the old owner before opening a distinct clean task.
        await observation.evaluate(value => value.dispose());
        await observation.dispose();
        observation = undefined;
        await openEditor(page, c);
        await tabTo(page, c.editor, c.reason);
        expect(await capture(page, info, "reopened-clean", c.editor, c.reason, ""))
          .toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, inputMatches: true });
        await expect(c.reset).toBeDisabled();
        ledger.reopenedClean = true;
        await page.keyboard.press("Escape");
        await expect(c.editor).toHaveCount(0);
        await expect(page.getByRole("alertdialog", { includeHidden: true })).toHaveCount(0);
        await expect(c.opener).toBeFocused();
        expect(ledger.navigationReviews).toBe(1);
        expect(ledger.successWithNavigationFocus).toBe(true);
      } catch (error) { failures.push(error); }
      finally {
        try {
          if (observation) {
            await observation.evaluate(value => value.dispose());
            await observation.dispose();
          }
        } catch (error) { failures.push(error); }
        await finish(page, info, width, `held-success-${outcome}`, http, failures);
      }
    });
  }
}
