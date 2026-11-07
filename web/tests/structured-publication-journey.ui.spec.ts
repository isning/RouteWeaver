import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Locator, Page } from "@playwright/test";
import type { Preview, Profile } from "../src/types";
import { test as isolatedTest, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
import { digest, structuredNames as names, structuredPublicationFixture } from "./structured-publication-backend";

// Public fixture teardown runs before its owning context teardown. Closing only
// this journey's page prevents Playwright's automatic failure ARIA snapshot from
// retaining bearer input values/hrefs. Explicit masked originals, proof, errors
// and stacks remain available; unrelated browser tests are unaffected.
const test = isolatedTest.extend({
  page: async ({ page }, use) => {
    try { await use(page); }
    finally { await page.close(); }
  },
});

const responseFor = (page: Page, path: string, method = "POST") =>
  page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
async function choose(page: Page, control: Locator, label: string, multiple = false) {
  await control.click();
  const id = await control.getAttribute("aria-controls");
  const popup = page.locator(`[id="${id}"]`)
    .locator('xpath=ancestor-or-self::*[@data-slot="popover-content"]');
  await popup.getByRole("option").getByText(label, { exact: true }).click();
  if (multiple) await page.keyboard.press("Escape");
  await expect(control).toHaveAttribute("aria-expanded", "false");
}
async function uncovered(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || !!hit && element.contains(hit);
  }), "The decision control is not covered").toBe(true);
}
// Locator matchers, focus(), inputValue() and scrollIntoViewIfNeeded() can put
// a resolved input/anchor preview into failed-step logs. Inspect the real access
// controls through page.evaluate instead, returning only Boolean observations.
// No bearer value is sent as an argument or returned to the test runner.
async function accessDeliveryObservation({ expectedPathDigest, prepareDownload = false }: {
  expectedPathDigest: string; prepareDownload?: boolean;
}) {
  const empty = { inputVisible: false, linkMatches: false, downloadMatches: false, downloadReady: false };
  try {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="订阅链接"]');
    const dialog = input?.closest('[role="dialog"]');
    const download = [...(dialog?.querySelectorAll<HTMLAnchorElement>('a[download]') || [])]
      .find((link) => link.textContent?.trim() === "下载配置");
    if (!input || !download) return empty;
    const inputBox = input.getBoundingClientRect();
    const inputVisible = inputBox.width > 0 && inputBox.height > 0 &&
      !input.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(input).visibility === "visible";
    const url = new URL(input.value);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.pathname));
    const pathDigest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const linkMatches = url.origin === location.origin && pathDigest === expectedPathDigest;
    const downloadMatches = download.href === input.value;
    if (prepareDownload) {
      download.scrollIntoView({ block: "center", inline: "nearest" });
      download.focus({ preventScroll: true });
    }
    const box = download.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = download.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        left = Math.max(left, bounds.left + parent.clientLeft);
        right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        top = Math.max(top, bounds.top + parent.clientTop);
        bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
      }
    }
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const downloadReady = box.width > 0 && box.height > 0 &&
      box.left >= left - 1 && box.right <= right + 1 && box.top >= top - 1 && box.bottom <= bottom + 1 &&
      (hit === download || !!hit && download.contains(hit)) && document.activeElement === download;
    return { inputVisible, linkMatches, downloadMatches, downloadReady };
  } catch {
    // A malformed href/value or page state must not become an error containing it.
    return empty;
  }
}
function retainedIntent(profile: Profile, tun: boolean) {
  // Configuration values stay out of matcher failure diagnostics, even if a
  // future regression unexpectedly materializes credential-bearing input.
  expect(profile.ir.groups.length, "One structured group is retained").toBe(1);
  const group = profile.ir.groups[0];
  expect(group.name === names.group && group.kind === "manual" &&
    isDeepStrictEqual(group.members, [{ kind: "direct" }]), "Group name, strategy and direct member are retained").toBe(true);
  expect(profile.ir.rules.length, "One structured rule is retained").toBe(1);
  expect(isDeepStrictEqual(profile.ir.rules[0].match, { op: "domain-suffix", value: names.domain }) &&
    isDeepStrictEqual(profile.ir.rules[0].action, { kind: "group", ref: group.id }),
    "The domain rule keeps its selected group").toBe(true);
  const dns = profile.ir.runtime.dns;
  expect(dns?.servers.length, "One DNS resolver is retained").toBe(1);
  expect(dns?.servers[0].type === "tls" && dns.servers[0].address === "192.0.2.53" &&
    dns.servers[0].port === 853 && dns.final === dns.servers[0].id,
    "DNS settings retain the explicitly selected resolver").toBe(true);
  expect(profile.ir.runtime.sniff, "Sniff remains enabled").toBe(true);
  expect(isDeepStrictEqual(profile.ir.runtime.tun, { enabled: tun, addresses: ["172.19.0.1/30"], autoRoute: true }),
    "TUN settings match the explicit user choice").toBe(true);
  expect(profile.target.adapterId).toBe("sing-box");
}

