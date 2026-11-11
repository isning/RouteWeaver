import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Exact synthetic loopback HTTP; every mutation and unexpected read is blocked.
// Public browser reconnect triggers the actual App query lifecycle.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

async function fixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic Users recovery requires loopback");
  const origin = new URL(baseURL).origin;
  const users = Array.from({ length: 25 }, (_, index) => ({
    id: `synthetic-user-${index}`, name: `合成用户 ${String(index).padStart(2, "0")}`,
    enabled: true, quotaBytes: 0, usedBytes: 0,
  }));
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-admin", name: "合成管理员", role: "admin" }, csrfToken: "synthetic-users-only" },
    "/api/state": { users, nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/published-routes": [], "/api/user-groups": [], "/api/me/notifications": [],
    "/api/users/synthetic-user-10/entries": [],
    "/api/users/synthetic-user-10/effective-policy": { userId: "synthetic-user-10", routeIds: [], status: "active" },
  };
  const ledger = { initialReads: 0, failedReads: 0, retryReads: 0, entryReads: 0,
    rejected: [] as string[], pageErrors: 0 };
  let phase: "initial" | "failure" | "retry" = "initial";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (category: string) => { ledger.rejected.push(category); return route.abort("blockedbyclient"); };
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
    if (method !== "GET" || url.search) return reject("mutation or API query metadata");
    if (url.pathname === "/api/services") {
      if (phase === "failure") { ledger.failedReads++; return route.fulfill({ status: 503, json: { error: "合成用户清单核对失败" } }); }
      if (phase === "retry") { ledger.retryReads++; await gate; }
      else { ledger.initialReads++; }
      return route.fulfill({ json: [] });
    }
    if (Object.hasOwn(reads, url.pathname)) {
      if (url.pathname.endsWith("/entries")) ledger.entryReads++;
      return route.fulfill({ json: reads[url.pathname] });
    }
    return reject("unexpected API read");
  });
  return { ledger,
    async failOnReconnect() {
      // Called only after ready inventory and its row menu are observed.
      // This anchor is later than the whole inventory query success, not merely
      // the services request start.
      const observedReadyAt = Date.now();
      // App staleTime is 15 seconds. Real elapsed-time polling preserves normal
      // motion/timers; this is a freshness precondition, not an interaction sleep.
      await expect.poll(() => Date.now() - observedReadyAt > 15000,
        { timeout: 17000, intervals: [250] }).toBe(true);
      phase = "failure";
      await page.context().setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
      await page.context().setOffline(false);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
    },
    armRetry() { phase = "retry"; }, releaseRetry: release,
  };
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const key = await target.evaluate((node) => {
    const active = document.activeElement;
    return active && active !== document.body &&
      active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? "Shift+Tab" : "Tab";
  });
  for (let index = 0; index < 80; index++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error("Users control was not reachable by ordinary keyboard traversal");
}

