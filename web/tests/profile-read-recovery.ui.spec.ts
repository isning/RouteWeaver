import { isDeepStrictEqual } from "node:util";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App + exact synthetic loopback HTTP. The single approved profile PUT is
// validated and fulfilled locally; no API request or mutation reaches a server.
// This proves UI continuity, not durable storage, auth or backend revision safety.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

const csrf = "synthetic-profile-review-only";
const openingRevision = "synthetic-draft-revision-one";
const savedRevision = "synthetic-draft-revision-two";
const oldName = "日常分流草稿";
const savedName = "已保存的日常分流";
const linkedName = "手机分流配置";
const phoneName = "手机订阅";
const failedReadTitle = "暂时无法加载分流配置";
const retainedNotice = "显示上次读取的配置，请重试以核对最新状态。";
function profile(id: string, name: string, revisionToken: string) {
  return {
    id, name, revisionToken,
    target: { adapterId: "mihomo", version: "1.19.32" }, mode: "full", sourceIds: [],
    ir: {
      schemaVersion: "1.0", id, name, ownerId: "", revision: "1",
      endpoints: [], groups: [], rules: [], resources: [], defaultAction: { kind: "direct" },
      runtime: {
        mixedPort: 7890, sniff: false,
        dns: { servers: [{ id: "dns1", type: "tls", address: "1.1.1.1", port: 853 }], final: "dns1" },
        tun: { enabled: false, addresses: ["172.19.0.1/30"], autoRoute: true },
      },
    },
  };
}
const draft = profile("synthetic-draft", oldName, openingRevision);
const linked = profile("synthetic-linked", linkedName, "synthetic-linked-revision");
const saved = profile(draft.id, savedName, savedRevision);
const { revisionToken: _excludedRevision, ...expectedSave } = saved;
void _excludedRevision;

function validSave(request: Request) {
  try {
    const bytes = request.postDataBuffer();
    if (!bytes || bytes.length > 8192 ||
      request.headers()["content-type"]?.split(";")[0].trim() !== "application/json" ||
      request.headers()["if-match"] !== openingRevision ||
      request.headers()["x-csrf-token"] !== csrf) return false;
    return isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), expectedSave);
  } catch { return false; }
}

async function fixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic profile recovery requires loopback");
  const origin = new URL(baseURL).origin;
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-reader", name: "合成订阅用户", role: "user" }, csrfToken: csrf },
    "/api/me/overview": { user: { id: "synthetic-reader", name: "合成订阅用户" }, status: "active", quotaBytes: 0,
      usage: { rawBytes: 0, weightedBytes: 0 }, routes: [] },
    "/api/me/outputs": [{ id: "synthetic-phone", profileId: linked.id, name: phoneName,
      target: linked.target, mode: "full", status: "published", publishedAt: "2026-10-01T00:00:00Z" }],
    "/api/me/sources": [], "/api/me/collections": [], "/api/me/resources": [],
    "/api/me/platform-entries": [], "/api/me/notifications": [],
    "/api/me/outputs/independent": { items: [] },
  };
  const ledger = {
    profileReads: 0, failedProfileReads: 0, recoveredProfileReads: 0, reveals: 0, saves: 0,
    explicitRetryArmed: false, savePayloadChecks: [] as boolean[],
    rejected: [] as string[], pageErrors: 0,
  };
  let phase: "initial" | "failed-refresh" | "retry-ready" | "recovered" = "initial";
  let saveAuthorized = false;
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (reason: string) => {
      // Persist only fixed categories, counts and booleans. Never copy arbitrary
      // URLs, bodies, headers, query values, cookies or authentication material.
      ledger.rejected.push(reason);
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin || url.username || url.password || url.hash)
      return reject("external or metadata-bearing request");
    if (!url.pathname.startsWith("/api/")) {
      // Shared Vite lane or its production build: forward local static GETs only.
      const staticPath = ["/", "/favicon.ico", "/@vite/client", "/@react-refresh"].includes(url.pathname) ||
        /^\/(?:src|node_modules|assets)\/[^?#]+\.(?:[cm]?[jt]sx?|css|woff2?|ttf|svg)$/.test(url.pathname);
      const staticQuery = [...url.searchParams].every(([key, value]) =>
        (key === "v" && /^[a-zA-Z0-9_-]+$/.test(value)) ||
        (key === "t" && /^\d+$/.test(value)) || (key === "import" && value === ""));
      if (method === "GET" && staticPath && staticQuery) return route.continue();
      return reject("unexpected static request");
    }
    if (url.search) return reject("API query metadata");
    if (method === "GET" && url.pathname === "/api/me/profiles") {
      ledger.profileReads++;
      if (phase === "failed-refresh") {
        ledger.failedProfileReads++;
        return route.fulfill({ status: 503, json: { error: "合成配置清单读取失败" } });
      }
      if (phase === "retry-ready" || phase === "recovered") {
        ledger.recoveredProfileReads++;
        phase = "recovered";
        return route.fulfill({ json: [saved, linked] });
      }
      return route.fulfill({ json: [draft, linked] });
    }
    if (method === "GET" && url.pathname === "/api/me/profiles/synthetic-draft/reveal") {
      if (phase !== "initial" || ledger.reveals !== 0) return reject("unexpected profile reveal");
      ledger.reveals++;
      return route.fulfill({ json: draft });
    }
    if (method === "GET" && Object.hasOwn(reads, url.pathname)) return route.fulfill({ json: reads[url.pathname] });
    if (method === "PUT" && url.pathname === "/api/me/profiles/synthetic-draft") {
      const valid = validSave(request);
      ledger.savePayloadChecks.push(valid);
      if (!valid || !saveAuthorized || ledger.saves !== 0 || ledger.reveals !== 1 || phase !== "initial")
        return reject("unexpected or mismatched synthetic profile save");
      saveAuthorized = false;
      ledger.saves++;
      phase = "failed-refresh";
      return route.fulfill({ json: saved });
    }
    return reject("unexpected API read or mutation");
  });
  return {
    ledger,
    authorizeSave() { saveAuthorized = true; },
    authorizeRetry() {
      if (phase !== "failed-refresh" || ledger.failedProfileReads === 0)
        throw new Error("Profile retry was not preceded by the synthetic failure");
      ledger.explicitRetryArmed = true;
      phase = "retry-ready";
    },
  };
}

