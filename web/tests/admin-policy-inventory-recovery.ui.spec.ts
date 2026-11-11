import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App and guarded editors; only exact synthetic HTTP GET responses.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });
type Kind = "service" | "group";
type EditRead = {
  target: { kind: Kind; id: string };
  lifecycle: "intercepted" | "finished" | "failed";
};
const labels = {
  service: { refresh: "刷新服务方案", pending: "正在刷新服务方案…", field: "服务方案名称" },
  group: { refresh: "刷新用户组", pending: "正在刷新用户组…", field: "用户组名称" },
};
async function fixture(page: Page, baseURL: string | undefined, kind: Kind) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Policy inventory recovery requires loopback");
  const origin = new URL(baseURL).origin;
  const records = Array.from({ length: 25 }, (_, index) => ({
    id: `${kind}-${index}`, name: `Record ${String(index).padStart(2, "0")}`,
    ...(kind === "service" ? { quotaBytes: 0, routeIds: [], onlineIpLimit: 0, connectionLimit: 0,
      entryRateBps: 0, cycle: { mode: "none", timezone: "UTC+8", anchor: "0001-01-01T00:00:00Z" } }
      : { serviceId: "plan", priority: 1, memberIds: [] }),
  }));
  type Phase = "initial" | "failure" | "recovered";
  let phase: Phase = "initial";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ledger = { reads: [] as { phase: Phase; outcome: string; authReads: number }[], editReads: 0, authReads: 0,
    editRequests: [] as EditRead[], rejected: [] as string[], pageErrors: 0 };
  const editRequests = new WeakMap<Request, EditRead>();
  page.on("requestfinished", request => { const entry = editRequests.get(request); if (entry) entry.lifecycle = "finished"; });
  page.on("requestfailed", request => { const entry = editRequests.get(request); if (entry) entry.lifecycle = "failed"; });
  // App shell plus the actual services/users page's companion inventories.
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-policy-admin", name: "合成管理员", role: "admin" }, csrfToken: "synthetic-policy-only" },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
    "/api/published-routes": [],
    ...(kind === "service" ? { "/api/rates": [] } : { "/api/services": [{
      id: "plan", name: "Synthetic group plan", quotaBytes: 0, routeIds: [],
      onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
      cycle: { mode: "none", timezone: "UTC+8", anchor: "0001-01-01T00:00:00Z" },
    }] }),
  };
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
    if (url.pathname === (kind === "service" ? "/api/services" : "/api/user-groups")) {
      const owned = phase, entry = { phase: owned, outcome: "pending", authReads: ledger.authReads };
      ledger.reads.push(entry);
      if (owned === "recovered") await gate;
      entry.outcome = owned === "failure" ? "synthetic-503" : "synthetic-records";
      return route.fulfill(owned === "failure" ? { status: 503, json: { detail: "Inventory unavailable" } } : { json: records });
    }
    if (url.pathname === `/api/access-policy/edit-context/${kind}/${kind}-10`) {
      ledger.editReads++;
      // Only the exact allowlisted synthetic target is recorded, never raw URLs,
      // headers, response bodies or transport error text.
      const entry: EditRead = { target: { kind, id: url.pathname.split("/").at(-1)! }, lifecycle: "intercepted" };
      ledger.editRequests.push(entry); editRequests.set(request, entry);
      return route.fulfill({ json: { target: { kind, id: `${kind}-10` },
        record: { [kind]: { ...records[10], name: "Authoritative record" } },
        precondition: { exists: true, revision: "opening-1" } } });
    }
    if (Object.hasOwn(reads, url.pathname)) {
      if (url.pathname === "/api/auth/me") ledger.authReads++;
      return route.fulfill({ json: reads[url.pathname] });
    }
    return reject("unexpected API read");
  });
  return { ledger, count: (key: Phase) => ledger.reads.filter(entry => entry.phase === key).length,
    arm: (key: Phase) => { phase = key; }, release };
}