async function capture(page: Page, info: TestInfo, stage: string, surface: Locator,
  targets: { label: string; locator: Locator }[], settle = true) {
  const failures: unknown[] = [];
  let settlingFailed = false;
  try { if (settle) await settledTask(surface); }
  catch (error) { settlingFailed = true; failures.push(error); }
  // Preserve the original viewport before geometry/assertions. No script focus,
  // scrolling, animation changes, overlay dismissal or reconstructed pixels.
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`users-inventory-${stage}.png`), fullPage: false, mask: [
      page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]'),
    ] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  const geometry: { label: string; count: number; bounds: null | {
    x: number; y: number; width: number; height: number; inViewport: boolean;
    focused: boolean; focusVisible: boolean; hit: boolean;
  } }[] = [];
  try {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, focusedTag: document.activeElement?.tagName || null }));
    for (const target of targets) {
      const count = await target.locator.count();
      geometry.push({ label: target.label, count, bounds: count === 1 ? await target.locator.evaluate((node) => {
        const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { x: r.x, y: r.y, width: r.width, height: r.height,
          inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
          hit: hit === node || node.contains(hit) };
      }) : null });
    }
    const body = JSON.stringify({ viewport, geometry, settlingFailed }, null, 2);
    await writeFile(info.outputPath(`users-inventory-${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Users original capture or geometry failed");
  return geometry;
}


for (const width of [390, 1440]) {
  test(`Users cached-list continuity at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 });
    const http = await fixture(page, baseURL);
    const failures: unknown[] = [];
    try {
      await page.goto("/#users");
      const search = page.getByRole("textbox", { name: "搜索用户", exact: true });
      await tabTo(page, search); await page.keyboard.type("合成用户");
      const next = page.getByRole("button", { name: "下一页", exact: true });
      await tabTo(page, next); await page.keyboard.press("Enter");
      const row = page.getByRole("button", { name: "合成用户 10", exact: true });
      const menu = page.getByRole("button", { name: "更多操作 合成用户 10", exact: true });
      await expect(row).toBeVisible();
      await tabTo(page, menu); await page.keyboard.press("Enter");
      const edit = page.getByRole("menuitem", { name: "编辑用户", exact: true });
      await expect(edit).toBeVisible();
      await http.failOnReconnect();
      await expect(page.getByText("暂时无法核对用户", { exact: true })).toBeVisible();
      await expect(edit).toBeDisabled();
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await capture(page, info, "cached-error-open-menu", page.locator("body"), [
        { label: "disabled-edit", locator: edit },
      ]);
      await page.keyboard.press("Escape");
      await expect(search).toHaveValue("合成用户");
      await expect(row).toBeDisabled();
      await expect(page.getByRole("button", { name: "合成用户 00", exact: true })).toHaveCount(0);
      const actions = page.getByRole("group", { name: "合成用户 10 的操作", exact: true });
      const entry = actions.getByRole("button", { name: "平台入口", exact: true });
      await expect(entry).toBeDisabled(); expect(http.ledger.entryReads).toBe(0);
      const retry = page.getByRole("button", { name: "重试用户列表", exact: true });
      await tabTo(page, retry);
      const geometry = await capture(page, info, "retry-keyboard", page.locator("body"), [{ label: "retry", locator: retry }]);
      expect(geometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      http.armRetry(); await page.keyboard.press("Enter");
      await expect(page.getByText("正在核对用户…", { exact: true })).toBeVisible();
      await expect(row).toBeDisabled(); await expect(entry).toBeDisabled();
      // This deliberately held read owns a visible infinite spinner: capture
      // the pending phase as-is, not as a settled task. Recovery stays strict.
      const pendingGeometry = await capture(page, info, "retry-pending", page.locator("body"), [{ label: "retry", locator: retry }], false);
      expect(pendingGeometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await expect(retry).toBeFocused();
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      await expect(retry).toHaveAttribute("aria-busy", "true");
      expect(await retry.evaluate(node => (node as HTMLButtonElement).disabled)).toBe(false);
      await expect.poll(() => http.ledger.retryReads).toBe(1);
      // Ordinary keyboard activation must not cancel/restart the held GET.
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      await expect(retry).toBeFocused();
      expect(http.ledger.retryReads).toBe(1);
      http.releaseRetry();
      await expect(entry).toBeEnabled(); await expect(search).toHaveValue("合成用户");
      // Capture the actual success handoff before Tab or other focus-changing input.
      const searchGeometry = await capture(page, info, "recovered-search-keyboard", page.locator("body"), [{ label: "search", locator: search }]);
      await expect(search).toBeFocused();
      expect(searchGeometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await expect(retry).toHaveCount(0);
      await expect(row).toBeVisible();
      await tabTo(page, entry);
      const entryGeometry = await capture(page, info, "recovered-entry-keyboard", page.locator("body"), [{ label: "correct-entry", locator: entry }]);
      expect(entryGeometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "合成用户 10 的平台入口", exact: true });
      await expect(dialog).toBeVisible(); await expect.poll(() => http.ledger.entryReads).toBe(1);
      await capture(page, info, "correct-user-entry", dialog, []);
      // Real App defaults retry one failed read before exposing recovery.
      expect(http.ledger.failedReads).toBeGreaterThanOrEqual(2);
      expect(http.ledger.retryReads).toBe(1);
    } catch (error) { failures.push(error); }
    finally {
      http.releaseRetry();
      try { await capture(page, info, "final-original", page.locator("body"), [], false); }
      catch (error) { failures.push(error); }
      try {
        const body = JSON.stringify({ width, ...http.ledger,
          scope: "Synthetic Users HTTP recovery; no backend mutations, selected-close race, WebSocket or comprehensive accessibility proof" }, null, 2);
        await writeFile(info.outputPath("users-inventory-request-ledger.json"), body);
        await info.attach("users-recovery-ledger", { body, contentType: "application/json" });
        expect(http.ledger.rejected).toEqual([]); expect(http.ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Users recovery task or evidence failed");
  });
}