// Normal isolated CLI, invited ordinary tenant, public UI and real persistence.
// Only one successful read response is deliberately dropped at the browser
// transport seam. No fake backend response, native client, DNS lookup or traffic.
test.use({ trace: "off", screenshot: "off", video: "off", hasTouch: true });
for (const width of [1440, 390]) {
  test(`structured editor retains incompatible intent until explicit correction and chosen publication at ${width}`, async ({
    page, playwright, baseURL,
  }, info) => {
    test.setTimeout(90000); // One complete edit/reject/correct/review/delivery task.
    requireLoopback(baseURL);
    const height = width === 390 ? 844 : 1000;
    await page.setViewportSize({ width, height });
    const admin = await playwright.request.newContext({ baseURL });
    const frames: Array<{ file: string; state: string; sha256: string }> = [];
    const writes: Array<{ path: string; method: string }> = [];
    let interceptedAccessReads = 0;
    let interruptedAccessStatus: number | undefined;
    const capture = async (state: string, surface: Locator) => {
      await settledTask(surface);
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page fits the viewport").toBe(true);
      expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "Task fits without horizontal overflow").toBe(true);
      const file = `structured-publication-journey-${width}-${state}.png`;
      const path = info.outputPath(file);
      await page.screenshot({ path, fullPage: false, mask: [
        page.getByRole("textbox", { name: "订阅链接", exact: true }),
        page.locator(".qr-container"),
      ] });
      frames.push({ file, state, sha256: digest(await readFile(path)) });
    };
    try {
      const f = await structuredPublicationFixture(admin, page.request, baseURL!);
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
          writes.push({ path, method: request.method() });
      });
      const publications = () => writes.filter((write) => /\/outputs(?:\/[^/]+\/publish)?$/.test(write.path));
      await page.goto("/#subscriptions");
      await waitForConfirmedWorkspace(page);
      const card = page.getByRole("article", { name: `分流配置 ${names.profile}`, exact: true });
      await expect(card.getByRole("group", { name: /^客户端订阅 / })).toHaveCount(2);
      await card.getByRole("button", { name: "编辑配置", exact: true }).click();
      const editor = page.locator(".profile-intent-editor");
      const editorURL = page.url();
      await editor.getByRole("tab", { name: "策略组", exact: true }).click();
      await editor.getByRole("button", { name: "添加策略组", exact: true }).click();
      await editor.getByRole("textbox", { name: "策略组名称", exact: true }).fill(names.group);
      await choose(page, editor.getByRole("combobox", { name: `策略组「${names.group}」的固定成员`, exact: true }), "直连", true);
      await editor.getByRole("tab", { name: "分流规则", exact: true }).click();
      await editor.getByRole("button", { name: "添加规则", exact: true }).click();
      await editor.getByRole("textbox", { name: "规则匹配值", exact: true }).fill(names.domain);
      await choose(page, editor.getByRole("combobox", { name: "规则 1 的流量去向", exact: true }), `策略组 ${names.group}`);
      await editor.getByRole("tab", { name: "运行设置", exact: true }).click();
      await editor.getByRole("switch", { name: "启用 DNS", exact: true }).click();
      await editor.getByRole("textbox", { name: "DNS 服务器 1", exact: true }).fill("192.0.2.53");
      await editor.getByRole("switch", { name: "启用流量嗅探", exact: true }).click();
      const tun = editor.getByRole("switch", { name: "启用 TUN", exact: true });
      await tun.focus();
      await page.keyboard.press("Space");
      await expect(tun).toBeChecked();

      const checkChosen = async (save: boolean) => {
        const saving = save ? responseFor(page, `/api/me/profiles/${f.profile.id}`, "PUT") : null;
        await editor.getByRole("button", { name: save ? "保存并检查" : "检查发布", exact: true }).click();
        if (saving) expect((await saving).status()).toBe(200);
        const chooser = page.getByRole("dialog", { name: "选择客户端订阅", exact: true });
        await chooser.getByRole("radio", { name: new RegExp(`^更新「${names.chosen}」`) }).click();
        const checking = responseFor(page, `/api/me/profiles/${f.profile.id}/preview`);
        await chooser.getByRole("button", { name: "检查所选订阅", exact: true }).click();
        const response = await checking;
        expect(response.request().postDataJSON()).toEqual({ outputId: f.chosen.id, target: f.chosen.target, mode: "full" });
        const dialog = page.getByRole("dialog", { name: `检查订阅更新「${names.chosen}」`, exact: true });
        await expect(dialog).toBeVisible();
        return { dialog, response };
      };
      const rejected = await checkChosen(true);
      expect(rejected.response.status()).toBe(422);
      expect((await rejected.response.json()).detail).toBe("RUNTIME_OPTION_UNSUPPORTED: runtime.tun");
      const rejection = rejected.dialog.getByRole("alert");
      await expect(rejection).toContainText(`无法为 Mihomo ${f.chosen.target.version} 生成 TUN 配置`);
      await expect(rejection).toContainText("请取消检查，回到“运行设置”关闭 TUN 后重新检查。草稿内容已保留，已发布内容未改变。");
      await expect(rejection.getByText("RUNTIME_OPTION_UNSUPPORTED: runtime.tun", { exact: true })).toBeHidden();
      await expect(rejected.dialog.getByRole("button", { name: `确认更新「${names.chosen}」`, exact: true })).toBeDisabled();
      const savedWithTUN = await f.readProfile();
      retainedIntent(savedWithTUN, true);
      await f.unchanged();
      expect(publications()).toEqual([]);
      await rejection.scrollIntoViewIfNeeded();
      await capture("compatibility-rejected", rejected.dialog);
      await rejected.dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(rejected.dialog).toHaveCount(0);
      expect(page.url()).toBe(editorURL);
      await expect(editor).toBeVisible();

      await editor.getByRole("tab", { name: "策略组", exact: true }).click();
      const group = editor.getByRole("group", { name: `策略组「${names.group}」`, exact: true });
      await expect(group.getByRole("textbox", { name: "策略组名称", exact: true })).toHaveValue(names.group);
      await expect(group.getByRole("button", { name: "移除 直连", exact: true })).toBeVisible();
      await group.scrollIntoViewIfNeeded();
      await capture("retained-group", editor);
      await editor.getByRole("tab", { name: "分流规则", exact: true }).click();
      const ruleValue = editor.getByRole("textbox", { name: "规则匹配值", exact: true });
      const ruleAction = editor.getByRole("combobox", { name: "规则 1 的流量去向", exact: true });
      await expect(ruleValue).toHaveValue(names.domain);
      await expect(ruleAction).toContainText(`策略组 ${names.group}`);
      await ruleAction.scrollIntoViewIfNeeded();
      // The retained rule needs both its match and chosen destination in one frame.
      await uncovered(ruleValue);
      await uncovered(ruleAction);
      await capture("retained-rule", editor);
      await editor.getByRole("tab", { name: "运行设置", exact: true }).click();
      const dns = editor.getByRole("textbox", { name: "DNS 服务器 1", exact: true });
      await expect(dns).toHaveValue("192.0.2.53");
      await expect(editor.getByRole("switch", { name: "启用流量嗅探", exact: true })).toBeChecked();
      await expect(tun).toBeChecked();
      await dns.scrollIntoViewIfNeeded();
      await capture("retained-dns", editor);
      await tun.scrollIntoViewIfNeeded();
      await tun.focus();
      await expect(tun).toBeFocused();
      await capture("retained-tun", editor);
      await page.keyboard.press("Space");
      await expect(tun).not.toBeChecked();

      const canceled = await checkChosen(true);
      expect(canceled.response.status()).toBe(200);
      const firstPreview = await canceled.response.json() as Preview;
      expect(firstPreview.valid).toBe(true);
      expect(firstPreview.outputId).toBe(f.chosen.id);
      expect(firstPreview.previewScope).toBe("output-update");
      const corrected = await f.readProfile();
      retainedIntent(corrected, false);
      expect(isDeepStrictEqual(corrected.ir, { ...savedWithTUN.ir, runtime: {
        ...savedWithTUN.ir.runtime, tun: { ...savedWithTUN.ir.runtime.tun!, enabled: false },
      } }), "Explicit TUN disable preserves every other saved intent field").toBe(true);
      expect(corrected.target).toEqual(savedWithTUN.target);
      await expect(canceled.dialog.getByText("兼容检查通过。", { exact: true })).toBeVisible();
      const groupChanges = canceled.dialog.getByRole("region", { name: "策略组变化", exact: true });
      await expect(groupChanges).toContainText(names.group);
      await expect(groupChanges).toContainText("新增策略组");
      await groupChanges.scrollIntoViewIfNeeded();
      await capture("compare-group", canceled.dialog);
      const scope = canceled.dialog.getByRole("group", { name: "比较结论与范围", exact: true });
      await expect(scope.getByText("未比较规则文件内容和客户端运行设置。", { exact: true })).toBeVisible();
      const ruleChanges = canceled.dialog.getByRole("list", { name: "分流规则变更", exact: true });
      await expect(ruleChanges).toContainText(names.domain);
      await expect(ruleChanges).toContainText("新增规则");
      const ruleChange = ruleChanges.getByRole("listitem").first();
      await expect(ruleChange).toContainText(names.group);
      await ruleChange.scrollIntoViewIfNeeded();
      // Do not capture only the already-visible scope while the rule is below
      // the fixed footer. Keep the rule, limits and update consequence together.
      await uncovered(ruleChange);
      await uncovered(scope);
      const comparisonDecision = canceled.dialog.getByRole("group", { name: "更新确认", exact: true });
      await expect(comparisonDecision).toContainText("沿用当前链接，其他订阅保留原状。");
      await uncovered(comparisonDecision);
      await uncovered(comparisonDecision.getByRole("button", { name: "取消", exact: true }));
      await uncovered(comparisonDecision.getByRole("button", { name: `确认更新「${names.chosen}」`, exact: true }));
      await capture("compare-rule-and-scope", canceled.dialog);
      await f.unchanged();
      await canceled.dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(canceled.dialog).toHaveCount(0);
      expect(page.url()).toBe(editorURL);
      await expect(editor.getByRole("button", { name: "检查发布", exact: true })).toBeVisible();
      expect(publications()).toEqual([]);
      await f.unchanged();

      const reviewed = await checkChosen(false);
      expect(reviewed.response.status()).toBe(200);
      const preview = await reviewed.response.json() as Preview;
      expect(preview.valid).toBe(true);
      expect(preview.publicationEffect).toMatchObject({ version: 1, link: "preserve" });
      const decision = reviewed.dialog.getByRole("group", { name: "更新确认", exact: true });
      await expect(decision).toContainText(names.chosen);
      await expect(decision).toContainText("沿用当前链接，其他订阅保留原状。");
      const confirm = decision.getByRole("button", { name: `确认更新「${names.chosen}」`, exact: true });
      await confirm.scrollIntoViewIfNeeded();
      if (width === 1440) {
        await confirm.focus();
        await expect(confirm).toBeFocused();
      }
      await capture("chosen-update-decision", reviewed.dialog);
      await uncovered(confirm);
      const publishing = responseFor(page, `/api/me/outputs/${f.chosen.id}/publish`);
      if (width === 390) await confirm.tap();
      else await page.keyboard.press("Enter");
      const published = await publishing;
      expect(published.status()).toBe(200);
      expect(published.request().postDataJSON()).toEqual({ previewDigest: preview.previewDigest });
      await expect(reviewed.dialog).toHaveCount(0);
      expect(publications()).toEqual([{ path: `/api/me/outputs/${f.chosen.id}/publish`, method: "POST" }]);
      const chosenMetadata = await f.metadata(f.chosen.id);
      const siblingMetadata = await f.metadata(f.sibling.id);
      expect(chosenMetadata.revision).not.toBe(f.chosen.revision);
      expect(siblingMetadata.revision).toBe(f.sibling.revision);
      const newBytes = await f.feed(f.chosen);
      expect(newBytes.equals(f.originalChosen), "Chosen frozen configuration changes").toBe(false);
      expect((await f.feed(f.sibling)).equals(f.originalSibling), "Sibling publication remains frozen").toBe(true);
      let rendered: Record<string, unknown>;
      try { rendered = JSON.parse(newBytes.toString()); }
      catch { throw new Error("The isolated publication is not readable client configuration."); }
      expect(isDeepStrictEqual(rendered["proxy-groups"], [{ name: names.group, type: "select", proxies: ["DIRECT"] }]),
        "The generated group contains the chosen direct member").toBe(true);
      expect(isDeepStrictEqual(rendered.rules, [`DOMAIN-SUFFIX,${names.domain},${names.group}`, "MATCH,DIRECT"]),
        "The generated rule routes the chosen domain through that group").toBe(true);
      expect(isDeepStrictEqual(rendered.dns, { enable: true, "enhanced-mode": "redir-host", nameserver: ["tls://192.0.2.53:853"] }),
        "The generated DNS settings match the edited resolver").toBe(true);
      expect((rendered.sniffer as { enable?: boolean } | undefined)?.enable === true,
        "The generated sniff setting remains enabled").toBe(true);
      expect(rendered.tun === undefined, "The explicitly disabled TUN setting is not generated").toBe(true);

      await editor.getByRole("button", { name: "返回", exact: true }).click();
      await expect(editor).toHaveCount(0);
      const chosenRow = card.getByRole("group", { name: `客户端订阅 ${names.chosen}`, exact: true });
      const accessPath = `/api/me/outputs/${f.chosen.id}/access`;
      await page.route(`**${accessPath}`, async (route) => {
        interceptedAccessReads++;
        if (interceptedAccessReads !== 1) return route.continue();
        const realResponse = await route.fetch();
        interruptedAccessStatus = realResponse.status();
        expect(interruptedAccessStatus, "The real access read succeeded before its response is dropped").toBe(200);
        await realResponse.dispose();
        await route.abort("failed");
      });
      await chosenRow.getByRole("button", { name: "获取订阅", exact: true }).click();
      const access = page.getByRole("dialog", { name: `获取「${names.chosen}」`, exact: true });
      await expect(access.getByText("暂时无法获取此订阅，请稍后重试。", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.querySelectorAll('[role="dialog"] input[aria-label="订阅链接"]').length),
        "Failed access read reveals no subscription link").toBe(0);
      expect(interceptedAccessReads).toBe(1);
      await capture("access-read-interrupted", access);
      const retry = access.getByRole("button", { name: "重试", exact: true });
      await uncovered(retry);
      const accessRead = responseFor(page, accessPath, "GET");
      await retry.focus();
      await page.keyboard.press("Enter");
      expect((await accessRead).status()).toBe(200);
      const deliveryCheck = { expectedPathDigest: digest(Buffer.from(f.chosen.feedPath!)) };
      await expect.poll(async () => {
        const observed = await page.evaluate(accessDeliveryObservation, deliveryCheck);
        return observed.inputVisible && observed.linkMatches && observed.downloadMatches;
      }, { message: "Read retry visibly retrieves the same chosen link and matching download" }).toBe(true);
      expect(interceptedAccessReads).toBe(2);
      await expect(access).toContainText("链接包含访问凭据，请仅添加到你信任的客户端。");
      await page.evaluate(accessDeliveryObservation, { ...deliveryCheck, prepareDownload: true });
      await expect.poll(async () => (await page.evaluate(accessDeliveryObservation, deliveryCheck)).downloadReady,
        { message: "The actual download link is focused, fully visible and uncovered" }).toBe(true);
      await capture("access-recovered", access);
      expect((await page.evaluate(accessDeliveryObservation, deliveryCheck)).downloadReady,
        "The download remains keyboard-ready after its masked capture").toBe(true);
      const downloading = page.waitForEvent("download");
      await page.keyboard.press("Enter");
      const downloaded = await downloading;
      expect((await downloaded.failure()) === null, "The real browser download completes").toBe(true);
      let downloadedBytes: Buffer;
      try {
        const stream = await downloaded.createReadStream();
        if (!stream) throw new Error();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        downloadedBytes = Buffer.concat(chunks);
      } catch { throw new Error("Cannot inspect the isolated browser download."); }
      expect(downloadedBytes.equals(newBytes), "Downloaded bytes match the chosen frozen publication").toBe(true);
      await downloaded.delete();
      await page.keyboard.press("Escape");
      await expect(access).toHaveCount(0);
      await page.unroute(`**${accessPath}`);
      await page.reload();
      await waitForConfirmedWorkspace(page);
      retainedIntent(await f.readProfile(), false);
      expect((await f.feed(f.chosen)).equals(newBytes), "Reload preserves the chosen publication").toBe(true);
      expect((await f.feed(f.sibling)).equals(f.originalSibling), "Reload preserves the sibling's old publication").toBe(true);
      expect(publications()).toHaveLength(1);
      expect(writes.filter((write) => /\/(rotate|revoke)$/.test(write.path))).toEqual([]);
      expect(writes.filter((write) => write.method === "PUT")).toEqual([
        { path: `/api/me/profiles/${f.profile.id}`, method: "PUT" },
        { path: `/api/me/profiles/${f.profile.id}`, method: "PUT" },
      ]);
      const proof = {
        width, height,
        scope: "Normal isolated CLI and invited ordinary user; no native client, resolver query, external traffic or deployment.",
        setup: "Initial profile and two independently published subscriptions seeded through public API.",
        browser: "Structured group/rule/DNS/sniff/TUN edits, genuine Mihomo rejection, retained values, explicit TUN correction, check/comparison/cancel and one chosen publication; interrupted access read, explicit retry and real download.",
        interruption: "The first access GET completed successfully at the real server; only its browser response was aborted. The publication response was not interrupted.",
        acceptedConstraints: ["Output target overrides profile preview preference", "Runtime values are outside the displayed semantic comparison", "Correction does not change sibling publication", "Access retry does not publish or rotate"],
        writes, accessReadAttempts: interceptedAccessReads, interruptedAccessStatus,
        chosenBeforeDigest: digest(f.originalChosen), chosenAfterDigest: digest(newBytes),
        siblingBeforeAndAfterDigest: digest(f.originalSibling), downloadMatchesChosen: true,
        frames, completed: true,
      };
      const proofPath = info.outputPath(`structured-publication-journey-proof-${width}.json`);
      await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n");
      await info.attach(`structured-publication-journey-proof-${width}`, { path: proofPath, contentType: "application/json" });
    } finally {
      await admin.dispose();
    }
  });
}