async function focused(page: Page) {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!node) return null;
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      tag: node.tagName,
      name: node === document.body ? "body" : node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 160),
      inMain: !!node.closest("main"), inDialog: !!node.closest('[role="dialog"]'),
      focusVisible: node.matches(":focus-visible"),
      bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
      inViewport: box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      unobscured: hit === node || (!!hit && node.contains(hit)),
    };
  });
}

type Traversal = {
  stage: string; direction: "Tab" | "Shift+Tab"; authBefore: number; authAfter: number;
  reached: boolean; path: { tag: string; inWorkspace: boolean; documentFocused: boolean }[];
};
async function tabTo(page: Page, target: Locator, stage: string,
  traversals: Traversal[], authReads: () => number) {
  await expect(target).toBeVisible();
  // Choose the actual DOM direction, rather than wrapping through browser chrome
  // and causing the real session boundary to revalidate the private workspace.
  const direction = await target.evaluate(node => {
    const active = document.activeElement;
    return active && active !== document.body &&
      active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? "Shift+Tab" : "Tab";
  });
  const entry: Traversal = { stage, direction, authBefore: authReads(), authAfter: authReads(), reached: false, path: [] };
  traversals.push(entry);
  try {
    for (let tabs = 0; tabs < 80; tabs++) {
      if (await target.evaluate(node => node === document.activeElement)) { entry.reached = true; return; }
      await page.keyboard.press(direction);
      entry.path.push(await page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? "none",
        inWorkspace: !!document.activeElement?.closest("[data-session-workspace]"),
        documentFocused: document.hasFocus(),
      })));
    }
    throw new Error("Policy inventory action was not reachable by ordinary keyboard traversal");
  } finally { entry.authAfter = authReads(); }
}

