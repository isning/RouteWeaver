import type { Locator, Page, TestInfo } from "@playwright/test";
import type { PublishedRoute } from "../src/PublishedRoutes";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";

// Production-built App, synthetic HTTP outcomes only. The simulated commit is
// NOT persistence evidence. No API request is forwarded to the isolated server.
// Browser execution belongs to CI; discovery/typechecking are not acceptance.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off" });
const name = "待核对的办公线路";
const instance = { id: "recovery-core", hostId: "recovery-host", name: "办公核心",
  adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
const listener = { id: "recovery-entry", name: "办公入口", instanceId: instance.id,
  authentication: "principals", connection: { protocol: "vless", host: "0.0.0.0", port: 24443 } };
const deployment = { id: "recovery-path", name: "办公转发路径", status: "draft", diagnostics: [],
  ir: { schemaVersion: "1.0", id: "recovery-path", topologyRevision: "synthetic-r1",
    programs: [{ instance, listener, rules: [], resources: [], egress: [] }] } };

async function capture(page: Page, surface: Locator, info: TestInfo, label: string) {
  await settledTask(surface);
  await expect(surface).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await surface.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  const path = info.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(label, { path, contentType: "image/png" });
}

for (const width of [390, 1440]) for (const resolution of ["matching", "different"] as const) {
  test(`new route lost response retains recovery across close and ${resolution} read at ${width}px`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    let submitted: PublishedRoute | undefined;
    let saved: PublishedRoute | undefined;
    let resolveReads = 0;
    const writes: string[] = [], unexpected: string[] = [], errors: string[] = [];
    const reads: Record<string, unknown> = {
      "/api/auth/me": { user: { id: "recovery-admin", username: "review-admin", name: "Review admin", role: "admin" }, csrfToken: "synthetic-csrf" },
      "/api/hosts": [{ id: instance.hostId, name: "办公服务器", address: "127.0.0.1" }],
      "/api/core-instances": [instance], "/api/managed-endpoints": [listener],
      "/api/links": [], "/api/server-deployments": [deployment],
      "/api/services": [],
    };
    page.on("pageerror", error => errors.push(error.name));
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      // Never retain an unexpected URL, query, path or body in the evidence.
      const reject = async (reason: string) => { unexpected.push(reason); await route.abort("blockedbyclient"); };
      if (url.origin !== origin) return reject("external request redacted");
      if (url.search) return reject("unexpected query redacted");
      if (!url.pathname.startsWith("/api/")) {
        if (method === "GET" && (url.pathname === "/" || /^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname) || url.pathname === "/favicon.ico"))
          return route.continue();
        return reject("unexpected static request redacted");
      }
      const path = url.pathname;
      if (method === "POST" && path === "/api/published-routes/preview") {
        writes.push("POST preview (simulated)");
        return route.fulfill({ json: { ...request.postDataJSON(), status: "draft", diagnostics: [] } });
      }
      if (method === "POST" && path === "/api/published-routes") {
        writes.push("POST create (simulated)");
        // Published-route POST is create-only at the backend method boundary;
        // this API does not use the collections/sources If-None-Match header.
        expect(request.headers()["if-none-match"]).toBeUndefined();
        expect(request.headers()["if-match"]).toBeUndefined();
        expect(writes.filter(value => value === "POST create (simulated)")).toHaveLength(1);
        submitted = request.postDataJSON() as PublishedRoute;
        expect(submitted).toMatchObject({ name, deploymentId: deployment.id,
          endpointIds: [listener.id], publicHost: "127.0.0.1", publicPort: 24443 });
        saved = { ...submitted, revisionToken: "synthetic-created-revision", status: "draft", diagnostics: [],
          savedPath: { hops: [{ kind: "managed", endpointId: listener.id, name: listener.name, metadataState: "snapshot" }] }, effective: null };
        if (resolution === "different") saved = { ...saved, name: "另一处修改的办公线路", publicPort: 25443 };
        return route.abort("failed"); // Simulate committed-but-lost receipt, never send a write.
      }
      if (method !== "GET") return reject("unexpected API mutation redacted");
      if (path === "/api/published-routes") return route.fulfill({ json: saved ? [saved] : [] });
      if (saved && path === `/api/published-routes/${saved.id}/resolve`) {
        resolveReads++;
        return route.fulfill({ json: saved });
      }
      if (path === "/api/state") return route.fulfill({ json: { users: [], services: [], routes: [], publishedRoutes: saved ? [saved] : [] } });
      if (Object.hasOwn(reads, path)) return route.fulfill({ json: reads[path] });
      return reject("unexpected API read redacted");
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#published-routes");
      await page.getByRole("button", { name: "配置公开线路", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "配置公开线路", exact: true });
      await editor.getByRole("textbox", { name: "线路名称", exact: true }).fill(name);
      await editor.getByRole("combobox", { name: "服务器转发路径", exact: true }).click();
      await page.getByRole("option", { name: deployment.name, exact: true }).click();
      await editor.getByRole("button", { name: "检查公开线路", exact: true }).click();
      const readyTitle = editor.getByText("路径检查完成", { exact: true });
      const readyCopy = editor.getByText("可以保存线路身份；分配用户和节点应用仍是后续独立步骤。", { exact: true });
      await expect(readyTitle).toBeVisible();
      await expect(readyCopy).toBeVisible();
      const assertFrozenRecovery = async () => {
        // Text locators include the inert draft; obsolete save-ready copy must
        // be removed, not merely hidden from the accessibility tree.
        await expect(readyTitle).toHaveCount(0);
        await expect(readyCopy).toHaveCount(0);
        await expect(editor.getByText("线路保存结果尚未确认", { exact: true })).toBeVisible();
        await expect(editor.getByRole("button", { name: "核对保存结果", exact: true })).toBeVisible();
        await expect(editor.locator("label").filter({ hasText: /^\s*线路名称\s*$/ }).locator("input")).toHaveValue(name);
        await expect(editor.locator("label").filter({ hasText: /^\s*服务器转发路径/ }).locator('[role="combobox"]')).toContainText(deployment.name);
        await expect(editor.locator("label").filter({ hasText: /^\s*对外域名或 IP\s*$/ }).locator("input")).toHaveValue("127.0.0.1");
        await expect(editor.locator("label").filter({ hasText: /^\s*对外端口\s*$/ }).locator("input")).toHaveValue("24443");
      };
      await editor.getByRole("button", { name: "保存公开线路", exact: true }).click();
      await expect(editor.getByText("线路保存结果尚未确认", { exact: true })).toBeVisible();
      await assertFrozenRecovery();
      expect(resolveReads).toBe(0);
      const originalID = submitted!.id;
      await capture(page, editor, info, `route-create-unknown-${resolution}-${width}`);
      await editor.getByRole("button", { name: "稍后核对", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(page.getByText(`「${name}」的保存结果尚未确认`, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "核对保存结果", exact: true }).click();
      await expect(editor).toBeVisible();
      await assertFrozenRecovery();
      // Inert fields remain visible but leave the accessibility tree during recovery.
      const field = editor.locator("label").filter({ hasText: /^\s*线路名称\s*$/ }).locator("input");
      await expect(field).toHaveValue(name);
      await expect(editor.locator("[inert]")).toHaveCount(1);
      await expect(editor.locator("label").filter({ hasText: /^\s*对外端口\s*$/ }).locator("input")).toHaveValue("24443");
      await expect(editor.getByRole("button", { name: "保存公开线路", exact: true })).toHaveCount(0);
      await expect(editor.getByRole("button", { name: "检查公开线路", exact: true })).toHaveCount(0);
      expect(resolveReads).toBe(0);
      await editor.getByRole("button", { name: "核对保存结果", exact: true }).click();
      if (resolution === "matching") {
        const detail = page.getByRole("dialog", { name, exact: true });
        await expect(detail.getByText("线路已保存", { exact: true })).toBeVisible();
        await expect(detail.getByText("草稿已保存，尚未确认应用", { exact: true })).toBeVisible();
        await expect(detail.getByLabel("已确认路径", { exact: true })).toHaveCount(0);
        await expect(detail.getByLabel("已保存路径", { exact: true })).toContainText(listener.name);
        await capture(page, detail, info, `route-create-reconciled-${width}`);
      } else {
        await expect(editor.getByText("此身份已有不同的线路内容。无法据此确认先前保存结果；当前提交内容已保留，不会覆盖已有线路。", { exact: true })).toBeVisible();
        const end = editor.getByRole("button", { name: "结束本次核对…", exact: true });
        await end.click();
        const decision = page.getByRole("alertdialog", { name: `结束「${name}」的保存核对？`, exact: true });
        await expect(decision.getByText("这只会放弃本页保留的提交内容，不会撤销已经提交或保存的线路。再次创建前请先核对线路列表。", { exact: true })).toBeVisible();
        const cancel = decision.getByRole("button", { name: "继续核对", exact: true });
        await expect(cancel).toBeFocused();
        await capture(page, decision, info, `route-create-end-decision-${width}`);
        await cancel.click();
        await expect(decision).toHaveCount(0);
        await expect(end).toBeFocused();
        await expect(field).toHaveValue(name);
        await end.click();
        await decision.getByRole("button", { name: "结束核对并返回", exact: true }).click();
        await expect(editor).toHaveCount(0);
        await expect(page.getByText(`「${name}」的保存结果尚未确认`, { exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: saved!.name, exact: true })).toBeVisible();
      }
      expect(submitted!.id).toBe(originalID);
      expect(resolveReads).toBeGreaterThanOrEqual(1);
      expect(writes).toEqual(["POST preview (simulated)", "POST create (simulated)"]);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await info.attach(`route-create-recovery-scope-${resolution}-${width}`, { contentType: "application/json", body: JSON.stringify({
        width, resolution, writes, resolveReads, unexpected, errors,
        scope: "Production-built App with simulated API outcomes. No API forwarded; no real persistence, deployment, runtime application or traffic evidence. Local close/reopen only, not reload durability.",
      }, null, 2) });
    }
  });
}
