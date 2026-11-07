import { writeFile } from "node:fs/promises";
import type { APIRequestContext, Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { headers, read, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// A real normal-CLI database owns each journey. Only the first committed create
// response is lost. Later lookup faults are explicitly injected transport data,
// never evidence about the actual persisted record. No stage is ever executed.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const base = "/api/admin/fleet-batches";
const names = { path: "办公转发路径", core: "办公核心", host: "本地计划服务器" };
async function seed(client: APIRequestContext) {
  const h = await headers(client);
  const host = { id: "creation-host", name: names.host, address: "127.0.0.1" };
  const instance = { id: "creation-core", name: names.core, hostId: host.id,
    adapterId: "routeweaver/xray", version: "26.10.31" };
  const listener = { id: "creation-entry", name: "本地参考入口", instanceId: instance.id,
    connection: { protocol: "socks", host: "127.0.0.1", port: 23550,
      username: "fixture", password: "synthetic-fleet-password" } };
  const deployment = { id: "creation-path", name: names.path,
    ir: { id: "creation-path", schemaVersion: "1.0", topologyRevision: "initial", programs: [{ instance, listener }] } };
  for (const [path, data] of [
    ["/hosts", host], ["/core-instances", instance], ["/managed-endpoints", listener],
    ["/agent/enrollments", { nodeId: host.id, instanceId: instance.id,
      expiresAt: new Date(Date.now() + 3600000).toISOString() }],
    ["/server-deployments", deployment],
  ] as const) {
    const response = await client.post(`/api${path}`, { headers: h, data });
    // Enrollment responses contain synthetic secrets; never emit their bodies.
    expect(response.ok(), `Create isolated fixture ${path}`).toBe(true);
  }
  return { instance, deployment };
}
async function capture(page: Page, info: TestInfo, surface: Locator, name: string) {
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`fleet-creation-recovery-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(`fleet-creation-recovery-${name}`, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test(`a lost committed Fleet create recovers exactly one unexecuted batch at ${width}`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, baseURL, "admin");
    const { instance, deployment } = await seed(page.request);
    const actor = (await read(page.request, "/auth/me")).user.id as string;
    const storageKey = `routeweaver.fleet-creation.v1:${actor}`;
    const saved = () => page.evaluate((key) => sessionStorage.getItem(key), storageKey);
    const writes: { body: string; condition: string | null; status: number }[] = [];
    const mutations: string[] = [], rejectedMutations: string[] = [];
    let batchId = "";
    let readFault: "none" | "missing" | "identity" = "none";
    const readStatuses: number[] = [];
    await page.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      expect(url.origin).toBe(new URL(baseURL!).origin);
      const method = request.method(), path = url.pathname;
      if (!["GET", "HEAD"].includes(method)) {
        mutations.push(`${method} ${path}`);
        if (method !== "POST" || ![base, `${base}/preview`].includes(path)) {
          rejectedMutations.push(`${method} ${path}`);
          await route.abort("blockedbyclient"); return;
        }
      }
      if (method === "POST" && path === base) {
        const body = request.postData()!;
        const condition = await request.headerValue("if-none-match");
        const response = await route.fetch(); // The actual HTTP commit completes first.
        writes.push({ body, condition, status: response.status() });
        if (writes.length === 1) {
          expect(response.status()).toBe(201);
          batchId = (await response.json()).id;
          await route.abort("failed"); return; // Lose only the real committed response.
        }
        await route.fulfill({ response }); return;
      }
      if (method === "GET" && batchId && path === `${base}/${batchId}` && readFault !== "none") {
        const fault = readFault; readFault = "none";
        if (fault === "missing") {
          readStatuses.push(404);
          await route.fulfill({ status: 404, json: { detail: "Synthetic lookup response unavailable" } }); return;
        }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        readStatuses.push(200);
        await route.fulfill({ response, json: { ...await response.json(), actorId: "unrelated-actor" } }); return;
      }
      await route.continue();
    });
    await page.goto("/#fleet");
    await page.getByRole("button", { name: "计划变更", exact: true }).click();
    let sheet = page.getByRole("dialog", { name: "计划批量变更", exact: true });
    await sheet.getByRole("combobox", { name: "批量变更转发路径", exact: true }).click();
    await page.getByRole("option", { name: names.path, exact: true }).click();
    await sheet.getByRole("checkbox", { name: `选择实例 ${names.core}`, exact: true }).check();
    await sheet.getByRole("button", { name: "预览影响与差异", exact: true }).click();
    await sheet.getByRole("checkbox", { name: "我已核对实例、阶段与影响范围", exact: true }).check();
    await sheet.getByRole("button", { name: "创建待执行批次", exact: true }).click();
    sheet = page.getByRole("dialog", { name: "核对批次创建结果", exact: true });
    await expect(sheet.getByText("创建结果尚未确认，批次可能已创建。请先查询该次结果。", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "创建待执行批次", exact: true })).toHaveCount(0);
    const original = await saved();
    expect(original).not.toBeNull();
    const envelope = JSON.parse(original!);
    expect(envelope.batchId).toBe(batchId);
    expect(envelope.actorId).toBe(actor);
    expect(envelope.request.deploymentId).toBe(deployment.id);
    expect(original).not.toContain("synthetic-fleet-password");
    expect(original).not.toContain("csrf");
    const assertUnexecuted = async () => {
      const batches = await read(page.request, "/admin/fleet-batches");
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ id: batchId, status: "planned", actorId: actor, deploymentId: deployment.id });
      expect(batches[0].targets).toHaveLength(1);
      expect(batches[0].targets[0]).toMatchObject({ instanceId: instance.id, status: "planned", attempts: [] });
      const state = await read(page.request, `/agent/instances/${instance.id}/state`);
      expect(state.desired).toBeUndefined();
      expect(state.state?.observed).toBeUndefined();
    };
    await assertUnexecuted();
    await capture(page, info, sheet, `unknown-${width}`);

    // Cancellation returns to the same recovery task. The short decision retains
    // its actual consequences and both actions, with ordinary motion enabled.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) await page.setViewportSize({ width, height: 560 });
      const abandon = sheet.getByRole("button", { name: "放弃本页恢复记录", exact: true });
      await abandon.click();
      const decision = page.getByRole("alertdialog", { name: "放弃核对这次创建？", exact: true });
      await settledTask(decision);
      await expect(decision.getByText(/不会删除服务器上的批次/)).toBeInViewport({ ratio: 1 });
      const cancel = decision.getByRole("button", { name: "继续核对", exact: true });
      await expect(cancel).toBeInViewport({ ratio: 1 });
      await expect(decision.getByRole("button", { name: "放弃恢复记录", exact: true })).toBeInViewport({ ratio: 1 });
      if (attempt === 1) await capture(page, info, decision, `short-decision-${width}`);
      await cancel.click();
      await expect(decision).toHaveCount(0);
      await expect(abandon).toBeFocused();
      expect(await saved()).toBe(original);
    }
    await page.setViewportSize({ width, height: 900 });
    await sheet.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText("有批次创建结果待核对", { exact: true })).toBeVisible();
    await expect(page.getByText("暂无批量变更", { exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "继续核对创建结果", exact: true }).click();
    sheet = page.getByRole("dialog", { name: "核对批次创建结果", exact: true });
    expect(await saved()).toBe(original);
    expect(writes).toHaveLength(1);

    readFault = "missing";
    await sheet.getByRole("button", { name: "查询该次结果", exact: true }).click();
    await expect(sheet.getByText("尚未查到该批次，创建结果仍未确认。可再次查询，或用同一份计划重试创建。", { exact: true })).toBeVisible();
    expect(await saved()).toBe(original);
    readFault = "identity";
    await sheet.getByRole("button", { name: "查询该次结果", exact: true }).click();
    await expect(sheet.getByText("创建结果尚未确认，批次可能已创建。请先查询该次结果。", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "查看批次进度", exact: true })).toHaveCount(0);
    expect(await saved()).toBe(original);
    await sheet.getByRole("button", { name: "用同一计划重试创建", exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(sheet.getByRole("button", { name: "查询该次结果", exact: true })).toBeEnabled();
    expect(writes[1].status).toBe(412); // Real occupied-ID response, not a mock.
    expect(writes[1].body).toBe(writes[0].body);
    expect(writes.map((write) => write.condition)).toEqual(["*", "*"]);
    expect(await saved()).toBe(original);
    await assertUnexecuted();

    await sheet.getByRole("button", { name: "查询该次结果", exact: true }).click();
    await expect(sheet.getByText("批次已创建", { exact: true })).toBeVisible();
    await expect(sheet.getByText("当前记录：尚未执行。查看进度不会开始执行。", { exact: true })).toBeVisible();
    expect(await saved()).toBe(original); // A lookup is not an implicit dismissal.
    await capture(page, info, sheet, `recovered-${width}`);
    await sheet.getByRole("button", { name: "查看批次进度", exact: true }).click();
    await expect.poll(saved).toBeNull();
    await expect(page.getByRole("dialog", { name: "批量变更进度", exact: true })).toBeVisible();
    await assertUnexecuted();
    expect(rejectedMutations).toEqual([]);
    expect(mutations).toEqual([`POST ${base}/preview`, `POST ${base}`, `POST ${base}`]);
    const evidence = { width, batchId, deploymentId: deployment.id, targetId: instance.id,
      realCreateStatuses: writes.map((write) => write.status), exactGuardedRetry: true,
      injectedLookupResponses: [{ status: readStatuses[0], fault: "missing" }, { status: readStatuses[1], fault: "actor-mismatch" }],
      realRecoveredStatus: "planned", persistedBatchCount: 1, attemptCount: 0,
      desiredStateAbsent: true, observedStateAbsent: true, cancelledAbandonments: 2,
      preservedAcrossCloseAndReload: true, mutations, prohibitedMutationCount: rejectedMutations.length,
      scope: "Real isolated HTTP persistence and browser recovery; no execution or runtime application" };
    const path = info.outputPath(`fleet-creation-recovery-evidence-${width}.json`);
    await writeFile(path, JSON.stringify(evidence, null, 2));
    await info.attach(`fleet-creation-recovery-evidence-${width}`, { path, contentType: "application/json" });
  });
}
