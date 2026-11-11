import { expect, test, type Locator, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Real App + synthetic loopback HTTP. No backup POST is forwarded, no archive
// is created/restored, and this does not prove backend encryption or isolation.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });

const filename = "synthetic-recovery.age";
const archiveText = "synthetic browser backup fixture";
const fixturePassword = "synthetic-backup-password";
const digest = "synthetic-reviewed-archive";
const uncertainTarget = `restore_${"a".repeat(43)}.db`;
const successTarget = `restore_${"b".repeat(43)}.db`;
const phrase = "恢复到新数据库";

async function validUpload(request: Request, restoring: boolean) {
  try {
    const bytes = request.postDataBuffer();
    const contentType = request.headers()["content-type"] || "";
    if (!bytes || bytes.length > 4096 || !contentType.startsWith("multipart/form-data; boundary=")) return false;
    const form = await new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": contentType },
    }).formData();
    if ([...form.keys()].sort().join(",") !== "archive,metadata") return false;
    const archive = form.get("archive"), metadata = form.get("metadata");
    if (!archive || typeof archive === "string" || typeof metadata !== "string" ||
      archive.name !== filename || archive.type !== "application/octet-stream" ||
      await archive.text() !== archiveText) return false;
    const value: unknown = JSON.parse(metadata);
    const expected: Record<string, unknown> = restoring
      ? { password: fixturePassword, digest, confirmation: "RESTORE TO NEW STORE" }
      : { password: fixturePassword };
    return !!value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === Object.keys(expected).sort().join(",") &&
      Object.entries(expected).every(([key, item]) => (value as Record<string, unknown>)[key] === item);
  } catch {
    return false;
  }
}

async function fixture(page: Page, baseURL: string | undefined) {
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname))
    throw new Error("Synthetic backup continuity requires loopback");
  const origin = new URL(baseURL).origin;
  const reads: Record<string, unknown> = {
    "/api/auth/me": { user: { id: "synthetic-admin", name: "合成管理员", role: "admin" }, csrfToken: "synthetic-only" },
    "/api/settings": { name: "RouteWeaver", registration: "invite", timezone: "UTC+8" },
    "/api/state": { users: [], nodes: [], routes: [], revisions: [], capabilities: [], deploymentAvailable: false },
    "/api/services": [],
    "/api/published-routes": [],
    "/api/me/notifications": [],
    "/api/admin/subscription-origin": {
      revision: 1, configuredRevision: 1, draftOrigin: "", effectiveRevision: 1,
      effectiveOrigin: "", defaultOrigin: "", currentLinkExample: "/feed/{existing-token}",
      proposedLinkExample: "/feed/{existing-token}", verificationStatus: "not-required", tokensUnchanged: true,
    },
  };
  const ledger = {
    previews: 0, restores: 0, releasedWhileHidden: false, secondRestoreAuthorized: false,
    payloadChecks: [] as { operation: "preview" | "restore"; valid: boolean }[],
    rejected: [] as string[], pageErrors: 0,
  };
  let pending: Route | undefined;
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const reject = (reason: string) => {
      // Only fixed categories leave memory. Never record arbitrary URLs, bodies,
      // filenames, metadata, headers, cookies, query values or credentials.
      ledger.rejected.push(reason);
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin || url.username || url.password || url.hash)
      return reject("external or metadata-bearing request");
    if (!url.pathname.startsWith("/api/")) {
      // The shared lane uses Vite; allow only its local app/module/font GETs.
      // Production build assets are accepted too. Never forward an API or write.
      const staticPath = ["/", "/favicon.ico", "/@vite/client", "/@react-refresh"].includes(url.pathname) ||
        /^\/(?:src|node_modules|assets)\/[^?#]+\.(?:[cm]?[jt]sx?|css|woff2?|ttf|svg)$/.test(url.pathname);
      const staticQuery = [...url.searchParams].every(([key, value]) =>
        (key === "v" && /^[a-zA-Z0-9_-]+$/.test(value)) ||
        (key === "t" && /^\d+$/.test(value)) || (key === "import" && value === ""));
      if (method === "GET" && staticPath && staticQuery) return route.continue();
      return reject("unexpected static request");
    }
    if (url.search) return reject("API query metadata");
    if (method === "GET" && Object.hasOwn(reads, url.pathname)) return route.fulfill({ json: reads[url.pathname] });
    const preview = url.pathname === "/api/admin/backups/preview";
    const restore = url.pathname === "/api/admin/backups/restore";
    if (method !== "POST" || (!preview && !restore)) return reject("unexpected API read or mutation");
    const valid = await validUpload(request, restore);
    ledger.payloadChecks.push({ operation: preview ? "preview" : "restore", valid });
    if (!valid) return reject("synthetic backup payload mismatch");
    if (preview) {
      if (ledger.previews >= 3) return reject("extra backup preview");
      ledger.previews++;
      return route.fulfill({ json: {
        manifest: { schemaVersion: 2, createdAt: "2026-10-01T00:00:00Z" },
        digest, counts: { records: 1 }, restoreAvailable: true,
      } });
    }
    if (ledger.restores === 0 && ledger.previews === 1) {
      ledger.restores++;
      pending = route;
      return;
    }
    if (ledger.restores === 1 && ledger.previews === 3 && ledger.secondRestoreAuthorized) {
      ledger.restores++;
      ledger.secondRestoreAuthorized = false;
      return route.fulfill({ status: 201, json: { status: "restored", target: successTarget, activated: false } });
    }
    return reject("unexpected backup restore attempt");
  });
  return {
    ledger,
    async releaseUnknown() {
      if (!pending) throw new Error("No synthetic restore is pending");
      const route = pending;
      pending = undefined;
      ledger.releasedWhileHidden = true;
      await route.fulfill({ status: 500, json: {
        detail: "publication uncertain", restoreOutcome: "uncertain", target: uncertainTarget, activated: false,
      } });
    },
    async cleanup() {
      const route = pending;
      pending = undefined;
      if (route) await route.abort("failed");
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
  throw new Error("Backup task control was not reachable by keyboard");
}
async function activate(page: Page, target: Locator, direction?: "Tab" | "Shift+Tab") {
  await expect(target).toBeEnabled();
  await tabTo(page, target, direction);
  await page.keyboard.press("Enter");
}

async function capture(page: Page, info: TestInfo, stage: string, password: Locator,
  surface: Locator, target: Locator, settle = true) {
  let settlingFailed = false;
  try { if (settle) await settledTask(surface); }
  catch { settlingFailed = true; }
  // Original current viewport only. No test-side focus, scrolling, animation
  // changes or toast dismissal may repair the pixels before this capture.
  await info.attach(`backup-tab-${stage}-pixels`, {
    body: await page.screenshot({ fullPage: false, mask: [password] }), contentType: "image/png",
  });
  const viewport = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    focusedTag: document.activeElement?.tagName || null,
  }));
  const targetCount = await target.count();
  const geometry = targetCount === 1 ? await target.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { x: r.x, y: r.y, width: r.width, height: r.height,
      inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
      hit: hit === node || node.contains(hit),
    };
  }) : null;
  await info.attach(`backup-tab-${stage}-geometry`, {
    body: JSON.stringify({ viewport, geometry, targetCount, settlingFailed }, null, 2), contentType: "application/json",
  });
  if (settlingFailed) throw new Error("Backup task did not settle before its original capture");
  expect(viewport.scrollWidth, "Page has no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);
  return geometry;
}