async function tabTo(page: Page, target: Locator, direction?: "Tab" | "Shift+Tab") {
  await expect(target).toBeVisible();
  const key = direction ?? await target.evaluate((node) => {
    const active = document.activeElement;
    return active && active !== document.body &&
      active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? "Shift+Tab" : "Tab";
  });
  for (let index = 0; index < 80; index++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error("Profile recovery control was not reachable by keyboard");
}
async function capture(page: Page, info: TestInfo, stage: string, surface: Locator,
  targets: { label: string; locator: Locator }[], settle = true) {
  let settlingFailed = false;
  try { if (settle) await settledTask(surface); }
  catch { settlingFailed = true; }
  // Original viewport first. Do not focus/scroll via script, disable motion,
  // dismiss overlays or reconstruct pixels to make the evidence look correct.
  await info.attach(`profile-read-${stage}-pixels`, {
    body: await page.screenshot({ fullPage: false, mask: [
      page.locator('input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]'),
    ] }), contentType: "image/png",
  });
  const viewport = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    focusedTag: document.activeElement?.tagName || null,
  }));
  const geometry = [];
  for (const target of targets) {
    const count = await target.locator.count();
    geometry.push({ label: target.label, count, bounds: count === 1 ? await target.locator.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
        hit: hit === node || node.contains(hit),
      };
    }) : null });
  }
  await info.attach(`profile-read-${stage}-geometry`, {
    body: JSON.stringify({ viewport, geometry, settlingFailed }, null, 2), contentType: "application/json",
  });
  if (settlingFailed) throw new Error("Profile task did not settle before its original capture");
  expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  return geometry;
}

