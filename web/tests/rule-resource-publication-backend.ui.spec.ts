import { createHash } from "node:crypto";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { Output, Preview, RuleResource } from "../src/types";
import { test, expect } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { settledTask } from "./ui-settled-task";
import {
  ruleFileBody, ruleJourneyNames as names,
  ruleResourceFixture, ruleResourceOwner,
} from "./rule-resource-publication-backend";

function responseFor(page: Page, path: string, method = "POST") {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === path && response.request().method() === method);
}
async function choose(page: Page, control: Locator, label: string) {
  await control.click();
  const id = await control.getAttribute("aria-controls");
  const popup = page.locator(`[id="${id}"]`)
    .locator('xpath=ancestor-or-self::*[@data-slot="popover-content"]');
  await popup.getByRole("option").getByText(label, { exact: true }).click();
}
async function capture(page: Page, info: TestInfo, name: string, surface: Locator) {
  await settledTask(surface);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "No horizontal page overflow").toBe(true);
  expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "Task content fits without horizontal overflow").toBe(true);
  await page.screenshot({
    path: info.outputPath(`${name}.png`), fullPage: false,
    // Known synthetic display names remain readable. Mask only foreground
    // source addresses, technical payloads and credential-bearing access UI.
    mask: [surface.locator(
      'input[autocomplete="off"], input[type="password"], textarea, pre, code, canvas, svg[role="img"], a[href*="/feed/"]',
    )],
  });
}
async function uncovered(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || !!hit && element.contains(hit);
  }), "Decision action is not covered").toBe(true);
}
const upload = (dialog: Locator, version: 1 | 2 | 3) =>
  dialog.getByLabel("选择规则文件", { exact: true }).setInputFiles({
    name: `work-rules-v${version}.yaml`, mimeType: "application/yaml",
    buffer: Buffer.from(ruleFileBody(version)),
  });
