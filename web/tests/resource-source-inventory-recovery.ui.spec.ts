import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import type { RuleResource, Source } from "../src/types";
import { settledTask } from "./ui-settled-task";

// Actual App with exact loopback synthetic HTTP. Each case's one refresh POST
// is validated and fulfilled locally; no API HTTP request reaches a backend.
// Static local GETs remain allowed. HTTP routing does not assert WebSocket coverage.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

type Scenario = "resource" | "source-changed" | "source-removed";
const csrf = "synthetic-inventory-review-only";
const sourceName = "合成入口来源", otherSourceName = "合成备用来源", changedSourceName = "合成来源已更新";
const resourceName = "合成入口规则", otherResourceName = "合成备用规则";
const sourceNotice = "显示上次读取的来源，请重试以核对最新状态。";
const resourceNotice = "显示上次读取的规则资源，请重试以核对最新状态。";
const source: Source = {
  id: "synthetic-source", name: sourceName, kind: "text", enabled: true, revision: "synthetic-source-one",
  snapshot: { endpoints: [] },
  candidate: { id: "synthetic-candidate", createdAt: "2026-11-11T00:00:00Z", diagnostics: [], affected: [],
    diff: { beforeCount: 0, afterCount: 0, added: [], removed: [], renamed: [], connectionChanged: [] } },
};
const changedSource: Source = {
  ...source, name: changedSourceName, revision: "synthetic-source-two", candidate: undefined,
  snapshot: { endpoints: [{ id: "synthetic-current-node", name: "更新后的合成连接", origin: "imported",
    connection: { protocol: "socks", host: "synthetic.invalid", port: 1080 } }] },
};
const resource: RuleResource = {
  id: "synthetic-resource", name: resourceName, format: "mihomo-yaml", behavior: "domain",
  location: "remote", visibility: "private", updatePolicy: "pinned", revision: "1", digest: "a".repeat(64),
  acceptedVersion: "synthetic-accepted-one", revisionToken: "synthetic-resource-one", canRefresh: true,
};

function validRefresh(request: Request) {
  try {
    const bytes = request.postDataBuffer();
    return !!bytes && bytes.length <= 256 &&
      request.headers()["content-type"]?.split(";")[0].trim() === "application/json" &&
      request.headers()["x-csrf-token"] === csrf &&
      isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), {});
  } catch { return false; }
}