for (const width of [390, 1440]) {
  test(`backup local-tab return retains an uncertain restore and keyboard recovery at ${width}px`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const http = await fixture(page, baseURL);
    const basicTab = page.getByRole("tab", { name: "基本设置", exact: true });
    const backupTab = page.getByRole("tab", { name: "备份与恢复", exact: true });
    const region = page.getByRole("region", { name: "备份与恢复", exact: true });
    const password = page.getByLabel("备份密码", { exact: true });
    const inspect = page.getByRole("button", { name: "校验备份并查看影响", exact: true });
    const confirmation = page.getByLabel("输入“恢复到新数据库”以确认", { exact: true });
    const restore = page.getByRole("button", { name: "恢复到新数据库", exact: true });
    const acknowledge = page.getByRole("button", { name: "已检查，允许再次恢复", exact: true });
    const failures: unknown[] = [];
    try {
      await page.goto("/#settings");
      await expect(page.getByRole("button", { name: "编辑平台名称", exact: true })).toBeEnabled();
      await tabTo(page, basicTab);
      // Radix tabs use roving focus. End/Home select the actual local panels;
      // inactive tabs are not reachable by ordinary Tab traversal.
      await page.keyboard.press("End");
      await expect(backupTab).toBeFocused();
      await expect(backupTab).toHaveAttribute("aria-selected", "true");
      const filechooser = page.waitForEvent("filechooser");
      await activate(page, page.getByRole("button", { name: "选择备份文件", exact: true }));
      await (await filechooser).setFiles({ name: filename, mimeType: "application/octet-stream", buffer: Buffer.from(archiveText) });
      await tabTo(page, password);
      await page.keyboard.insertText(fixturePassword);
      await activate(page, inspect);
      await expect(page.getByText("文件校验通过", { exact: true })).toBeVisible();
      await tabTo(page, confirmation, "Tab");
      await page.keyboard.insertText(phrase);
      await activate(page, restore, "Tab");
      await expect.poll(() => http.ledger.restores).toBe(1);
      await expect(restore).toHaveAttribute("aria-busy", "true");
      await tabTo(page, backupTab, "Shift+Tab");
      await page.keyboard.press("Home");
      await expect(basicTab).toBeFocused();
      await expect(region).toBeHidden();
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await activate(page, page.getByRole("button", { name: "编辑平台名称", exact: true }), "Tab");
      const name = page.getByRole("textbox", { name: "平台名称", exact: true });
      await expect(name).toBeFocused();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText("合成平台草稿");
      const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/admin/backups/restore");
      await http.releaseUnknown();
      await (await response).finished();
      const hiddenGeometry = await capture(page, info, "hidden-response", password,
        page.getByRole("form", { name: "平台基本设置", exact: true }), name);
      expect(hiddenGeometry).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("合成平台草稿");
      await expect(region).toBeHidden();
      expect(http.ledger.previews).toBe(1);
      expect(http.ledger.restores).toBe(1);

      await tabTo(page, basicTab, "Shift+Tab");
      await page.keyboard.press("End");
      await expect(backupTab).toBeFocused();
      await expect(page.getByText("恢复结果尚未确认", { exact: true })).toBeVisible();
      await expect(page.getByText(`待检查目标：${uncertainTarget}`, { exact: true })).toBeVisible();
      await expect(page.getByText(filename, { exact: true })).toBeVisible();
      expect(await password.inputValue() === fixturePassword, "Backup password is retained").toBe(true);
      await expect(confirmation).toHaveValue("");
      await tabTo(page, acknowledge, "Tab");
      const returnGeometry = await capture(page, info, "returned-recovery", password, region, acknowledge);
      expect(returnGeometry).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });

      // A new preview does not reconcile an earlier uncertain attempt.
      await activate(page, inspect, "Tab");
      await expect.poll(() => http.ledger.previews).toBe(2);
      await expect(page.getByText("文件校验通过", { exact: true })).toBeVisible();
      await tabTo(page, confirmation, "Tab");
      await page.keyboard.insertText(phrase);
      await expect(restore).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(http.ledger.restores).toBe(1);
      const blockedGeometry = await capture(page, info, "blocked-repeat", password, region, confirmation);
      expect(blockedGeometry).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      await activate(page, acknowledge, "Shift+Tab");
      await expect(page.getByText("恢复结果尚未确认", { exact: true })).toHaveCount(0);
      await expect(page.getByText("此前恢复的人工检查记录", { exact: true })).toBeVisible();
      await expect(confirmation).toHaveCount(0);
      await expect(restore).toHaveCount(0);
      expect(http.ledger.restores).toBe(1);

      await activate(page, inspect, "Tab");
      await expect.poll(() => http.ledger.previews).toBe(3);
      await expect(page.getByText("文件校验通过", { exact: true })).toBeVisible();
      await expect(confirmation).toHaveValue("");
      await expect(restore).toBeDisabled();
      await tabTo(page, confirmation, "Tab");
      await page.keyboard.insertText(phrase);
      await tabTo(page, restore, "Tab");
      const decisionGeometry = await capture(page, info, "fresh-decision", password, region, restore);
      expect(decisionGeometry).toMatchObject({ focused: true, focusVisible: true, inViewport: true, hit: true });
      http.ledger.secondRestoreAuthorized = true;
      await page.keyboard.press("Enter");
      await expect(page.getByText("已恢复到新数据库，尚未启用", { exact: true })).toBeVisible();
      await expect(page.getByText(`目标：${successTarget}。由运维人员停止服务后选择该数据库启动；当前服务未切换。`, { exact: true })).toBeVisible();
      expect(http.ledger.restores).toBe(2);
      expect(http.ledger.previews).toBe(3);
      expect(await password.inputValue() === "", "Successful restore clears the password").toBe(true);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await capture(page, info, "final-original", password, page.locator("body"),
          page.getByRole("tab", { name: "备份与恢复", exact: true }), false);
      } catch (error) { failures.push(error); }
      try { await http.cleanup(); } catch (error) { failures.push(error); }
      // Independent safe ledger survives a failed screenshot or geometry check.
      try {
        await info.attach("backup-tab-request-ledger", {
          body: JSON.stringify({ width, ...http.ledger,
            scope: "Synthetic App continuity only; no backend restore or complete accessibility acceptance" }, null, 2),
          contentType: "application/json",
        });
        expect(http.ledger.rejected, "All unexpected and off-origin HTTP requests are blocked").toEqual([]);
        expect(http.ledger.pageErrors).toBe(0);
        expect(http.ledger.payloadChecks.every((item) => item.valid)).toBe(true);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Backup continuity task or evidence failed");
  });
}
