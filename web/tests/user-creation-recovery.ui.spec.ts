import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";
import { navigateWorkspace } from "./ui-session";

// Real App, session and navigation; every creation command is intercepted locally.
// This exercises the UI/HTTP intent seam, not Go atomicity or real persistence.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const name = "Synthetic receipt recovery user";
const submitted = { name, enabled: true, quotaBytes: 107374182400, usedBytes: 0 };
const uncertainCopy = "已保留本次提交，确认结果前暂不能修改。请检查创建结果；关闭不会撤销可能已完成的创建。";
const absentCopy = "之前的请求仍可能完成。重试只会继续本次创建，不会覆盖已有用户。";
const closeCopy = "用户可能已经创建，关闭不会撤销创建。再次添加会开始新的创建。";
type RecordValue = typeof submitted & { id: string };

async function fixture(page: Page, baseURL: string | undefined, scenario: "ownership" | "retry") {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic creation sampler requires loopback");
  const origin = new URL(baseURL).origin;
  let first: RecordValue | undefined, stored: RecordValue | undefined;
  const releases: (() => void)[] = [];
  let held: { ready: (error?: Error) => void; release: Promise<void>; expectedClick: number; captureRequest: (request: Request) => void } | undefined;
  const ledger = { postAttempts: 0, acceptedCommands: 0, stateReads: 0, authReads: 0,
    heldReads: 0, deliveredHeldReads: 0, stateReadsInFlight: 0, stateReadTiming: [] as { read: number; explicitClicks: number; held: boolean; requestStart: number | null; activationStart: number | null }[], commandIDsMatch: true, commandBodiesMatch: true,
    guardedHeadersMatch: true, rejected: [] as string[], pageErrors: 0 };
  const state = () => ({ users: stored ? [stored] : [], nodes: [], routes: [], revisions: [], capabilities: [] });
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-create-admin", name: "Synthetic admin", role: "admin" }, csrfToken: "synthetic-create-only" },
    "/api/services": [], "/api/published-routes": [], "/api/rates": [], "/api/user-groups": [], "/api/settings": {},
  };
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (reason: string) => { ledger.rejected.push(reason); return route.abort("blockedbyclient"); };
    if (url.origin !== origin || url.username || url.password || url.hash) return reject("external or metadata-bearing request");
    if (!url.pathname.startsWith("/api/")) {
      const staticPath = ["/", "/favicon.ico", "/@vite/client", "/@react-refresh"].includes(url.pathname) ||
        /^\/(?:src|node_modules|assets)\/[^?#]+\.(?:[cm]?[jt]sx?|css|woff2?|ttf|svg)$/.test(url.pathname);
      const staticQuery = [...url.searchParams].every(([key, value]) =>
        (key === "v" && /^[a-zA-Z0-9_-]+$/.test(value)) || (key === "t" && /^\d+$/.test(value)) || (key === "import" && value === ""));
      return method === "GET" && staticPath && staticQuery ? route.continue() : reject("unexpected static request");
    }
    if (url.search) return reject("API query metadata");
    if (url.pathname === "/api/users" && method === "POST") {
      ledger.postAttempts++;
      let body: RecordValue;
      try { body = request.postDataJSON(); } catch { return reject("invalid command JSON"); }
      const headers = await request.allHeaders();
      ledger.guardedHeadersMatch &&= headers["if-none-match"] === "*" && headers["x-csrf-token"] === "synthetic-create-only" && headers["content-type"] === "application/json";
      if (!ledger.guardedHeadersMatch) return reject("unexpected command guards");
      if (!body || typeof body.id !== "string" || !/^user_[a-f0-9]{16}$/.test(body.id) ||
          !isDeepStrictEqual(body, { id: body.id, ...submitted })) return reject("unexpected synthetic creation intent");
      if (!first) {
        first = body;
        if (scenario === "ownership") stored = { ...body, usedBytes: 7 };
        ledger.acceptedCommands++;
        return route.abort("failed"); // Synthetic server outcome may exist, receipt is lost.
      }
      ledger.commandIDsMatch &&= body.id === first.id;
      ledger.commandBodiesMatch &&= isDeepStrictEqual(body, first);
      if (scenario !== "retry" || ledger.postAttempts !== 2 || !ledger.commandIDsMatch || !ledger.commandBodiesMatch)
        return reject("unexpected duplicate or changed creation");
      stored = body; ledger.acceptedCommands++;
      return route.fulfill({ json: stored });
    }
    if (method !== "GET") return reject("unexpected API mutation");
    if (url.pathname === "/api/state") {
      const read = ++ledger.stateReads;
      ledger.stateReadsInFlight++; // Count the handler before any asynchronous observation.
      const gate = held;
      gate?.captureRequest(request);
      try {
        const activations = await page.evaluate(() => (window as unknown as { __creationCheckTimes?: number[] }).__creationCheckTimes ?? []);
        const clicks = activations.length, activationStart = gate ? activations[gate.expectedClick - 1] ?? null : null;
        ledger.stateReadTiming.push({ read, explicitClicks: clicks, held: !!gate, requestStart: null, activationStart });
        if (gate && (clicks !== gate.expectedClick || activationStart === null)) {
          held = undefined; gate.ready(new Error("State read preceded the intended Check activation"));
          return await reject("read before expected explicit check activation");
        }
        if (gate) {
          held = undefined; ledger.heldReads++; gate.ready(); await gate.release;
          await route.fulfill({ json: state() }); ledger.deliveredHeldReads++; return;
        }
        return await route.fulfill({ json: state() });
      } finally { ledger.stateReadsInFlight--; }
    }
    if (!Object.hasOwn(reads, url.pathname)) return reject("unexpected API read");
    if (url.pathname === "/api/auth/me") ledger.authReads++;
    return route.fulfill({ json: reads[url.pathname] });
  });
  return { ledger, releaseAll: () => releases.forEach(release => release()), holdRead: (expectedClick: number) => {
    if (held) throw new Error("Read gate already armed");
    let release!: () => void, ready!: (error?: Error) => void;
    const requested = new Promise<void>((resolve, reject) => { ready = error => error ? reject(error) : resolve(); });
    const promise = new Promise<void>(resolve => { release = resolve; });
    let request: Request | undefined;
    releases.push(release);
    held = { ready, release: promise, expectedClick, captureRequest: value => { request = value; } };
    return { requested, release, expectedClick, request: () => request };
  } };
}
async function tabTo(page: Page, scope: Locator, target: Locator) {
  await expect(target).toBeVisible();
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate(node => node === document.activeElement)) return;
    const backwards = await target.evaluate(node => !!(document.activeElement?.compareDocumentPosition(node)! & Node.DOCUMENT_POSITION_PRECEDING));
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    expect(await scope.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  throw new Error("Creation action unreachable by ordinary keyboard");
}
async function capture(page: Page, info: TestInfo, stage: string, surface: Locator, action?: Locator, copy?: Locator, settle = true) {
  const errors: unknown[] = [];
  try { if (settle) await settledTask(surface); } catch (error) { errors.push(error); }
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`user-creation-${stage}.png`), fullPage: false,
      mask: [page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]')] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { errors.push(error); }
  try {
    const geometry = async (target: Locator) => target.evaluate(node => {
      const r = node.getBoundingClientRect(); let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), p = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, p.left + parent.clientLeft); right = Math.min(right, p.left + parent.clientLeft + parent.clientWidth); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, p.top + parent.clientTop); bottom = Math.min(bottom, p.top + parent.clientTop + parent.clientHeight); }
      }
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x, y: r.y, width: r.width, height: r.height, contained: r.width > 0 && r.height > 0 && r.left >= left && r.right <= right && r.top >= top && r.bottom <= bottom,
        ring3px: /(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/.test(getComputedStyle(node).boxShadow),
        ringContained: r.left - 3 >= left - 0.5 && r.right + 3 <= right + 0.5 && r.top - 3 >= top - 0.5 && r.bottom + 3 <= bottom + 0.5,
        focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"), hit: hit === node || node.contains(hit) };
    });
    const result = { action: action ? await geometry(action) : null, copy: copy ? await geometry(copy) : null,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
        theme: localStorage.getItem("routeweaver-theme"), colorScheme: getComputedStyle(document.documentElement).colorScheme })) };
    const body = JSON.stringify(result, null, 2); await writeFile(info.outputPath(`user-creation-${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(result.viewport.scrollWidth).toBeLessThanOrEqual(result.viewport.width + 1);
    if (result.action) expect(result.action).toMatchObject({ contained: true, focused: true, focusVisible: true, hit: true, ring3px: true, ringContained: true });
    if (result.copy) expect(result.copy.contained).toBe(true);
  } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Creation original evidence or geometry failed");
}

for (const journey of [{ scenario: "ownership", width: 390, theme: "light" }, { scenario: "retry", width: 1440, theme: "dark" }] as const) {
  test(`user creation ${journey.scenario} at ${journey.width}px ${journey.theme}`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: journey.width, height: journey.width === 390 ? 560 : 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(theme => localStorage.setItem("routeweaver-theme", theme), journey.theme);
    await page.addInitScript(() => {
      const state = window as unknown as { __creationCheckTimes: number[] }; state.__creationCheckTimes = [];
      document.addEventListener("click", event => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        if ((button?.getAttribute("aria-label") ?? button?.textContent?.trim()) === "检查创建结果") state.__creationCheckTimes.push(performance.timeOrigin + performance.now());
      }, true);
    });
    const http = await fixture(page, baseURL, journey.scenario), failures: unknown[] = [];
    const editor = page.getByRole("dialog", { name: "添加用户", exact: true });
    const mountedEditor = page.getByRole("dialog", { name: "添加用户", exact: true, includeHidden: true });
    const field = editor.getByRole("textbox", { name: "用户名称", exact: true });
    const check = editor.getByRole("button", { name: "检查创建结果", exact: true });
    const cancel = editor.getByRole("button", { name: "取消", exact: true });
    const activate = async (target: Locator, scope = editor) => { await tabTo(page, scope, target); await page.keyboard.press("Enter"); };
    let explicitChecks = 0, initialReads: number | undefined;
    const releaseRead = async (gate: { release: () => void; expectedClick: number; request: () => Request | undefined }, decision: Locator) => {
      const response = page.waitForResponse(r => r.request() === gate.request());
      gate.release(); const completed = await response; expect(await completed.finished()).toBeNull();
      // Playwright populates native request timing only once its response arrives.
      // Verify the exact held Request object, not another same-URL background read.
      const timing = http.ledger.stateReadTiming.find(entry => entry.held && entry.explicitClicks === gate.expectedClick)!;
      expect(timing).toBeDefined(); timing.requestStart = completed.request().timing().startTime;
      expect(timing.requestStart).toBeGreaterThan(0); expect(timing.requestStart).toBeGreaterThanOrEqual(timing.activationStart!);
      await settledTask(decision);
      await expect(decision).toBeVisible(); await expect(mountedEditor).toHaveCount(1);
      expect(http.ledger.postAttempts).toBe(1);
    };
    try {
      // Establish a real in-App predecessor before opening the task. Browser Back
      // remains reachable while a modal traps in-page focus; no trap is bypassed.
      await page.goto("/#services"); await expect(page.getByRole("heading", { name: "服务方案", exact: true })).toBeVisible();
      await navigateWorkspace(page, "用户"); await expect(page.getByRole("heading", { name: "用户", exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveClass(new RegExp(`(?:^|\\s)${journey.theme}(?:\\s|$)`));
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(journey.theme);
      initialReads = http.ledger.stateReads;
      await page.getByRole("button", { name: "添加用户", exact: true }).click(); await expect(editor).toBeVisible();
      await tabTo(page, editor, field); await page.keyboard.type(name);
      await activate(editor.getByRole("button", { name: "保存", exact: true }));
      await expect(editor.getByText("尚未确认用户是否创建", { exact: true })).toBeVisible();
      await expect(field).toBeDisabled(); await expect(field).toHaveValue(name);
      await expect(editor.getByRole("spinbutton", { name: "账号基础额度（GiB，0 为不限额）", exact: true })).toBeDisabled();
      await expect(editor.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
      expect(http.ledger.postAttempts).toBe(1); expect(http.ledger.acceptedCommands).toBe(1);
      await tabTo(page, editor, check);
      await capture(page, info, "uncertain", editor, check, editor.getByText(uncertainCopy, { exact: true }));
      if (journey.scenario === "ownership") {
        await tabTo(page, editor, check); await expect.poll(() => http.ledger.stateReadsInFlight).toBe(0);
        const firstReadBaseline = http.ledger.stateReads, first = http.holdRead(++explicitChecks);
        await page.keyboard.press("Enter"); await first.requested;
        expect(http.ledger.stateReads).toBe(firstReadBaseline + 1);
        await expect(check).toHaveAttribute("aria-busy", "true");
        await capture(page, info, "checking", editor, check, undefined, false);
        await activate(cancel);
        const closeDecision = page.getByRole("alertdialog", { name: "关闭创建窗口？", exact: true });
        const keepChecking = closeDecision.getByRole("button", { name: "继续核对", exact: true });
        await expect(closeDecision).toBeVisible(); await tabTo(page, closeDecision, keepChecking);
        await capture(page, info, "close-decision", closeDecision, keepChecking, closeDecision.getByText(closeCopy, { exact: true }));
        await releaseRead(first, closeDecision);
        await capture(page, info, "late-close-result", closeDecision, keepChecking, closeDecision.getByText(closeCopy, { exact: true }));
        await activate(keepChecking, closeDecision); await expect(closeDecision).toHaveCount(0); await expect(field).toHaveValue(name);
        await tabTo(page, editor, check); await expect.poll(() => http.ledger.stateReadsInFlight).toBe(0);
        const secondReadBaseline = http.ledger.stateReads, second = http.holdRead(++explicitChecks);
        await page.keyboard.press("Enter"); await second.requested;
        expect(http.ledger.stateReads).toBe(secondReadBaseline + 1);
        await page.goBack();
        const routeDecision = page.getByRole("alertdialog", { name: "离开当前页面？", exact: true });
        const stay = routeDecision.getByRole("button", { name: "留在当前页面", exact: true });
        await expect(routeDecision).toBeVisible(); await tabTo(page, routeDecision, stay);
        await expect(routeDecision).toContainText(closeCopy);
        await capture(page, info, "route-decision", routeDecision, stay, routeDecision.locator("[data-workspace-navigation-review]"));
        await releaseRead(second, routeDecision);
        await capture(page, info, "late-route-result", routeDecision, stay, routeDecision.locator("[data-workspace-navigation-review]"));
        await activate(stay, routeDecision); await expect(routeDecision).toHaveCount(0);
        await expect(editor).toBeVisible(); await expect(field).toHaveValue(name); await expect(field).toBeDisabled();
        await expect(page).toHaveURL(/#users$/);
        explicitChecks++; await activate(check); await expect(editor).toHaveCount(0);
        expect(http.ledger.postAttempts).toBe(1); expect(http.ledger.heldReads).toBe(2); expect(http.ledger.deliveredHeldReads).toBe(2);
      } else {
        explicitChecks++; await activate(check);
        await expect(editor.getByText("暂未找到本次创建的用户", { exact: true })).toBeVisible();
        const retry = editor.getByRole("button", { name: "重试本次创建", exact: true });
        expect(http.ledger.postAttempts).toBe(1); await expect(field).toBeDisabled();
        await tabTo(page, editor, retry);
        await capture(page, info, "absent", editor, retry, editor.getByText(absentCopy, { exact: true }));
        await activate(retry); await expect(editor).toHaveCount(0);
        expect(http.ledger.postAttempts).toBe(2); expect(http.ledger.acceptedCommands).toBe(2);
        expect(http.ledger.commandIDsMatch).toBe(true); expect(http.ledger.commandBodiesMatch).toBe(true);
      }
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(1);
      await capture(page, info, "confirmed-list", page.locator("body"));
      expect(http.ledger.guardedHeadersMatch).toBe(true);
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), undefined, undefined, false); } catch (error) { failures.push(error); }
      try {
        const body = JSON.stringify({ ...journey, explicitChecks, initialReads, ...http.ledger,
          scope: "Synthetic creation intent, read-only reconciliation and decision ownership only; no real mutation or Go atomicity evidence" }, null, 2);
        await writeFile(info.outputPath("user-creation-request-ledger.json"), body);
        await info.attach("creation-request-ledger", { body, contentType: "application/json" });
        expect(http.ledger.rejected).toEqual([]); expect(http.ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
      // Unblock any abandoned synthetic read only after preserving failure evidence.
      http.releaseAll();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Creation journey or evidence failed");
  });
}
