import { writeFile } from "node:fs/promises";
import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { historyLegacyFixtures } from "./history-legacy-fixture";
import { surfaceMotionState } from "./ui-surface-stability";

// Real App/ConnectionFields with synthetic HTTP authentication and inventory.
// No backend, deployment, live credentials or native execution claim.
test.use({ serviceWorkers: "block", trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });
const endpoint = { id: "keyboard-endpoint", instanceId: "keyboard-core", name: "键盘测试端点", connection: { protocol: "socks", host: "0.0.0.0", port: 1080 } };
const fixtures: Record<string, unknown> = {
  ...historyLegacyFixtures,
  "/state": { nodes: [], users: [], routes: [], revisions: [], capabilities: [] },
  "/hosts": [{ id: "keyboard-host", name: "键盘测试服务器", address: "keyboard.example" }],
  "/core-instances": [{ id: "keyboard-core", hostId: "keyboard-host", name: "键盘测试核心", adapterId: "routeweaver/xray", version: "26.3.27" }],
  "/managed-endpoints": [endpoint],
  // Edit reads the complete ManagedEndpoint directly, not an envelope.
  "/managed-endpoints/keyboard-endpoint/reveal": { ...endpoint, revisionToken: "synthetic-keyboard-revision" },
  "/links": [], "/server-deployments": [], "/me/inbox": [],
};
type Entry = { method: string; target: string; outcome: "fixture" | "blocked" };

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 40; step++) {
    if (await target.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target, "Target must be reachable by ordinary Tab").toBeFocused();
}
async function background(page: Page) {
  return page.locator(".route-content").evaluate(content => {
    const ancestors = [];
    for (let el: HTMLElement | null = content as HTMLElement; el; el = el.parentElement)
      ancestors.push({ x: el.scrollLeft, y: el.scrollTop });
    return { x: scrollX, y: scrollY, ancestors };
  });
}

async function capture(page: Page, info: TestInfo, phase: string, requests: Entry[]) {
  const png = info.outputPath(`${phase}.png`);
  const json = info.outputPath(`${phase}.json`);
  const deadline = Date.now() + 2000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Compact picker capture exceeded 2 seconds");
    return ms;
  };
  // Original current viewport, without scrolling, focusing, DOM edits or crops.
  await page.screenshot({ path: png, timeout: remaining() });
  const observation = await page.locator("body").evaluate(() => {
    const list = [...document.querySelectorAll('[role="listbox"]')].find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.closest('[inert], [aria-hidden="true"]');
    });
    const inspect = (el: Element) => {
      const r = el.getBoundingClientRect();
      let left = Math.max(0, r.left), top = Math.max(0, r.top);
      let right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (/hidden|clip|auto|scroll/.test(css.overflowX)) { left = Math.max(left, box.left + parent.clientLeft); right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth); }
        if (/hidden|clip|auto|scroll/.test(css.overflowY)) { top = Math.max(top, box.top + parent.clientTop); bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight); }
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        unclipped: r.width > 0 && r.height > 0 && left <= r.left + 1 && top <= r.top + 1 && right >= r.right - 1 && bottom >= r.bottom - 1,
        unobscured: !!hit && (el.contains(hit) || (el.getAttribute("aria-disabled") === "true" && !!list?.contains(hit) && hit.contains(el))),
      };
    };
    const css = list ? getComputedStyle(list) : null;
    const active = list?.getAttribute("aria-activedescendant");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      list: list ? {
        ...inspect(list), focused: document.activeElement === list,
        focusVisible: list.matches(":focus-visible"),
        // Only computed visual properties, never field values or page text.
        ring: css?.boxShadow ?? "none",
        activeOptionSelected: !!active && document.getElementById(active)?.getAttribute("aria-selected") === "true",
        choices: [...list.querySelectorAll('[role="option"]')].map(inspect),
      } : null,
    };
  }, undefined, { timeout: remaining() });
  await writeFile(json, JSON.stringify({ scope: "synthetic HTTP UI, no backend evidence", phase, observation, requests }, null, 2));
  // Persist both originals before either attachment or geometry assertion.
  await info.attach(phase, { path: png, contentType: "image/png" });
  await info.attach(`${phase}-geometry`, { path: json, contentType: "application/json" });
  return observation;
}