async function fixture(page: Page, baseURL: string | undefined, scenario: Scenario) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic inventory recovery requires loopback");
  const origin = new URL(baseURL).origin;
  const resources = scenario === "resource";
  const listPath = resources ? "/api/me/resources" : "/api/me/sources";
  const refreshPath = resources ? "/api/me/resources/synthetic-resource/refresh" : "/api/me/sources/synthetic-source/refresh";
  const initialRows = resources ? [resource, { ...resource, id: "synthetic-other-rule", name: otherResourceName }]
    : [source, { ...source, id: "synthetic-other-source", name: otherSourceName, candidate: undefined }];
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-reader", name: "合成订阅用户", role: "user" }, csrfToken: csrf },
    "/api/me/overview": { user: { id: "synthetic-reader", name: "合成订阅用户" }, status: "active", quotaBytes: 0,
      usage: { rawBytes: 0, weightedBytes: 0 }, routes: [] },
    "/api/me/profiles": [], "/api/me/outputs": [], "/api/me/collections": [],
    "/api/me/sources": [], "/api/me/resources": [], "/api/me/platform-entries": [], "/api/me/notifications": [],
  };
  const ledger = {
    initialFailures: 0, initialReads: 0, failedRefreshReads: 0, recoveredReads: 0,
    initialRetryCommands: 0, retryCommands: 0, syntheticRefreshes: 0,
    refreshPayloadChecks: [] as boolean[], rejected: [] as string[], pageErrors: 0,
  };
  let phase: "unknown" | "initial" | "failed-refresh" | "retry-ready" | "recovered" = resources ? "unknown" : "initial";
  let refreshAuthorized = false;
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (reason: string) => {
      // Fixed categories only: never persist arbitrary URLs, payloads, headers,
      // cookies, query values, account state or authentication material.
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
    if (url.search) return reject("API query metadata");
    if (method === "GET" && url.pathname === listPath) {
      if (phase === "unknown") {
        ledger.initialFailures++;
        return route.fulfill({ status: 503, json: { error: "合成初次清单读取失败" } });
      }
      if (phase === "failed-refresh") {
        ledger.failedRefreshReads++;
        return route.fulfill({ status: 503, json: { error: "合成清单核对失败" } });
      }
      if (phase === "retry-ready" || phase === "recovered") {
        ledger.recoveredReads++; phase = "recovered";
        return route.fulfill({ json: scenario === "source-changed" ? [changedSource] : [] });
      }
      ledger.initialReads++;
      return route.fulfill({ json: initialRows });
    }
    if (method === "GET" && Object.hasOwn(reads, url.pathname)) return route.fulfill({ json: reads[url.pathname] });
    if (method === "POST" && url.pathname === refreshPath) {
      const valid = validRefresh(request);
      ledger.refreshPayloadChecks.push(valid);
      if (!valid || !refreshAuthorized || ledger.syntheticRefreshes !== 0 || phase !== "initial" || ledger.initialReads === 0)
        return reject("unexpected or mismatched synthetic refresh");
      refreshAuthorized = false; ledger.syntheticRefreshes++; phase = "failed-refresh";
      return route.fulfill({ json: resources ? {} : source });
    }
    return reject("unexpected API read or mutation");
  });
  return {
    ledger,
    authorizeInitialRetry() {
      if (phase !== "unknown" || !ledger.initialFailures) throw new Error("Initial failure was not observed");
      ledger.initialRetryCommands++; phase = "initial";
    },
    authorizeRefresh() { refreshAuthorized = true; },
    authorizeRetry() {
      if (phase !== "failed-refresh" || !ledger.failedRefreshReads) throw new Error("Cached read failure was not observed");
      ledger.retryCommands++; phase = "retry-ready";
    },
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
  throw new Error("Inventory retry was not reachable by ordinary keyboard traversal");
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
    const pixels = await page.screenshot({ path: info.outputPath(`${stage}.png`), fullPage: false, mask: [
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
    await writeFile(info.outputPath(`${stage}.json`), body);
    await info.attach(`${stage}-geometry`, { body, contentType: "application/json" });
    expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Inventory original capture or geometry failed");
  return geometry;
}

for (const width of [390, 1440]) for (const scenario of ["resource", "source-changed", "source-removed"] as const) {
  test(`inventory read recovery ${scenario} at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const http = await fixture(page, baseURL, scenario);
    const main = page.getByRole("main"), failures: unknown[] = [];
    try {
      await page.goto(scenario === "resource" ? "/#resources" : "/#sources");
      if (scenario === "resource") {
        await expect(page.getByText("合成初次清单读取失败", { exact: true })).toBeVisible();
        await expect(page.getByText(resourceNotice, { exact: true })).toHaveCount(0);
        await expect(page.getByText("暂无规则资源", { exact: true })).toHaveCount(0);
        const initialRetry = page.getByRole("button", { name: "重试", exact: true });
        await tabTo(page, initialRetry);
        await capture(page, info, "resource-initial-unknown", main, [{ label: "initial-retry", locator: initialRetry }]);
        http.authorizeInitialRetry(); await page.keyboard.press("Enter");
        const known = page.getByRole("button", { name: resourceName, exact: true });
        const other = page.getByRole("button", { name: otherResourceName, exact: true });
        await expect(known).toBeVisible(); await expect(other).toBeVisible();
        const actions = page.getByRole("group", { name: `${resourceName} 的操作`, exact: true });
        await actions.getByRole("button", { name: "刷新文件", exact: true }).click();
        const confirmation = page.getByRole("alertdialog");
        await expect(confirmation).toBeVisible();
        http.authorizeRefresh();
        await confirmation.getByRole("button", { name: "读取并接纳", exact: true }).click();
        await expect(confirmation).toHaveCount(0);
        await expect(page.getByText("合成清单核对失败", { exact: true })).toBeVisible();
        await expect(page.getByText(resourceNotice, { exact: true })).toBeVisible();
        await expect(known).toBeVisible(); await expect(other).toBeVisible();
        await expect(known).toBeDisabled();
        await expect(actions.getByRole("button", { name: "替换文件", exact: true })).toBeDisabled();
        await expect(actions.getByRole("button", { name: "刷新文件", exact: true })).toBeDisabled();
        const retry = page.getByRole("button", { name: "重试规则资源", exact: true });
        await capture(page, info, "resource-cached-error", main, [
          { label: "known-resource", locator: known }, { label: "other-resource", locator: other }, { label: "retry", locator: retry },
        ]);
        await tabTo(page, retry);
        const geometry = await capture(page, info, "resource-retry-keyboard", main, [{ label: "retry", locator: retry }]);
        expect(geometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        // The retry remains in the keyboard path while a native tab-return
        // session check refreshes inventory. Wait here, without moving focus or
        // sending another command, until that existing read has settled.
        await expect(retry).toBeEnabled();
        await expect(retry).toBeFocused();
        http.authorizeRetry(); await page.keyboard.press("Enter");
        const empty = page.getByText("暂无规则资源", { exact: true });
        await expect(empty).toBeVisible(); await expect(known).toHaveCount(0); await expect(other).toHaveCount(0);
        await expect(page.getByText(resourceNotice, { exact: true })).toHaveCount(0);
        await capture(page, info, "resource-reconciled-empty", main, [{ label: "confirmed-empty", locator: empty }]);
      } else {
        const known = page.getByRole("button", { name: `${sourceName} 文本导入`, exact: true });
        const other = page.getByRole("button", { name: `${otherSourceName} 文本导入`, exact: true });
        await expect(known).toBeVisible(); await expect(other).toBeVisible();
        const search = page.getByRole("textbox", { name: "搜索来源", exact: true });
        await search.fill("合成");
        await page.getByRole("button", { name: `更多操作 ${sourceName}`, exact: true }).click();
        http.authorizeRefresh();
        await page.getByRole("menuitem", { name: `刷新来源 ${sourceName}`, exact: true }).click();
        await expect(page.getByText("合成清单核对失败", { exact: true })).toBeVisible();
        await expect(page.getByText(sourceNotice, { exact: true })).toBeVisible();
        await expect(search).toHaveValue("合成"); await expect(known).toBeVisible(); await expect(other).toBeVisible();
        await expect(page.getByRole("button", { name: `应用更新 ${sourceName}`, exact: true })).toBeDisabled();
        await capture(page, info, "source-cached-error", main, [
          { label: "source-search", locator: search }, { label: "known-source", locator: known }, { label: "other-source", locator: other },
        ]);
        await known.click();
        const sheet = page.getByRole("dialog");
        await expect(sheet).toHaveAccessibleName(sourceName);
        await expect(sheet.getByText(sourceNotice, { exact: true })).toBeVisible();
        await expect(sheet.getByRole("button", { name: `应用更新 ${sourceName}`, exact: true })).toBeDisabled();
        await expect(sheet.getByRole("button", { name: "用此来源新建分流配置", exact: true })).toBeDisabled();
        const retry = sheet.getByRole("button", { name: "重试来源列表", exact: true });
        await capture(page, info, "source-detail-cached", sheet, [{ label: "detail-retry", locator: retry }]);
        await tabTo(page, retry);
        const geometry = await capture(page, info, "source-detail-retry-keyboard", sheet, [{ label: "detail-retry", locator: retry }]);
        expect(geometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
        await expect(retry).toBeEnabled();
        await expect(retry).toBeFocused();
        http.authorizeRetry(); await page.keyboard.press("Enter");
        await expect(sheet.getByText("合成清单核对失败", { exact: true })).toHaveCount(0);
        await expect(sheet.getByRole("button", { name: `应用更新 ${sourceName}`, exact: true })).toHaveCount(0);
        await expect(sheet.getByRole("button", { name: "查看变化", exact: true })).toHaveCount(0);
        await expect(sheet.getByText("有更新可应用", { exact: true })).toHaveCount(0);
        const result = scenario === "source-changed" ? sheet.getByText("更新后的合成连接", { exact: true })
          : sheet.getByText("此来源已不在当前列表中", { exact: true });
        await expect(result).toBeVisible();
        if (scenario === "source-changed") {
          await expect(sheet).toHaveAccessibleName(changedSourceName);
          await expect(sheet.getByRole("button", { name: "用此来源新建分流配置", exact: true })).toBeEnabled();
        } else {
          await expect(sheet).toHaveAccessibleName(sourceName);
          await expect(sheet.getByRole("table")).toHaveCount(0);
          await expect(sheet.getByRole("button", { name: "用此来源新建分流配置", exact: true })).toHaveCount(0);
        }
        await capture(page, info, "source-detail-reconciled", sheet, [{ label: "reconciled-result", locator: result }]);
        await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0);
        await expect(search).toHaveValue("合成");
        await expect(known).toHaveCount(0); await expect(other).toHaveCount(0);
        if (scenario === "source-changed")
          await expect(page.getByRole("button", { name: `${changedSourceName} 文本导入`, exact: true })).toBeVisible();
        else await expect(page.getByText("暂无订阅来源", { exact: true })).toBeVisible();
      }
      expect(http.ledger.syntheticRefreshes).toBe(1);
      expect(http.ledger.retryCommands).toBe(1);
      expect(http.ledger.recoveredReads).toBe(1);
      expect(http.ledger.initialRetryCommands).toBe(scenario === "resource" ? 1 : 0);
    } catch (error) { failures.push(error); }
    finally {
      try { await capture(page, info, "final-original", page.locator("body"), [], false); }
      catch (error) { failures.push(error); }
      // Independent ledger survives screenshot or geometry failures. Counts and
      // fixed synthetic scenario labels only; no request data or errors persisted.
      try {
        const body = JSON.stringify({ width, scenario, ...http.ledger,
          scope: "Synthetic App HTTP read recovery; no backend mutation, publication, WebSocket or full accessibility acceptance" }, null, 2);
        await writeFile(info.outputPath("request-ledger.json"), body);
        await info.attach("inventory-read-request-ledger", { body, contentType: "application/json" });
        expect(http.ledger.rejected, "Unexpected and off-origin HTTP requests are blocked").toEqual([]);
        expect(http.ledger.pageErrors).toBe(0);
        expect(http.ledger.refreshPayloadChecks).toEqual([true]);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Inventory recovery task or evidence failed");
  });
}
