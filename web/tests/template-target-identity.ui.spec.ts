import { writeFile } from "node:fs/promises";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./isolated-control-plane-fixture";
import { demoPassword, requireLoopback, signInAPI } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";

// Real built UI, normal CLI and fresh database. Public HTTP seeds duplicate names
// with server-generated IDs. No mocks, private runtime injection, delivery,
// native parser, deployment or traffic claim. Native execution requires sockets.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const sharedName = "同名日常草稿";
const uniqueName = "单独维护草稿";
const templateName = "目标识别验收模板";
const adapter = { adapterId: "mihomo", version: "1.19.32" };

// Read-only painted text inspection, including every clipping ancestor and the
// viewport. Do not scroll/focus the selected result to make this assertion pass.
async function geometry(label: Locator) {
  return label.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const issues: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let fragments = 0;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.width || !rect.height) continue;
        fragments++;
        if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1)
          issues.push("text outside viewport");
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)
          issues.push("text outside label");
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          if (css.textOverflow === "ellipsis" || (css.webkitLineClamp !== "none" && css.webkitLineClamp !== "0")) issues.push("text truncation style");
          if (/hidden|clip|auto|scroll/.test(css.overflowX) && (rect.left < box.left - 1 || rect.right > box.right + 1)) issues.push("horizontal ancestor clipping");
          if (/hidden|clip|auto|scroll/.test(css.overflowY) && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) issues.push("vertical ancestor clipping");
        }
      }
    }
    return { fragments, issues, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}

async function capture(page: Page, info: TestInfo, name: string, surface: Locator, labels: Locator[], ledger: unknown[]) {
  let screenshotError: string | undefined;
  let failed = false;
  try {
    await settledTask(surface);
    const observations = await Promise.all(labels.map(geometry));
    ledger.push({ checkpoint: name, observations });
    for (const observation of observations) {
      expect(observation.fragments).toBeGreaterThan(0);
      expect(observation.issues).toEqual([]);
      expect(observation.horizontalOverflow).toBe(false);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Original viewport PNG even on geometry failure, bounded independently.
    try {
      const path = info.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: false, timeout: 2000 });
      await info.attach(name, { path, contentType: "image/png" });
    } catch (error) {
      screenshotError = error instanceof Error ? error.name : "ScreenshotError";
    }
    ledger.push({ checkpoint: name, screenshotError: screenshotError ?? null });
    try {
      const path = info.outputPath(`${name}-ledger.json`);
      await writeFile(path, JSON.stringify(ledger, null, 2));
      await info.attach(`${name}-ledger`, { contentType: "application/json", path });
    } catch (error) {
      if (!failed) throw error;
    }
  }
  expect(screenshotError, "Native screenshot must be retained").toBeUndefined();
}