function acceptedFile(value: RuleResource, version: 1 | 2 | 3, policy: "pinned" | "follow") {
  expect(value).toMatchObject({
    name: names.resource, format: "mihomo-yaml", behavior: "domain",
    location: "local", visibility: "private", updatePolicy: policy,
    canRefresh: false, refreshStatus: "accepted",
  });
  expect(value.acceptedVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(value.digest).toBe(`sha256:${createHash("sha256").update(ruleFileBody(version)).digest("hex")}`);
}

// Built UI -> normal isolated CLI -> genuine invited tenant. No response mocks,
// external rule fetch, native client process, DNS lookup or live deployment.
test.use({ trace: "off", screenshot: "off", video: "off", hasTouch: true });
for (const width of [1440, 390]) {
  test(`real rule file correction → explicit newer pin → selected frozen publication at ${width}`, async ({
    page, playwright, baseURL,
  }, info) => {
    test.setTimeout(90000); // One joined import, edit and two-publication task.
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const admin = await playwright.request.newContext({ baseURL });
    try {
      const headers = await ruleResourceOwner(admin, page.request);
      const f = ruleResourceFixture(page.request, headers);
      const publications: string[] = [];
      let imports = 0;
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        const path = new URL(request.url()).pathname;
        if (path === "/api/me/resources/import") imports++;
        if (/\/outputs\/[^/]+\/publish$/.test(path)) publications.push(path);
      });
      await page.goto("/#resources");
      await page.getByRole("button", { name: "导入规则文件", exact: true }).click();
      const importing = page.getByRole("dialog", { name: "导入规则文件", exact: true });
      await importing.getByLabel("导入资源名称", { exact: true }).fill(names.resource);
      const filePicker = page.waitForEvent("filechooser");
      await importing.getByRole("button", { name: "选择规则文件", exact: true }).focus();
      await page.keyboard.press("Enter");
      await (await filePicker).setFiles({
        name: "work-rules-invalid.yaml", mimeType: "application/yaml",
        buffer: Buffer.from("not-a-rule-payload: true\n"),
      });
      expect(imports, "Selecting a file does not upload it").toBe(0);
      const rejected = responseFor(page, "/api/me/resources/import");
      await importing.getByRole("button", { name: "导入并保存文件", exact: true }).click();
      expect((await rejected).status()).toBe(422);
      const recovery = importing.getByRole("group", { name: "规则文件未通过格式检查", exact: true });
      await settledTask(importing);
      await expect(recovery).toBeFocused();
      await expect(recovery).toContainText("已保留所选文件和填写内容。请核对文件格式，或修正文件后重新选择，再导入。");
      await expect(recovery.getByText("invalid or excessive mihomo-yaml rule file envelope", { exact: true })).toBeHidden();
      await expect(recovery.getByText("查看检查详情", { exact: true })).toBeVisible();
      // Assert the product's native failure handoff, never scroll a broken error
      // into the screenshot from the test or let a DOM-only assertion pass.
      await uncovered(recovery);
      await uncovered(recovery.getByRole("alert"));
      await expect(importing.getByLabel("导入资源名称", { exact: true })).toHaveValue(names.resource);
      await expect(importing.getByText("work-rules-invalid.yaml", { exact: true })).toBeVisible();
      expect(await f.resources()).toEqual([]);
      await capture(page, info, `rule-file-rejected-retained-${width}`, importing);
      await upload(importing, 1);
      await expect(importing.getByLabel("选择规则文件", { exact: true })).toBeHidden();
      await expect(importing.getByRole("status")).toContainText("work-rules-v1.yaml");
      await uncovered(importing.getByRole("status"));
      await expect(importing.getByRole("combobox", { name: "配置引用策略", exact: true })).toHaveText("固定这次接纳的版本");
      expect(imports).toBe(1);
      await uncovered(importing.getByRole("combobox", { name: "配置引用策略", exact: true }));
      await capture(page, info, `rule-file-corrected-pin-choice-${width}`, importing);
      const imported = responseFor(page, "/api/me/resources/import");
      await importing.getByRole("button", { name: "导入并保存文件", exact: true }).click();
      const importedResponse = await imported;
      expect(importedResponse.status()).toBe(201);
      const v1 = await importedResponse.json() as RuleResource;
      acceptedFile(v1, 1, "pinned");
      await expect(importing).toHaveCount(0);

      const profile = await f.createProfile("rule-pinned", names.profile);
      await page.goto(`/#subscriptions?profile=${profile.id}`);
      await page.getByRole("button", { name: "继续配置", exact: true }).click();
      const editor = page.locator(".profile-intent-editor");
      await editor.getByRole("button", { name: "按规则文件分流", exact: true }).click();
      await choose(page, editor.getByRole("combobox", { name: "匹配规则文件", exact: true }), names.resource);
      await choose(page, editor.getByRole("combobox", { name: "规则 1 的流量去向", exact: true }), "拒绝连接");
      await expect(editor.getByText("用于完整配置时，需下载配置与规则文件包。", { exact: true })).toBeVisible();
      const saveProfile = async () => {
        const response = responseFor(page, `/api/me/profiles/${profile.id}`, "PUT");
        await editor.getByRole("button", { name: "保存草稿", exact: true }).click();
        expect((await response).status()).toBe(200);
        await expect(editor.getByText("草稿已保存", { exact: true })).toBeVisible();
        return f.readProfile(profile.id);
      };
      const savedV1 = await saveProfile();
      expect(savedV1.ir.resources).toHaveLength(1);
      expect(savedV1.ir.resources[0]).toMatchObject({ acceptedVersion: v1.acceptedVersion, updatePolicy: "pinned" });
      expect(savedV1.ir.rules).toEqual([{
        id: expect.any(String), match: { op: "resource", value: v1.id }, action: { kind: "reject" },
      }]);
      const chosen = await f.createOutput("rule-chosen", names.chosen, profile.id);
      const sibling = await f.createOutput("rule-sibling", names.sibling, profile.id);
      const originalChosen = await f.bundleState(chosen, v1);
      const originalSibling = await f.bundleState(sibling, v1);
      const reloadSeededInventory = async (groups: Array<{ name: string; outputs: Output[] }>) => {
        // Supporting API setup does not invalidate the live UI's query cache.
        // Hash navigation alone keeps that document. Re-enter once with a fresh
        // document after each completed setup batch, then verify its real list.
        await page.goto("/#subscriptions");
        const listed = responseFor(page, "/api/me/outputs", "GET");
        await page.reload();
        const result = await listed;
        expect(result.status()).toBe(200);
        const outputs = await result.json() as Output[];
        expect(outputs.map((output) => output.id).sort()).toEqual(
          groups.flatMap((group) => group.outputs.map((output) => output.id)).sort(),
        );
        for (const group of groups) {
          const card = page.getByRole("article", { name: `分流配置 ${group.name}`, exact: true });
          await expect(card.getByRole("row", { name: /^客户端订阅 / })).toHaveCount(group.outputs.length);
          for (const output of group.outputs)
            await expect(card.getByRole("row", { name: `客户端订阅 ${output.name}`, exact: true })).toBeVisible();
        }
      };
      await reloadSeededInventory([{ name: names.profile, outputs: [chosen, sibling] }]);

      const replace = async (version: 2 | 3) => {
        await page.goto("/#resources");
        await page.getByRole("button", { name: "替换文件", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: `替换 ${names.resource}`, exact: true });
        await expect(dialog).toContainText("导入失败时保留已接纳文件，已发布订阅继续使用原文件版本。");
        await upload(dialog, version);
        await choose(page, dialog.getByRole("combobox", { name: "配置引用策略", exact: true }), "跟随以后明确接纳的版本");
        if (version === 2) await capture(page, info, `rule-replacement-follow-choice-${width}`, dialog);
        const response = responseFor(page, "/api/me/resources/import");
        await dialog.getByRole("button", { name: "导入并保存文件", exact: true }).click();
        const result = await response;
        expect(result.status()).toBe(201);
        expect(!!result.request().headers()["if-match"], "Replacement names the opened resource revision").toBe(true);
        const value = await result.json() as RuleResource;
        acceptedFile(value, version, "follow");
        expect(value.id).toBe(v1.id);
        await expect(dialog).toHaveCount(0);
        return value;
      };
      const v2 = await replace(2);
      expect(await f.bundleState(chosen, v1)).toEqual(originalChosen);
      expect(await f.bundleState(sibling, v1)).toEqual(originalSibling);
      await page.goto(`/#subscriptions?profile=${profile.id}`);
      const pinnedCard = page.getByRole("article", { name: `分流配置 ${names.profile}`, exact: true });
      await expect(pinnedCard.getByRole("row", { name: /^客户端订阅 / })).toHaveCount(2);
      await pinnedCard.getByRole("button", { name: "编辑配置", exact: true }).click();
      const pin = editor.getByRole("button", { name: "固定到最新接纳版本", exact: true });
      await expect(editor.getByText(`${names.resource}：当前配置固定较早的文件版本。`, { exact: false })).toBeVisible();
      await pin.scrollIntoViewIfNeeded();
      await capture(page, info, `rule-explicit-pin-advance-${width}`, editor);
      await uncovered(pin);
      await pin.click();
      expect(publications).toEqual([]);
      expect((await f.readProfile(profile.id)).ir.resources[0].acceptedVersion).toBe(v1.acceptedVersion);
      const savedV2 = await saveProfile();
      expect(savedV2.ir.resources[0]).toMatchObject({ acceptedVersion: v2.acceptedVersion, updatePolicy: "pinned" });
      expect(await f.bundleState(chosen, v1)).toEqual(originalChosen);
      expect(await f.bundleState(sibling, v1)).toEqual(originalSibling);
      const following = await f.createProfile("rule-follow", names.followProfile, v2);
      expect(following.ir.resources[0]).toMatchObject({ acceptedVersion: v2.acceptedVersion, updatePolicy: "follow" });
      const followOutput = await f.createOutput("rule-follow-output", names.followOutput, following.id);
      const originalFollow = await f.bundleState(followOutput, v2);
      await reloadSeededInventory([
        { name: names.profile, outputs: [chosen, sibling] },
        { name: names.followProfile, outputs: [followOutput] },
      ]);
      const v3 = await replace(3);
      expect(await f.bundleState(chosen, v1)).toEqual(originalChosen);
      expect(await f.bundleState(sibling, v1)).toEqual(originalSibling);
      expect(await f.bundleState(followOutput, v2)).toEqual(originalFollow);
      expect(publications).toEqual([]);

      const review = async (output: Output, expected: RuleResource, policy: "pinned" | "follow") => {
        await page.goto(`/#subscriptions?output=${output.id}`);
        const detail = page.getByRole("dialog", { name: `${output.name} 的订阅详情`, exact: true });
        const pending = responseFor(page, `/api/me/profiles/${output.profileId}/preview`);
        await detail.getByRole("button", { name: "检查更新", exact: true }).click();
        const result = await pending;
        expect(result.status()).toBe(200);
        expect(result.request().postDataJSON()).toMatchObject({ outputId: output.id });
        const preview = await result.json() as Preview;
        // Only the version/policy envelope is asserted, never private config.
        expect(preview.valid).toBe(true);
        expect(preview.outputId).toBe(output.id);
        expect(preview.previewScope).toBe("output-update");
        expect(preview.resources).toHaveLength(1);
        expect(preview.resources?.[0]).toMatchObject({ acceptedVersion: expected.acceptedVersion, updatePolicy: policy });
        const dialog = page.getByRole("dialog", { name: `检查订阅更新「${output.name}」`, exact: true });
        const comparison = dialog.getByRole("group", { name: "比较结论与范围", exact: true });
        await expect(comparison.getByText("分流规则和默认去向未变化", { exact: true })).toBeVisible();
        await expect(comparison.getByText("未比较规则文件内容和客户端运行设置。", { exact: true })).toBeVisible();
        await expect(dialog).toContainText("发布后仅提供配置与规则文件包，请下载并导入客户端。其他订阅保留原状。");
        const confirm = dialog.getByRole("button", { name: `确认更新「${output.name}」`, exact: true });
        await expect(confirm).toBeEnabled();
        return { dialog, confirm, preview };
      };
      const canceled = await review(chosen, v2, "pinned");
      expect(await f.bundleState(chosen, v1)).toEqual(originalChosen);
      await canceled.confirm.scrollIntoViewIfNeeded();
      await capture(page, info, `rule-selected-publication-cancel-${width}`, canceled.dialog);
      await canceled.dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(canceled.dialog).toHaveCount(0);
      expect(publications).toEqual([]);
      expect(await f.bundleState(chosen, v1)).toEqual(originalChosen);
      expect(await f.bundleState(sibling, v1)).toEqual(originalSibling);

      const publish = async (output: Output, expected: RuleResource, policy: "pinned" | "follow") => {
        const current = await review(output, expected, policy);
        await current.confirm.scrollIntoViewIfNeeded();
        await capture(page, info, `rule-${policy}-publication-review-${width}`, current.dialog);
        await uncovered(current.confirm);
        const response = responseFor(page, `/api/me/outputs/${output.id}/publish`);
        if (width === 390) await current.confirm.tap();
        else { await current.confirm.focus(); await page.keyboard.press("Enter"); }
        const result = await response;
        expect(result.status()).toBe(200);
        expect(result.request().postDataJSON()).toEqual({ previewDigest: current.preview.previewDigest });
        await expect(current.dialog).toHaveCount(0);
        const access = page.getByRole("dialog", { name: `获取「${output.name}」`, exact: true });
        const download = access.getByRole("link", { name: "下载配置与规则文件", exact: true });
        await expect(download).toHaveAttribute("href", `/api/me/outputs/${output.id}/bundle`);
        await expect(access.getByRole("button", { name: "复制订阅链接", exact: true })).toHaveCount(0);
        await expect(access.getByLabel("订阅链接", { exact: true })).toHaveCount(0);
        await expect(access).toContainText("配置内容更新后需重新下载整个配置包。");
        await download.scrollIntoViewIfNeeded();
        await capture(page, info, `rule-${policy}-bundle-access-${width}`, access);
        return f.bundleState(output, expected);
      };
      const publishedPin = await publish(chosen, v2, "pinned");
      expect(publishedPin.bundleDigest).not.toBe(originalChosen.bundleDigest);
      expect(publishedPin.accessDigest).toBe(originalChosen.accessDigest);
      expect(await f.bundleState(sibling, v1)).toEqual(originalSibling);
      expect(await f.bundleState(followOutput, v2)).toEqual(originalFollow);
      const publishedFollow = await publish(followOutput, v3, "follow");
      expect(publishedFollow.bundleDigest).not.toBe(originalFollow.bundleDigest);
      expect(publishedFollow.accessDigest).toBe(originalFollow.accessDigest);
      expect(await f.bundleState(chosen, v2)).toEqual(publishedPin);
      expect(await f.bundleState(sibling, v1)).toEqual(originalSibling);
      expect(publications).toEqual([
        `/api/me/outputs/${chosen.id}/publish`, `/api/me/outputs/${followOutput.id}/publish`,
      ]);
      expect(imports).toBe(4); // One rejected file, then accepted v1, v2 and v3.
      expect((await f.readProfile(profile.id)).ir.resources[0]).toMatchObject({
        acceptedVersion: v2.acceptedVersion, updatePolicy: "pinned",
      });
      await info.attach(`rule-publication-proof-${width}`, {
        contentType: "application/json",
        body: JSON.stringify({
          width, scope: "normal CLI, isolated database, invited ordinary tenant",
          setup: "Empty profile, initial subscriptions and independent follow profile seeded through public API",
          browser: "Malformed file correction, v1 import, resource rule selection, v2/v3 replacements, explicit pin advance, review/cancel and two chosen publications",
          pinnedPublishedVersion: 2, followedPublishedVersion: 3, siblingPublishedVersion: 1,
          explicitPublications: publications.length, canceledReviewUnchanged: true,
          exactRuleBytesChecked: true, siblingBundleByteIdentical: true,
          noNativeClientOrHTTPSFetchSuccessClaim: true,
        }, null, 2),
      });
    } finally { await admin.dispose(); }
  });

  test(`real HTTPS resource inspection and private import reject private addresses at ${width}`, async ({
    page, playwright, baseURL,
  }, info) => {
    requireLoopback(baseURL);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const admin = await playwright.request.newContext({ baseURL });
    try {
      const headers = await ruleResourceOwner(admin, page.request);
      const f = ruleResourceFixture(page.request, headers);
      const privateURL = "https://127.0.0.1/rules.yaml";
      await page.goto("/#resources");
      await page.getByRole("button", { name: "添加公开引用", exact: true }).click();
      const reference = page.getByRole("dialog", { name: "添加公开规则引用", exact: true });
      await reference.getByLabel("资源名称", { exact: true }).fill("待修正规则引用");
      await reference.getByLabel("规则文件 URL", { exact: true }).fill(privateURL);
      const disclosure = reference.getByText("远程文件随配置交付时，客户端会直接访问此地址。只有明确公开的规则文件可用于这种方式。", { exact: true });
      const saveReference = reference.getByRole("button", { name: "保存公开引用", exact: true });
      await expect(saveReference).toHaveAccessibleDescription(await disclosure.innerText());
      expect(await saveReference.evaluate((button: HTMLButtonElement) => button.form === button.closest('[role="dialog"]')?.querySelector("form")),
        "Footer Save remains associated with the real form").toBe(true);
      await expect(reference.getByRole("combobox", { name: "文件格式", exact: true })).toHaveText("Mihomo YAML");
      await expect(reference.getByRole("combobox", { name: "更新策略", exact: true })).toHaveText("跟随远程更新");
      await expect(reference.getByLabel("版本标识", { exact: true })).toHaveValue("1");
      await expect(reference.getByLabel("客户端更新间隔（秒）", { exact: true })).toHaveValue("86400");
      await uncovered(disclosure);
      await uncovered(saveReference);
      await capture(page, info, `rule-public-reference-disclosure-choice-${width}`, reference);
      const inspected = responseFor(page, "/api/me/resources/inspect");
      await reference.getByRole("button", { name: "读取文件并计算校验值", exact: true }).click();
      expect((await inspected).status()).toBe(422);
      const referenceFailure = reference.getByRole("group", { name: "无法读取此规则文件地址", exact: true });
      await settledTask(reference);
      await expect(referenceFailure).toBeFocused();
      await expect(referenceFailure).toHaveAccessibleDescription("该地址不是允许读取的公开地址。当前输入已保留。请改用公开 HTTPS 地址，或取消后选择“导入规则文件”上传本地文件。");
      await expect(referenceFailure.getByText("resource address is not public", { exact: true })).toHaveCount(1);
      await expect(referenceFailure.getByText("resource address is not public", { exact: true })).toBeHidden();
      await expect(referenceFailure.getByText("查看检查详情", { exact: true })).toBeVisible();
      await uncovered(referenceFailure);
      await uncovered(referenceFailure.getByRole("alert"));
      await uncovered(disclosure);
      await uncovered(saveReference);
      await expect(reference.getByLabel("规则文件 URL", { exact: true })).toHaveValue(privateURL);
      await expect(reference.getByLabel("资源名称", { exact: true })).toHaveValue("待修正规则引用");
      await expect(reference.getByLabel("SHA-256 校验值", { exact: true })).toHaveValue("");
      expect(await f.resources()).toEqual([]);
      await capture(page, info, `rule-public-reference-https-rejected-${width}`, reference);
      await reference.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("alertdialog", { name: "放弃未保存的规则资源修改？", exact: true })
        .getByRole("button", { name: "放弃修改", exact: true }).click();
      await expect(reference).toHaveCount(0);

      await page.getByRole("button", { name: "导入规则文件", exact: true }).click();
      const imported = page.getByRole("dialog", { name: "导入规则文件", exact: true });
      await imported.getByLabel("导入资源名称", { exact: true }).fill(names.resource);
      await choose(page, imported.getByRole("combobox", { name: "规则文件导入方式", exact: true }), "读取 HTTPS 文件并接纳");
      await imported.getByLabel("导入文件 HTTPS 地址", { exact: true }).fill(privateURL);
      await expect(imported).toContainText("保存时由平台读取一次文件并保存私有副本。");
      const rejected = responseFor(page, "/api/me/resources/import");
      await imported.getByRole("button", { name: "读取并接纳文件", exact: true }).click();
      expect((await rejected).status()).toBe(422);
      const importFailure = imported.getByRole("group", { name: "无法读取此规则文件地址", exact: true });
      await settledTask(imported);
      await expect(importFailure).toBeFocused();
      await expect(importFailure).toHaveAccessibleDescription("该地址不是允许读取的公开地址。当前输入已保留。请改用公开 HTTPS 地址，或将导入方式切换为“上传本地文件”。");
      await expect(importFailure.getByText("resource address is not public", { exact: true })).toHaveCount(1);
      await expect(importFailure.getByText("resource address is not public", { exact: true })).toBeHidden();
      await expect(importFailure.getByText("查看检查详情", { exact: true })).toBeVisible();
      await uncovered(importFailure);
      await uncovered(importFailure.getByRole("alert"));
      await expect(imported.getByLabel("导入文件 HTTPS 地址", { exact: true })).toHaveValue(privateURL);
      await expect(imported.getByLabel("导入资源名称", { exact: true })).toHaveValue(names.resource);
      expect(await f.resources()).toEqual([]);
      await capture(page, info, `rule-private-https-import-rejected-${width}`, imported);
      await imported.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("alertdialog", { name: "放弃未保存的规则文件修改？", exact: true })
        .getByRole("button", { name: "放弃修改", exact: true }).click();
      await expect(imported).toHaveCount(0);
      expect(await f.resources()).toEqual([]);
    } finally { await admin.dispose(); }
  });
}
