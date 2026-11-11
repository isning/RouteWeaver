import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Synthetic native recovery sampler. No announcement writes or delivery.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });
const record = { id: "synthetic-maintenance", title: "合成维护安排", body: "合成维护正文",
  audience: "all", userIds: [], enabled: true,
  startsAt: "2026-11-10T10:00:00Z", expiresAt: "2026-11-20T11:00:00Z" };

async function fixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Announcement recovery requires loopback");
  const origin = new URL(baseURL).origin;
  type Phase = "initial" | "failure" | "recovered";
  let phase: Phase = "initial";
  const gates = new Map<Phase, { promise: Promise<void>; release: () => void }>();
  for (const key of ["initial", "failure", "recovered"] as const) {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    gates.set(key, { promise, release });
  }
  const ledger = { reads: [] as { phase: Phase; outcome: string }[], rejected: [] as string[], pageErrors: 0 };
  // App's authenticated shell and announcement recipient catalog only. No tab
  // visits require notification settings/outbox; these remain denied.
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-announcement-admin", name: "合成管理员", role: "admin" }, csrfToken: "synthetic-announcement-only" },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [] },
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
    if (url.pathname === "/api/admin/announcements") {
      const owned = phase, entry = { phase: owned, outcome: "pending" };
      ledger.reads.push(entry);
      await gates.get(owned)!.promise;
      entry.outcome = owned === "failure" ? "synthetic-503" : "synthetic-record";
      return route.fulfill(owned === "failure"
        ? { status: 503, json: { message: "合成公告读取失败" } }
        : { json: [{ ...record, ...(owned === "recovered" ? { title: "合成更新安排", body: "合成更新正文" } : {}) }] });
    }
    if (Object.hasOwn(reads, url.pathname)) return route.fulfill({ json: reads[url.pathname] });
    return reject("unexpected API read");
  });
  return { ledger,
    count: (key: Phase) => ledger.reads.filter(entry => entry.phase === key).length,
    arm: (key: Phase) => { phase = key; },
    release: (key: Phase) => { gates.get(key)!.release(); },
    releaseAll: () => { for (const gate of gates.values()) gate.release(); },
  };
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

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const path = [];
  for (let tabs = 0; tabs < 80; tabs++) {
    if (await target.evaluate(node => node === document.activeElement)) return { tabs, path };
    await page.keyboard.press("Tab");
    path.push(await focused(page));
  }
  throw new Error("Announcement action was not reachable by ordinary keyboard traversal");
}