for (const width of [390, 1440]) {
  test(`saved profile survives a failed list refresh and explicit recovery at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const http = await fixture(page, baseURL);
    const main = page.getByRole("main");
    const oldArticle = page.getByRole("article", { name: `分流配置 ${oldName}`, exact: true });
    const linkedArticle = page.getByRole("article", { name: `分流配置 ${linkedName}`, exact: true });
    const name = page.getByRole("textbox", { name: "配置名称", exact: true });
    const retry = page.getByRole("button", { name: "重试配置", exact: true });
    const access = linkedArticle.getByRole("button", { name: "获取订阅", exact: true });
    const failures: unknown[] = [];
    try {
      await page.goto("/#subscriptions");
      await expect(oldArticle).toBeVisible();
      await expect(linkedArticle).toBeVisible();
      await oldArticle.getByRole("button", { name: "继续配置", exact: true }).click();
      await expect(name).toHaveValue(oldName);
      await name.fill(savedName);
      http.authorizeSave();
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
      await expect.poll(() => http.ledger.saves).toBe(1);
      await expect.poll(() => http.ledger.failedProfileReads).toBeGreaterThan(0);
      await expect(name).toHaveValue(savedName);
      await capture(page, info, "saved-editor", main, [{ label: "saved-name", locator: name }]);
      await page.getByRole("button", { name: "返回", exact: true }).click();
      await expect(page.getByText(failedReadTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(retainedNotice, { exact: true })).toBeVisible();
      await expect(oldArticle).toBeVisible();
      await expect(linkedArticle).toBeVisible();
      await expect(linkedArticle.getByRole("button", { name: `查看订阅 ${phoneName}`, exact: true })).toBeVisible();
      await expect(page.getByRole("article", { name: /^关联配置不可用/ })).toHaveCount(0);
      await expect(page.getByText("关联配置不可用", { exact: true })).toHaveCount(0);
      await expect(page.getByText("此分流配置不可用", { exact: true })).toHaveCount(0);
      await expect(linkedArticle.getByRole("button", { name: "检查更新", exact: true })).toBeDisabled();
      await expect(linkedArticle.getByRole("button", { name: `为 ${linkedName} 新增客户端订阅`, exact: true })).toBeDisabled();
      await expect(access).toBeEnabled();
      expect(http.ledger.recoveredProfileReads).toBe(0);
      await capture(page, info, "returned-error-original", main, [
        { label: "retry", locator: retry }, { label: "known-draft", locator: oldArticle },
        { label: "known-linked-profile", locator: linkedArticle },
      ]);
      await tabTo(page, retry);
      const retryGeometry = await capture(page, info, "retry-reachable", main, [{ label: "retry", locator: retry }]);
      expect(retryGeometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await tabTo(page, access, "Tab");
      const linkedGeometry = await capture(page, info, "retained-linked-profile", main, [{ label: "frozen-access", locator: access }]);
      expect(linkedGeometry[0].bounds).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      expect(http.ledger.saves).toBe(1);
      await tabTo(page, retry, "Shift+Tab");
      http.authorizeRetry();
      await page.keyboard.press("Enter");
      const recovered = page.getByRole("article", { name: `分流配置 ${savedName}`, exact: true });
      await expect(recovered).toBeVisible();
      await expect(oldArticle).toHaveCount(0);
      await expect(page.getByText(failedReadTitle, { exact: true })).toHaveCount(0);
      await expect(retry).toHaveCount(0);
      await expect(linkedArticle).toBeVisible();
      await expect(linkedArticle.getByRole("button", { name: "检查更新", exact: true })).toBeEnabled();
      await expect(linkedArticle.getByRole("button", { name: `为 ${linkedName} 新增客户端订阅`, exact: true })).toBeEnabled();
      await capture(page, info, "recovered-original", main, [
        { label: "recovered-draft", locator: recovered }, { label: "linked-profile", locator: linkedArticle },
      ]);
      expect(http.ledger.recoveredProfileReads).toBe(1);
      expect(http.ledger.reveals).toBe(1);
      expect(http.ledger.saves).toBe(1);
      expect(new URL(page.url()).hash).toBe("#subscriptions");
    } catch (error) { failures.push(error); }
    finally {
      // Preserve final original pixels even if a behavioral assertion failed.
      try { await capture(page, info, "final-original", page.locator("body"), [], false); }
      catch (error) { failures.push(error); }
      // Independent sanitized ledger is attempted even if screenshots fail.
      try {
        await info.attach("profile-read-request-ledger", {
          body: JSON.stringify({ width, ...http.ledger,
            scope: "Synthetic App save/read recovery only; no real backend mutation, publication or full accessibility acceptance" }, null, 2),
          contentType: "application/json",
        });
        expect(http.ledger.rejected, "All unexpected and off-origin HTTP requests are blocked").toEqual([]);
        expect(http.ledger.pageErrors).toBe(0);
        expect(http.ledger.savePayloadChecks).toEqual([true]);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Profile read recovery task or evidence failed");
  });
}