for (const width of [1440, 390]) {
  test(`compact endpoint pickers support keyboard tasks at ${width}x560`, async ({ page, baseURL }, info) => {
    const requests: Entry[] = [];
    let originalError: unknown;
    let failed = false;
    try {
      if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("Compact picker journey requires loopback");
      const origin = new URL(baseURL).origin;
      await page.setViewportSize({ width, height: 560 });
      await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && request.method() === "GET" && !url.pathname.startsWith("/api/")) return route.continue();
        const key = url.pathname.slice(4);
        const allowed = url.origin === origin && request.method() === "GET" && !url.search && Object.hasOwn(fixtures, key);
        requests.push({ method: request.method(), target: allowed ? key : "unexpected", outcome: allowed ? "fixture" : "blocked" });
        return allowed ? route.fulfill({ json: fixtures[key] }) : route.abort();
      });
      await page.goto("/#servers");
      await page.getByRole("tab", { name: "监听端点 1", exact: true }).click();
      await page.getByRole("group", { name: "键盘测试端点 的操作", exact: true }).getByRole("button", { name: "编辑", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "编辑监听端点", exact: true });
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.evaluate(surfaceMotionState)).toEqual({ opacity: "1", preparing: false, running: false });
      const initialBackground = await background(page);
      const protocol = dialog.getByRole("combobox", { name: "协议", exact: true });
      const transport = dialog.getByRole("combobox", { name: "传输方式", exact: true });
      const assertPicker = async (name: string, selected: string, phase: string) => {
        const list = page.getByRole("listbox", { name, exact: true });
        const option = list.getByRole("option", { name: selected, exact: true });
        await expect(list).toBeFocused();
        await expect(option).toHaveAttribute("aria-selected", "true");
        await expect(list).toHaveAttribute("aria-activedescendant", (await option.getAttribute("id"))!);
        const popup = list.locator('xpath=ancestor::*[@data-slot="popover-content"][1]');
        await expect.poll(() => popup.evaluate(surfaceMotionState)).toEqual({ opacity: "1", preparing: false, running: false });
        const evidence = await capture(page, info, phase, requests);
        expect(evidence.horizontalOverflow).toBe(false);
        expect(evidence.list).not.toBeNull();
        expect(evidence.list!.focused && evidence.list!.focusVisible && evidence.list!.activeOptionSelected).toBe(true);
        expect(evidence.list!.ring).not.toBe("none");
        expect(evidence.list!.unclipped && evidence.list!.unobscured).toBe(true);
        expect(evidence.list!.choices.length).toBeGreaterThan(0);
        for (const choice of evidence.list!.choices) expect(choice.unclipped && choice.unobscured).toBe(true);
        expect(await background(page)).toEqual(initialBackground);
      };
      await tabTo(page, protocol);
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await assertPicker("协议", "Shadowsocks", "protocol-cancel");
      await page.keyboard.press("Escape");
      await expect(protocol).toBeFocused();
      await expect(protocol).toHaveText("SOCKS5");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await assertPicker("协议", "VLESS", "protocol-settled-reopen");
      await page.keyboard.press("Enter");
      await expect(protocol).toHaveText("VLESS");
      await expect(protocol).toBeFocused();
      await tabTo(page, transport);
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await assertPicker("传输方式", "WebSocket", "transport-cancel");
      await page.keyboard.press("Escape");
      await expect(transport).toBeFocused();
      await expect(transport).toHaveText("TCP");
      // Xray + REALITY is the actual reachable production condition which
      // disables WebSocket/HTTP Upgrade, rather than injected component props.
      await dialog.getByRole("radio", { name: "REALITY", exact: true }).click();
      await tabTo(page, transport);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("option", { name: "WebSocket", exact: true })).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("option", { name: "HTTP Upgrade", exact: true })).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("ArrowDown");
      await assertPicker("传输方式", "gRPC", "transport-disabled-skip");
      await page.keyboard.press("Enter");
      await expect(transport).toHaveText("gRPC");
      await expect(transport).toBeFocused();
      // Confirming an already-selected non-first value must not rewrite it.
      // Reopening after cancel must discard the uncommitted keyboard highlight.
      for (const choice of [
        { trigger: protocol, name: "协议", current: "VLESS", next: "Trojan", key: "ArrowDown" },
        { trigger: transport, name: "传输方式", current: "gRPC", next: "TCP", key: "ArrowUp" },
      ]) {
        await tabTo(page, choice.trigger);
        await page.keyboard.press("Enter");
        const list = page.getByRole("listbox", { name: choice.name, exact: true });
        const current = list.getByRole("option", { name: choice.current, exact: true });
        await expect(list).toBeFocused();
        await expect(current).toHaveAttribute("aria-selected", "true");
        await expect(list).toHaveAttribute("aria-activedescendant", (await current.getAttribute("id"))!);
        await page.keyboard.press("Enter");
        await expect(choice.trigger).toHaveText(choice.current);
        await expect(choice.trigger).toBeFocused();
        await page.keyboard.press("Enter");
        await page.keyboard.press(choice.key);
        await expect(list.getByRole("option", { name: choice.next, exact: true })).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Escape");
        await expect(choice.trigger).toHaveText(choice.current);
        // Click the actual trigger without imposing an exit-animation wait.
        // This remains valid whether Radix retains or remounts the content.
        await choice.trigger.click();
        await expect(list).toBeFocused();
        await expect(current).toHaveAttribute("aria-selected", "true");
        await expect(list).toHaveAttribute("aria-activedescendant", (await current.getAttribute("id"))!);
        await page.keyboard.press("Enter");
        await expect(choice.trigger).toHaveText(choice.current);
        await expect(choice.trigger).toBeFocused();
      }
      await expect(protocol).toHaveText("VLESS");
      await expect(dialog.getByRole("spinbutton", { name: "端口", exact: true })).toHaveValue("1080");
      expect(await background(page)).toEqual(initialBackground);
      expect(requests.filter(entry => entry.outcome === "blocked")).toEqual([]);
      expect(requests.every(entry => entry.method === "GET")).toBe(true);
    } catch (error) {
      failed = true;
      originalError = error;
    } finally {
      try {
        await capture(page, info, "final-state", requests);
      } catch (captureError) {
        if (!failed) { failed = true; originalError = captureError; }
        const path = info.outputPath("capture-failure.json");
        let saved = false;
        try {
          await writeFile(path, JSON.stringify({ capture: "failed-or-timed-out", requests }, null, 2));
          saved = true;
        } catch { /* Evidence failure must not replace the original task error. */ }
        if (saved) {
          try {
            await info.attach("capture-failure", { path, contentType: "application/json" });
          } catch { /* The persisted ledger remains available without attachment. */ }
        }
      }
    }
    if (failed) throw originalError;
    // Include requests arriving during final evidence capture in the success gate.
    expect(requests.filter(entry => entry.outcome === "blocked")).toEqual([]);
    expect(requests.every(entry => entry.method === "GET")).toBe(true);
  });
}