async function capture(page: Page, info: TestInfo, stage: string, surface: Locator, settle = true) {
  const failures: unknown[] = [];
  try { if (settle) await settledTask(surface); } catch (error) { failures.push(error); }
  // Capture the original viewport position before subsequent Tab, focus or scrolling.
  // Privacy masks and Playwright's default hidden caret remain intentional.
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`announcement-${stage}.png`), fullPage: false,
      mask: [page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"]')] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  try {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    const body = JSON.stringify({ viewport, focus: await focused(page), settlingFailed: failures.length > 0 }, null, 2);
    await writeFile(info.outputPath(`announcement-${stage}.json`), body);
    await info.attach(`${stage}-focus`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Announcement capture failed");
}

for (const width of [1440, 390]) for (const scenario of ["retry", "newer-create"] as const) {
  test(`Announcement ${scenario} recovery at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 560 : 900 });
    const http = await fixture(page, baseURL);
    const failures: unknown[] = [];
    const main = page.locator("main");
    const refresh = page.getByRole("button", { name: "刷新公告", exact: true });
    try {
      await page.goto("/#notifications");
      await expect(main.getByRole("status", { name: "正在加载", exact: true })).toHaveAttribute("aria-busy", "true");
      await expect(main.getByText("暂无公告", { exact: true })).toHaveCount(0);
      await capture(page, info, "initial-unknown", main, false);
      http.release("initial");
      await expect(main.getByRole("cell", { name: record.title, exact: true })).toBeVisible();
      await expect(main.getByRole("columnheader", { name: "开始时间（北京时间）", exact: true })).toBeAttached();
      await expect(main.getByRole("columnheader", { name: "结束时间（北京时间）", exact: true })).toBeAttached();
      await expect(main.getByRole("cell", { name: "2026/11/10 18:00", exact: true })).toBeAttached();
      await expect(main.getByRole("cell", { name: "2026/11/20 19:00", exact: true })).toBeAttached();
      http.arm("failure");
      await tabTo(page, refresh); await page.keyboard.press("Enter");
      await expect(refresh).toHaveAttribute("aria-busy", "true");
      await expect(main.getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
      await capture(page, info, "refresh-pending", main, false);
      if (scenario === "retry") {
        http.release("failure");
        await expect(main.getByText("合成公告读取失败", { exact: true })).toBeVisible();
        expect(http.count("failure")).toBe(2); // Production's one automatic retry.
        await expect(main.getByRole("cell", { name: record.title, exact: true })).toBeVisible();
        await expect(main.getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
        await expect(main.getByText("暂无公告", { exact: true })).toHaveCount(0);
        await capture(page, info, "cached-error", main);
        await tabTo(page, refresh); await expect(refresh).toBeFocused();
        await capture(page, info, "retry-keyboard", main);
        expect(await focused(page)).toMatchObject({ focusVisible: true, inViewport: true, unobscured: true });
        http.arm("recovered"); await page.keyboard.press("Enter");
        await expect(refresh).toHaveAttribute("aria-busy", "true");
        await page.keyboard.press("Enter"); await page.keyboard.press("Space");
        expect(http.count("recovered")).toBe(1);
        await expect(refresh).toBeFocused();
        await capture(page, info, "retry-pending", main, false);
        http.release("recovered");
        await expect(main.getByRole("cell", { name: "合成更新安排", exact: true })).toBeVisible();
        await expect(refresh).toBeFocused();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await capture(page, info, "recovered", main);
        const edit = main.getByRole("button", { name: "编辑", exact: true });
        await tabTo(page, edit); await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "编辑公告", exact: true });
        await expect(dialog.getByRole("textbox", { name: "公告标题", exact: true })).toHaveValue("合成更新安排");
        await expect(dialog.getByRole("textbox", { name: "公告正文", exact: true })).toHaveValue("合成更新正文");
        await capture(page, info, "fresh-edit", dialog);
      } else {
        await tabTo(page, page.getByRole("button", { name: "创建公告", exact: true }));
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "创建公告", exact: true });
        const title = dialog.getByRole("textbox", { name: "公告标题", exact: true });
        await tabTo(page, title); await page.keyboard.type("Synthetic newer draft");
        await expect(title).toBeFocused();
        await capture(page, info, "newer-create-pending", dialog);
        http.release("failure");
        // Modal hides background semantics, but the read must still settle.
        await expect(main.getByText("合成公告读取失败", { exact: true })).toHaveCount(1);
        expect(http.count("failure")).toBe(2);
        await expect(title).toBeFocused(); await expect(title).toHaveValue("Synthetic newer draft");
        await expect(dialog).toBeVisible();
        await capture(page, info, "newer-create-owned", dialog);
      }
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), false); }
      catch (error) { failures.push(error); }
      finally { http.releaseAll(); }
      try {
        const body = JSON.stringify({ width, scenario, ...http.ledger,
          scope: "Synthetic native cached announcement recovery; no writes, delivery or concurrency protection claim" }, null, 2);
        await writeFile(info.outputPath("announcement-request-ledger.json"), body);
        await info.attach("announcement-request-ledger", { body, contentType: "application/json" });
        expect(http.ledger.rejected).toEqual([]); expect(http.ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Announcement recovery or evidence failed");
  });
}