for (const width of [1440, 390]) for (const kind of ["processing-preset", "client-profile"] as const) {
  test(`${kind} selects the intended duplicate draft at ${width}x560`, async ({ page, baseURL }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: 560 });
    const ledger: unknown[] = [];
    const writes: { path: string; method: string; body: unknown }[] = [];
    const rejectedTraffic: { method: string; reason: string }[] = [];
    let failed = false;
    try {
      const session = await signInAPI(page.request, "routeweaver", demoPassword);
      const headers = { "X-CSRF-Token": session.csrfToken };
      const resource = kind === "processing-preset" ? "collections" : "profiles";
      const read = async (path: string) => {
        const response = await page.request.get(`/api${path}`);
        expect(response.status()).toBe(200);
        return response.json();
      };
      const ids: string[] = [];
      for (const name of [sharedName, sharedName, uniqueName]) {
        const data = kind === "processing-preset" ? { name, sources: [], steps: [] } : {
          name, target: adapter, mode: "full",
          ir: { schemaVersion: "1.0", endpoints: [], groups: [], rules: [], resources: [], defaultAction: { kind: "direct" }, runtime: { mixedPort: 7890 } },
        };
        const response = await page.request.post(`/api/me/${resource}`, { headers, data });
        expect(response.status()).toBe(200);
        const saved = await response.json();
        expect(saved.id).toMatch(/^r_[A-Za-z0-9_-]{32,}$/);
        ids.push(saved.id);
      }
      expect(new Set(ids).size).toBe(3);
      const spec = kind === "processing-preset"
        ? { steps: [{ id: "rename", enabled: true, kind: "rename", template: "Reviewed {name}" }] }
        : { endpointSlots: [], resourceSlots: [], groups: [], rules: [], defaultAction: { kind: "direct" }, runtime: { mixedPort: 7891 } };
      const published = await page.request.post("/api/admin/templates", { headers, data: { id: "identity-template", name: templateName, kind, expectedVersion: 0, spec } });
      expect(published.status()).toBe(201);
      const template = await published.json();
      const draft = (id: string) => read(`/me/${resource}/${id}${kind === "client-profile" ? "/reveal" : ""}`);
      const before = await Promise.all(ids.map(draft));
      const assertUnchanged = async () => {
        expect(await Promise.all(ids.map(draft))).toEqual(before);
        expect(await read("/me/template-bindings")).toEqual([]);
        expect(writes).toEqual([]);
      };
      // Gate browser traffic after public HTTP setup. Continue ordinary backend
      // responses unchanged; reject off-origin traffic and all unrelated writes.
      const origin = new URL(baseURL!).origin;
      const selectPath = `/api/me/templates/${template.id}/select`;
      await page.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        if (url.origin === origin &&
          (["GET", "HEAD"].includes(method) || (method === "POST" && url.pathname === selectPath && !url.search)))
          return route.continue();
        rejectedTraffic.push({ method, reason: url.origin !== origin ? "off-origin" : "unapproved-write" });
        return route.abort("blockedbyclient");
      });
      // Independent browser request ledger starts after setup, retains failures.
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (new URL(request.url()).origin === origin && path === selectPath && request.method() === "POST") {
          const body = request.postDataJSON();
          writes.push({ path, method: request.method(), body });
        }
      });
      await page.goto("/#templates");
      const open = page.getByRole("article").filter({ has: page.getByRole("heading", { name: templateName, exact: true }) }).getByRole("button", { name: "查看并使用", exact: true });
      await open.click();
      const dialog = page.getByRole("dialog", { name: templateName, exact: true });
      const trigger = dialog.getByRole("combobox", { name: "模板目标", exact: true });
      const search = page.getByRole("combobox", { name: "搜索选项", exact: true });
      const options = page.getByRole("option");
      const openPicker = async () => {
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expect(search).toBeFocused();
      };
      await openPicker();
      await search.fill(sharedName);
      await expect(options).toHaveCount(2);
      // Observe order as displayed, then commit to the second exact ID. Never
      // assume backend sorting of cryptographically generated IDs.
      const secondText = await options.nth(1).innerText();
      const chosenId = ids.find(id => secondText.includes(id));
      expect(chosenId).toBeTruthy();
      expect(ids.slice(0, 2)).toContain(chosenId);
      for (const id of ids.slice(0, 2)) await expect(options.filter({ hasText: id })).toHaveAccessibleName(`${sharedName} ${id}`);
      // cmdk initially highlights the first option; End deterministically chooses
      // the last of the two filtered options using its native keyboard handling.
      await search.press("End");
      await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
      await capture(page, info, `${kind}-${width}-options`, dialog,
        [options.nth(1).getByText(sharedName, { exact: true }), options.nth(1).getByText(chosenId!, { exact: true })], ledger);
      await search.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toHaveText(`${sharedName} ${chosenId}`);
      await capture(page, info, `${kind}-${width}-selected`, dialog,
        [trigger.getByText(sharedName, { exact: true }), trigger.getByText(chosenId!, { exact: true })], ledger);
      await assertUnchanged();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      const discard = page.getByRole("alertdialog", { name: "放弃未应用的模板选择？", exact: true });
      await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
      await expect(discard).toHaveCount(0);
      await expect(trigger).toHaveText(`${sharedName} ${chosenId}`);
      await assertUnchanged();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await discard.getByRole("button", { name: "放弃选择", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await assertUnchanged();
      await open.click();
      await expect(trigger).toHaveText("选择已有草稿");
      await expect(dialog.getByRole("button", { name: "应用模板到草稿", exact: true })).toBeDisabled();
      await openPicker();
      await search.fill(uniqueName);
      await expect(options).toHaveCount(1);
      await expect(options).toHaveAccessibleName(uniqueName);
      await search.press("Enter");
      await expect(trigger).toHaveText(uniqueName);
      await openPicker();
      await search.fill(chosenId!);
      await expect(options).toHaveCount(1);
      await expect(options).toHaveAccessibleName(`${sharedName} ${chosenId}`);
      await search.press("Enter");
      await expect(trigger).toHaveText(`${sharedName} ${chosenId}`);
      await capture(page, info, `${kind}-${width}-id-search-selected`, dialog,
        [trigger.getByText(sharedName, { exact: true }), trigger.getByText(chosenId!, { exact: true })], ledger);
      await assertUnchanged();
      const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/me/templates/${template.id}/select` && value.request().method() === "POST");
      await dialog.getByRole("button", { name: "应用模板到草稿", exact: true }).click();
      expect((await response).status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      expect(writes).toEqual([{ path: `/api/me/templates/${template.id}/select`, method: "POST", body: {
        version: 1, mode: "copy", targetId: chosenId,
        ...(kind === "client-profile" ? { target: adapter } : {}), bindings: { endpoints: {}, resources: {} },
      } }]);
      for (const [index, id] of ids.entries()) {
        const after = await draft(id);
        if (id !== chosenId) expect(after).toEqual(before[index]);
        else if (kind === "processing-preset") {
          // The persisted domain step serializes zero-valued Filter/Override
          // structs as empty objects, unlike the raw template seed above.
          expect(after.steps).toEqual([{ id: "rename", enabled: true, kind: "rename", template: "Reviewed {name}", filter: {}, override: {} }]);
        }
        else expect(after.ir.runtime.mixedPort).toBe(7891);
      }
      const bindings = await read("/me/template-bindings");
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ templateId: template.id, targetId: chosenId, mode: "copy", appliedVersion: 1 });
      expect(rejectedTraffic, "No rejected off-origin requests or unrelated writes").toEqual([]);
      ledger.push({ completed: true, chosenId, kind, viewport: { width, height: 560 }, siblingDraftsUnchanged: 2 });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        const path = info.outputPath(`${kind}-${width}-final-state.png`);
        await page.screenshot({ path, fullPage: false, timeout: 2000 });
        await info.attach("template-target-final-state", { path, contentType: "image/png" });
      } catch (error) {
        ledger.push({ finalScreenshotError: error instanceof Error ? error.name : "ScreenshotError" });
      }
      // Attach independently of capture so early setup/interaction failures keep
      // their request boundary evidence too. No tokens or feed URLs are recorded.
      try {
        const path = info.outputPath("template-target-identity-ledger.json");
        await writeFile(path, JSON.stringify({ ledger, writes, rejectedTraffic }, null, 2));
        await info.attach("template-target-identity-ledger", { contentType: "application/json", path });
        expect(rejectedTraffic, "No rejected browser traffic, including late requests").toEqual([]);
      } catch (error) {
        // Artifact failures must not replace the original interaction failure.
        if (!failed) throw error;
      }
    }
  });
}