async function capture(page: Page, info: TestInfo, stage: string, surface: Locator, settle = true) {
  const failures: unknown[] = [];
  try { if (settle) await settledTask(surface); } catch (error) { failures.push(error); }
  // Capture the original viewport position before subsequent Tab, focus or scrolling.
  // Privacy masks and Playwright's default hidden caret remain intentional.
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`policy-inventory-${stage}.png`), fullPage: false,
      mask: [page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"]')] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  try {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    const body = JSON.stringify({ viewport, focus: await focused(page), settlingFailed: failures.length > 0 }, null, 2);
    await writeFile(info.outputPath(`policy-inventory-${stage}.json`), body);
    await info.attach(`${stage}-focus`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Policy inventory capture failed");
}

for (const width of [1440, 390]) for (const kind of ["service", "group"] as const)
  for (const scenario of ["retry", "stale-editor"] as const) {
  test(`Policy inventory ${kind} ${scenario} at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 });
    const http = await fixture(page, baseURL, kind), label = labels[kind];
    const failures: unknown[] = [];
    const traversals: Traversal[] = [];
    const walk = (target: Locator, stage: string) => tabTo(page, target, stage, traversals, () => http.ledger.authReads);
    let authBaseline: number | undefined;
    let openingReadsAtReady: number | undefined;
    const main = page.locator("main");
    const refresh = page.getByRole("button", { name: label.refresh, exact: true });
    const search = page.getByRole("textbox", { name: "搜索服务方案", exact: true });
    const row = main.getByRole("group", { name: "Record 10 的操作", exact: true });
    const edit = row.getByRole("button", { name: kind === "service" ? "编辑" : "编辑 Record 10", exact: true });
    try {
      await page.goto(kind === "service" ? "/#services" : "/#users");
      await expect(main.getByRole("cell", { name: "Record 00", exact: true })).toBeVisible();
      if (kind === "service") await search.fill("Record");
      await main.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(main.getByRole("cell", { name: "Record 10", exact: true })).toBeVisible();
      const authBeforePreparation = http.ledger.authReads;
      await walk(refresh, "prepare-refresh"); await expect(refresh).toBeFocused();
      expect(http.ledger.authReads).toBe(authBeforePreparation);
      authBaseline = http.ledger.authReads;
      http.arm("failure");
      await page.keyboard.press("Enter");
      await expect(main.getByText("Inventory unavailable", { exact: true })).toBeVisible();
      expect(http.count("failure")).toBe(2); // Real App's one automatic retry.
      await expect(row).toBeAttached(); await expect(edit).toBeEnabled();
      if (kind === "service") await expect(search).toHaveValue("Record");
      await capture(page, info, "cached-error", main);
      await walk(refresh, "retry-refresh"); await expect(refresh).toBeFocused();
      await capture(page, info, "retry-keyboard", main);
      expect(await focused(page)).toMatchObject({ focusVisible: true, inViewport: true, unobscured: true });
      http.arm("recovered");
      await page.keyboard.press("Space");
      await expect(refresh).toHaveAttribute("aria-disabled", "true");
      await expect(main.getByText(label.pending, { exact: true })).toBeVisible();
      await expect.poll(() => http.count("recovered")).toBe(1);
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(http.count("recovered")).toBe(1);
      await expect(refresh).toBeFocused(); await expect(row).toBeAttached();
      await capture(page, info, "retry-pending", main, false);
      if (scenario === "retry") {
        http.release();
        await expect(main.getByText(label.pending, { exact: true })).toHaveCount(0);
        await expect(main.getByText("Inventory unavailable", { exact: true })).toHaveCount(0);
        await expect(refresh).toBeFocused(); await expect(refresh).not.toHaveAttribute("aria-disabled", "true");
        await expect(row).toBeAttached();
        if (kind === "service") await expect(search).toHaveValue("Record");
        await capture(page, info, "recovered", main);
        expect(await focused(page)).toMatchObject({ focusVisible: true, inViewport: true, unobscured: true });
      }
      await walk(edit, "guarded-edit"); await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "编辑 Authoritative record", exact: true });
      const field = dialog.getByRole("textbox", { name: label.field, exact: true });
      await expect(field).toHaveValue("Authoritative record");
      // Vite's real App uses StrictMode: opening effect replay may abort one
      // transport attempt. Correct authoritative ownership, not attempt count,
      // is the public contract. An empty or wrong target set must still fail.
      expect([...new Map(http.ledger.editRequests.map(entry =>
        [`${entry.target.kind}:${entry.target.id}`, entry.target])).values()])
        .toEqual([{ kind, id: `${kind}-10` }]);
      openingReadsAtReady = http.ledger.editReads;
      await capture(page, info, "guarded-editor", dialog);
      if (scenario === "stale-editor") {
        await walk(field, "newer-draft"); await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type("Synthetic newer draft");
        await capture(page, info, "newer-draft-pending", dialog);
        http.release();
        await expect(main.getByText(label.pending, { exact: true })).toHaveCount(0);
        await expect(field).toHaveValue("Synthetic newer draft"); await expect(field).toBeFocused();
        await capture(page, info, "newer-draft-owned", dialog);
      }
      // Background inventory reconciliation must not reopen the ready editor.
      expect(http.ledger.editReads).toBe(openingReadsAtReady);
      expect(http.count("recovered")).toBe(1);
      expect(http.ledger.authReads).toBe(authBaseline);
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), false); }
      catch (error) { failures.push(error); }
      finally { http.release(); }
      try {
        const body = JSON.stringify({ width, kind, scenario, authBaseline, openingReadsAtReady, traversals, ...http.ledger,
          scope: "Synthetic native cached policy inventory recovery; no writes, preview, apply or backend revision enforcement claim" }, null, 2);
        await writeFile(info.outputPath("policy-inventory-request-ledger.json"), body);
        await info.attach("policy-inventory-request-ledger", { body, contentType: "application/json" });
        expect(http.ledger.rejected).toEqual([]); expect(http.ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Policy inventory recovery or evidence failed");
  });
}
