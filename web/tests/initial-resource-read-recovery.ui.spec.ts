import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Native observation, not a prescribed focus handoff. No cached inventory or writes.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

async function fixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Initial Resources observation requires loopback");
  const origin = new URL(baseURL).origin;
  type Phase = "initial-failure" | "held-failure" | "held-success";
  let phase: Phase = "initial-failure";
  const gates = new Map<Phase, { promise: Promise<void>; release: () => void }>();
  for (const key of ["held-failure", "held-success"] as const) {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    gates.set(key, { promise, release });
  }
  const ledger = {
    reads: [] as { phase: Phase; outcome: string }[],
    rejected: [] as string[], pageErrors: 0,
  };
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-resource-reader", name: "合成用户", role: "user" }, csrfToken: "synthetic-resource-only" },
    "/api/me/notifications": [],
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
    if (url.pathname === "/api/me/resources") {
      const ownedPhase = phase;
      const entry = { phase: ownedPhase, outcome: "pending" };
      ledger.reads.push(entry);
      if (ownedPhase !== "initial-failure") await gates.get(ownedPhase)!.promise;
      entry.outcome = ownedPhase === "held-success" ? "synthetic-empty" : "synthetic-503";
      return route.fulfill(ownedPhase === "held-success" ? { json: [] } : {
        status: 503, json: { error: ownedPhase === "initial-failure" ? "合成首次规则资源读取失败" : "合成规则资源再次读取失败" },
      });
    }
    if (Object.hasOwn(reads, url.pathname)) return route.fulfill({ json: reads[url.pathname] });
    return reject("unexpected API read");
  });
  return {
    ledger,
    count: (key: Phase) => ledger.reads.filter(entry => entry.phase === key).length,
    arm: (key: Phase) => { phase = key; },
    release: (key: Phase) => { gates.get(key)?.release(); },
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
  throw new Error("Resource action was not reachable by ordinary keyboard traversal");
}

async function capture(page: Page, info: TestInfo, stage: string, surface: Locator, settle = true) {
  const failures: unknown[] = [];
  try { if (settle) await settledTask(surface); } catch (error) { failures.push(error); }
  // Capture the original viewport before any subsequent Tab, focus or scrolling.
  try {
    const pixels = await page.screenshot({ path: info.outputPath(`initial-resource-${stage}.png`), fullPage: false,
      mask: [page.locator('input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"]')] });
    await info.attach(`${stage}-pixels`, { body: pixels, contentType: "image/png" });
  } catch (error) { failures.push(error); }
  try {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    const body = JSON.stringify({ viewport, focus: await focused(page), settlingFailed: failures.length > 0 }, null, 2);
    await writeFile(info.outputPath(`initial-resource-${stage}.json`), body);
    await info.attach(`${stage}-focus`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Initial resource capture failed");
}

// Desktop first: native sequential focus may differ from jsdom after node removal.
for (const scenario of ["retry", "newer-dialog"] as const) {
  test(`Initial Resources ${scenario} keyboard observation at 1440px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const http = await fixture(page, baseURL);
    const failures: unknown[] = [];
    const observation: Record<string, unknown> = {};
    const retry = page.getByRole("button", { name: "重试", exact: true });
    // Keep a DOM locator when a newer modal conceals background semantics.
    const main = page.locator("main");
    try {
      await page.goto("/#resources");
      await expect(page.getByText("合成首次规则资源读取失败", { exact: true })).toBeVisible();
      await expect(page.getByText("暂无规则资源", { exact: true })).toHaveCount(0);
      // Production defaults perform one automatic retry before showing error.
      expect(http.count("initial-failure")).toBe(2);
      await tabTo(page, retry);
      await expect(retry).toBeFocused();
      await capture(page, info, "retry-keyboard", main);
      expect(await focused(page)).toMatchObject({ focusVisible: true, inViewport: true, unobscured: true });
      http.arm(scenario === "retry" ? "held-failure" : "held-success");
      await page.keyboard.press("Enter");
      const pending = page.getByRole("status", { name: "正在加载", exact: true });
      await expect(pending).toHaveAttribute("aria-busy", "true");
      await expect(page.getByText("暂无规则资源", { exact: true })).toHaveCount(0);
      observation.pendingFocus = await focused(page);
      await capture(page, info, "retry-pending", main, false);
      await page.keyboard.press("Enter"); await page.keyboard.press("Space");
      expect(http.count(scenario === "retry" ? "held-failure" : "held-success")).toBe(1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      if (scenario === "retry") {
        http.release("held-failure");
        await expect(page.getByText("合成规则资源再次读取失败", { exact: true })).toBeVisible();
        expect(http.count("held-failure")).toBe(2);
        await expect(page.getByText("暂无规则资源", { exact: true })).toHaveCount(0);
        observation.repeatedFailureFocus = await focused(page);
        await capture(page, info, "repeated-error", main);
        // No assertion on BODY. Observe the browser's actual sequential starting point.
        await page.keyboard.press("Tab");
        observation.firstTabAfterFailure = await focused(page);
        await capture(page, info, "failure-next-tab", page.locator("body"));
        const recovery = await tabTo(page, retry);
        observation.recovery = { totalTabs: 1 + recovery.tabs, pathAfterFirstTab: recovery.path };
        await expect(retry).toBeFocused();
        http.arm("held-success"); await page.keyboard.press("Enter");
        await expect(pending).toHaveAttribute("aria-busy", "true");
        await expect(page.getByText("暂无规则资源", { exact: true })).toHaveCount(0);
        http.release("held-success");
        await expect(page.getByText("暂无规则资源", { exact: true })).toBeVisible();
        await expect(retry).toHaveCount(0);
        observation.successFocus = await focused(page);
        await capture(page, info, "recovered", main);
        await page.keyboard.press("Tab");
        observation.firstTabAfterSuccess = await focused(page);
        await capture(page, info, "success-next-tab", page.locator("body"));
      }
      const add = page.getByRole("button", { name: "添加公开引用", exact: true });
      observation.addTraversal = await tabTo(page, add);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "添加公开规则引用", exact: true });
      await expect(dialog).toBeVisible();
      const name = dialog.getByRole("textbox", { name: "资源名称", exact: true });
      await tabTo(page, name); await page.keyboard.type("合成新任务草稿");
      await expect(name).toBeFocused();
      if (scenario === "newer-dialog") {
        await capture(page, info, "newer-dialog-pending", dialog);
        http.release("held-success");
        // The dialog intentionally hides background semantics; assert actual DOM text.
        await expect(main.getByText("暂无规则资源", { exact: true })).toHaveCount(1);
      }
      await expect(name).toBeFocused(); await expect(name).toHaveValue("合成新任务草稿");
      await expect(dialog).toBeVisible();
      await capture(page, info, "dialog-owned", dialog);
      expect(http.count("held-success")).toBe(1);
    } catch (error) { failures.push(error); }
    finally {
      http.releaseAll();
      try { await capture(page, info, "final-original", page.locator("body"), false); }
      catch (error) { failures.push(error); }
      try {
        const body = JSON.stringify({ scenario, observation, ...http.ledger,
          scope: "Synthetic desktop initial-read keyboard observation; no production handoff choice, backend writes or comprehensive accessibility claim" }, null, 2);
        await writeFile(info.outputPath("initial-resource-request-ledger.json"), body);
        await info.attach("initial-resource-ledger", { body, contentType: "application/json" });
        expect(http.ledger.rejected).toEqual([]); expect(http.ledger.pageErrors).toBe(0);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Initial Resources observation or evidence failed");
  });
}
