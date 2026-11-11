import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App + exact synthetic loopback GETs. Every API write, including preview,
// is blocked rather than forwarded. HTTP routing does not cover WebSockets.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

const group = { id: "synthetic-priority-group", name: "合成优先级用户组", serviceId: "synthetic-plan", priority: 1, memberIds: [] };
const contextPath = "/api/access-policy/edit-context/group/synthetic-priority-group";
const scenarios = [
  { name: "minus", raw: "-", dismiss: "cancel" },
  { name: "exponent", raw: "1e", dismiss: "escape" },
] as const;

async function fixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic group-priority continuity requires loopback");
  const origin = new URL(baseURL).origin;
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-admin", name: "合成管理员", role: "admin" }, csrfToken: "synthetic-priority-only" },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/services": [{ id: "synthetic-plan", name: "合成服务方案", quotaBytes: 0, routeIds: [],
      onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
      cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "UTC+8" } }],
    "/api/published-routes": [], "/api/user-groups": [group], "/api/invites": [], "/api/me/notifications": [],
    [contextPath]: { target: { kind: "group", id: group.id }, record: { group },
      precondition: { exists: true, revision: "synthetic-priority-opened" },
      references: { users: [], services: [{ id: "synthetic-plan", name: "合成服务方案" }] } },
  };
  const ledger = { contextReads: 0, previewCommands: 0, previewRequests: 0, apiWriteAttempts: 0,
    discardDecisions: 0, continuedDraft: false, reopenedClean: false, pageErrors: 0, rejected: [] as string[] };
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (reason: string) => {
      // Fixed categories/counters only, never request URLs, bodies, headers,
      // cookies, query values, credentials or arbitrary page error messages.
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
      if (method === "POST" && url.pathname === "/api/access-policy/preview") ledger.previewRequests++;
      return reject("API mutation attempt");
    }
    if (url.search) return reject("API query metadata");
    if (!Object.hasOwn(reads, url.pathname)) return reject("unexpected API read");
    if (url.pathname === contextPath) ledger.contextReads++;
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
  throw new Error("Group-priority task control was not reachable by ordinary keyboard traversal");
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
    const pixels = await page.screenshot({ path: info.outputPath(`${stage}.png`), fullPage: false, mask: [
      page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]'),
    ] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  let geometry: Record<string, number | boolean | null> | null = null;
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
        invalid: node.getAttribute("aria-invalid") === "true",
        nativeValid: node instanceof HTMLInputElement ? node.validity.valid : null,
        inputMatches: expected !== undefined && node instanceof HTMLInputElement ? node.value === expected : null };
    }, expectedRaw) : null;
    const body = JSON.stringify({ viewport, geometry, count, settlingFailed }, null, 2);
    await writeFile(info.outputPath(`${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Group-priority original capture or geometry failed");
  return geometry;
}

for (const width of [390, 1440]) for (const scenario of scenarios) {
  test(`group priority ${scenario.name} draft survives ${scenario.dismiss} at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 560 });
    const ledger = await fixture(page, baseURL), failures: unknown[] = [];
    const opener = page.getByRole("button", { name: `编辑 ${group.name}`, exact: true });
    const editor = page.getByRole("dialog", { name: `编辑 ${group.name}`, exact: true });
    const priority = editor.getByRole("spinbutton", { name: "用户组优先级", exact: true });
    const cancel = editor.getByRole("button", { name: "取消", exact: true });
    const decision = page.getByRole("alertdialog", { name: "放弃尚未保存的授权修改？", exact: true });
    const continueEditing = decision.getByRole("button", { name: "继续编辑", exact: true });
    const dismiss = async () => {
      if (scenario.dismiss === "cancel") {
        await tabTo(page, editor, cancel); await page.keyboard.press("Enter");
      } else {
        await tabTo(page, editor, priority); await page.keyboard.press("Escape");
      }
      await expect(decision).toBeVisible();
      ledger.discardDecisions++;
    };
    try {
      await page.goto("/#users");
      await opener.click();
      await settledTask(editor);
      await expect(priority).toHaveValue("1");
      await tabTo(page, editor, priority);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(scenario.raw);
      const edited = await capture(page, info, "raw-input", editor, priority, scenario.raw);
      expect(edited).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true, invalid: true, inputMatches: true });
      await dismiss();
      const discard = await capture(page, info, "discard-decision", decision, continueEditing);
      expect(discard).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await page.keyboard.press("Enter");
      await expect(decision).toHaveCount(0);
      const restored = await capture(page, info, "continued-draft", editor, scenario.dismiss === "cancel" ? cancel : priority,
        scenario.dismiss === "escape" ? scenario.raw : undefined);
      expect(restored).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await expect(priority).toHaveValue(scenario.raw);
      ledger.continuedDraft = true;
      const preview = editor.getByRole("button", { name: "预览影响", exact: true });
      await tabTo(page, editor, preview);
      ledger.previewCommands++;
      await page.keyboard.press("Enter");
      const blocked = await capture(page, info, "blocked-preview", editor, priority, scenario.raw);
      expect(blocked).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true,
        invalid: true, nativeValid: false, inputMatches: true });
      await expect(page.getByRole("dialog", { name: "确认授权变更", exact: true })).toHaveCount(0);
      expect(ledger.previewRequests).toBe(0);
      await dismiss();
      await tabTo(page, decision, decision.getByRole("button", { name: "放弃修改", exact: true }));
      await page.keyboard.press("Enter");
      await expect(editor).toHaveCount(0);
      await expect(opener).toBeFocused();
      await page.keyboard.press("Enter");
      await settledTask(editor);
      await expect(priority).toHaveValue("1");
      ledger.reopenedClean = true;
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await expect(decision).toHaveCount(0);
      await expect(opener).toBeFocused();
      expect(ledger.contextReads).toBeGreaterThanOrEqual(2);
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), undefined, undefined, false); }
      catch (error) { failures.push(error); }
      // Ledger is attempted independently even if original capture fails.
      try {
        const body = JSON.stringify({ width, scenario: scenario.name, ...ledger,
          scope: "Synthetic App GET-only keyboard draft continuity; no backend writes, publication, WebSocket or full accessibility acceptance" }, null, 2);
        await writeFile(info.outputPath("request-ledger.json"), body);
        await info.attach("group-priority-request-ledger", { body, contentType: "application/json" });
        expect(ledger.rejected).toEqual([]);
        expect(ledger.apiWriteAttempts).toBe(0);
        expect(ledger.pageErrors).toBe(0);
        expect(ledger.previewCommands).toBe(1);
        expect(ledger.discardDecisions).toBe(2);
        expect(ledger.continuedDraft).toBe(true);
        expect(ledger.reopenedClean).toBe(true);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Group-priority continuity task or evidence failed");
  });
}
