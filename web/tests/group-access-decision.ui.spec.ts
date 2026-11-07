import { createHash } from "node:crypto";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import type {
  EffectivePolicy,
  GroupPolicyEditContext,
  GroupPolicyResource,
  PolicyPreview,
  UserGroup,
} from "../src/access-policy-model";
import { expect, test } from "./isolated-control-plane-fixture";
import { initialPassword } from "./account-security-backend";
import { headers, read, signIn } from "./uiux-inventory-helper";
import { settledTask } from "./ui-settled-task";

// Fresh normal-CLI database per test. Setup and the independent concurrent edit
// use public HTTP; all local membership, review, dismissal and apply decisions
// use the real UI. No response interception, live entry, quota edit or feed URL.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "no-preference" });

const originalName = "远程协作用户组";
const draftName = "远程协作晚班用户组";
const planName = "跨区域协作服务方案";
const originalPlan = "group-access-plan-original";
const replacementPlan = "group-access-plan-replacement";
const oldName = "林晓（转出成员）";
const newName = "周宁（加入成员）";
const consentLabel = "我已核对本次授权变更";
const retainedConsent = "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本";

async function post(client: APIRequestContext, path: string, data: unknown) {
  const response = await client.post(`/api${path}`, { headers: await headers(client), data });
  // Never dump invitation/session bodies or their credentials on a setup failure.
  expect(response.ok(), `Synthetic public setup ${path}`).toBe(true);
  return response.json();
}

async function choose(page: Page, editor: Locator, label: string, option: string, multiple = false) {
  const control = editor.getByRole("combobox", { name: label, exact: true });
  await control.click();
  await page.getByRole("combobox", { name: "搜索选项", exact: true }).fill(option);
  await page.getByRole("option", { name: option, exact: true }).click();
  if (multiple) await page.keyboard.press("Escape");
  await expect(control).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

function row(page: Page, table: Locator, label: string) {
  return table.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: label, exact: true }),
  });
}

for (const width of [1440, 390]) {
  test(`group membership and service decisions preserve cancel and stale drafts before explicit apply at ${width}px`, async ({
    page, playwright, baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await signIn(page, baseURL, "admin");
    const oldAccount = await playwright.request.newContext({ baseURL });
    const newAccount = await playwright.request.newContext({ baseURL });
    const anonymous = await playwright.request.newContext({ baseURL });
    const captures: { state: string; sha256: string; scope: string }[] = [];
    const writes: { path: string; body: { change?: { group?: UserGroup }; revision?: string } }[] = [];
    const errors: string[] = [];
    const browserFailures: string[] = [];
    let completed = false;
    try {
      const invite = async (client: APIRequestContext, name: string, username: string) => {
        const invitation = await post(page.request, "/invites", { name, role: "user", expiresInHours: 1 });
        const accepted = await client.post("/api/auth/accept-invite", {
          data: { token: invitation.token, username, password: initialPassword },
        });
        expect(accepted.status()).toBe(200);
        const identity = await accepted.json();
        expect(identity.user.role).toBe("user");
        return identity.user.id as string;
      };
      const oldId = await invite(oldAccount, oldName, "group-access-outgoing");
      const newId = await invite(newAccount, newName, "group-access-incoming");
      for (const [id, onlineIpLimit, connectionLimit] of [
        [originalPlan, 1, 4], [replacementPlan, 2, 8],
      ] as const) await post(page.request, "/services", {
        id, name: planName, routeIds: [], quotaBytes: 0,
        cycle: { mode: "none", timezone: "UTC+8" }, onlineIpLimit, connectionLimit,
      });
      const group: UserGroup = {
        id: "group-access-team", name: originalName, serviceId: originalPlan,
        priority: 10, memberIds: [oldId],
      };
      const applySetup = async (value: UserGroup) => {
        const context: GroupPolicyEditContext = await read(page.request, `/access-policy/edit-context/group/${group.id}`);
        const change = { group: value };
        const preview: PolicyPreview = await post(page.request, "/access-policy/preview", { change, precondition: context.precondition });
        expect(preview.blockers).toEqual([]);
        await post(page.request, "/access-policy/apply", { change, revision: preview.revision });
      };
      await applySetup(group);
      const savedGroup = async () =>
        (await read(page.request, "/user-groups") as UserGroup[]).find((value) => value.id === group.id);
      const effective = async (id: string): Promise<EffectivePolicy> =>
        read(page.request, `/users/${id}/effective-policy`);
      const before = { old: await effective(oldId), next: await effective(newId) };
      expect(before.old).toMatchObject({ serviceId: originalPlan, groupIds: [group.id], onlineIpLimit: 1, connectionLimit: 4 });
      expect(before.next.serviceId).toBeUndefined();
      const unchanged = async () => {
        expect(await savedGroup()).toEqual(group);
        expect(await effective(oldId)).toEqual(before.old);
        expect(await effective(newId)).toEqual(before.next);
      };

      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))
          writes.push({ path, body: request.postDataJSON() });
      });
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith("/api/") && response.status() >= 400)
          browserFailures.push(`${response.status()} ${path}`);
      });
      const capture = async (state: string, surface: Locator, target: Locator, scope: string) => {
        await target.scrollIntoViewIfNeeded();
        await expect(target).toBeInViewport({ ratio: 1 });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await settledTask(surface);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        const box = await surface.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(-1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        const pixels = await page.screenshot();
        await info.attach(`group-access-${width}-${state}.png`, { body: pixels, contentType: "image/png" });
        captures.push({ state, sha256: createHash("sha256").update(pixels).digest("hex"), scope });
      };
      await page.goto("/#users");
      const opener = page.getByRole("button", { name: `编辑 ${originalName}`, exact: true });
      const editor = page.getByRole("dialog", { name: `编辑 ${originalName}`, exact: true });
      const openEditor = async () => {
        await opener.click();
        await expect(editor.getByRole("textbox", { name: "用户组名称", exact: true })).toHaveValue(originalName);
        await settledTask(editor);
      };
      const edit = async () => {
        await editor.getByRole("textbox", { name: "用户组名称", exact: true }).fill(draftName);
        await choose(page, editor, "组服务方案", `${planName}（${replacementPlan}）`);
        await choose(page, editor, "组成员", oldName, true);
        await choose(page, editor, "组成员", newName, true);
      };
      const preservedDraft = async () => {
        await expect(editor.getByRole("textbox", { name: "用户组名称", exact: true })).toHaveValue(draftName);
        await expect(editor.getByRole("combobox", { name: "组服务方案", exact: true })).toContainText(replacementPlan);
        await expect(editor.getByRole("button", { name: `移除 ${newName}`, exact: true })).toBeVisible();
        await expect(editor.getByRole("button", { name: `移除 ${oldName}`, exact: true })).toHaveCount(0);
      };
      const previewButton = editor.getByRole("button", { name: "预览影响", exact: true });
      const review = page.getByRole("dialog", { name: "确认授权变更", exact: true });
      const apply = review.getByRole("button", { name: "更新授权", exact: true });
      const preview = async () => {
        const response = page.waitForResponse((response) =>
          new URL(response.url()).pathname === "/api/access-policy/preview" && response.request().method() === "POST");
        await previewButton.click();
        const result = await response;
        expect(result.status()).toBe(200);
        const data: PolicyPreview = await result.json();
        expect(data.guard).toBe("opened-record");
        expect(data.blockers).toEqual([]);
        const resource = data.resource as GroupPolicyResource;
        expect(resource.before?.group.serviceId).toBe(originalPlan);
        expect(resource.after.group).toMatchObject({ name: draftName, serviceId: replacementPlan, memberIds: [newId] });
        expect(data.affected.map((effect) => effect.userId).sort()).toEqual([oldId, newId].sort());
        expect(data.affected.find((effect) => effect.userId === oldId)?.after.serviceId).toBeUndefined();
        expect(data.affected.find((effect) => effect.userId === newId)?.after).toMatchObject({ serviceId: replacementPlan, onlineIpLimit: 2, connectionLimit: 8 });
        await settledTask(review);
        await expect(apply).toBeDisabled();
        await expect(review.getByRole("checkbox", { name: /我已核对本次授权变更/ })).not.toBeChecked();
        return data;
      };
      await openEditor();
      await edit();
      await preservedDraft();
      await capture("selected-members", editor, editor.getByRole("combobox", { name: "组成员", exact: true }), "Edited service identity and selected member; no save yet");
      const initialReview = await preview();
      const comparison = review.getByRole("table", { name: "用户组变更", exact: true });
      await expect(row(page, comparison, "服务方案").getByRole("cell").nth(0)).toContainText(originalPlan);
      await expect(row(page, comparison, "服务方案").getByRole("cell").nth(1)).toContainText(replacementPlan);
      await expect(review.getByRole("list", { name: "新增成员", exact: true })).toContainText(newName);
      await expect(review.getByRole("list", { name: "移除成员", exact: true })).toContainText(oldName);
      await expect(review.getByText(`用户组：${draftName}`, { exact: true })).toBeVisible();
      await capture("group-comparison", review, comparison, "Paired group fields disambiguate equal service names by stable ID");
      for (const [name, beforeIP, afterIP, beforeLimit, afterLimit] of [
        [oldName, "1 个", "不限制", "4 条", "不限制"],
        [newName, "不限制", "2 个", "不限制", "8 条"],
      ]) {
        const impact = review.getByRole("table", { name, exact: true });
        const ip = row(page, impact, "在线 IP 上限");
        const streams = row(page, impact, "并发逻辑流上限");
        await expect(ip.getByRole("cell").nth(0)).toContainText(beforeIP);
        await expect(ip.getByRole("cell").nth(1)).toContainText(afterIP);
        await expect(streams.getByRole("cell").nth(0)).toContainText(beforeLimit);
        await expect(streams.getByRole("cell").nth(1)).toContainText(afterLimit);
        if (width === 390) {
          await impact.evaluate((element) => element.scrollIntoView({ block: "start" }));
          await capture(name === oldName ? "outgoing-identity" : "incoming-identity", review,
            review.getByRole("heading", { name, exact: true }),
            "Named affected account and before/after headings, paired with the following lower comparison position");
        }
        await capture(name === oldName ? "outgoing-impact" : "incoming-impact", review, streams, "Actual account before/after service and access-limit comparison; sequential scroll position");
      }
      // Real permission boundaries: an existing ticket does not grant admin rights.
      for (const [client, status] of [[anonymous, 401], [newAccount, 403]] as const) {
        const auth = status === 403 ? await headers(client) : {};
        expect((await client.get(`/api/access-policy/edit-context/group/${group.id}`)).status()).toBe(status);
        expect((await client.post("/api/access-policy/apply", {
          headers: auth, data: { change: { group: (initialReview.resource as GroupPolicyResource).after.group }, revision: initialReview.revision },
        })).status()).toBe(status);
      }
      await unchanged();
      await review.getByRole("button", { name: "返回编辑", exact: true }).click();
      await expect(review).toHaveCount(0);
      await expect(previewButton).toBeFocused();
      await preservedDraft();
      const cancel = editor.getByRole("button", { name: "取消", exact: true });
      const discard = page.getByRole("alertdialog", { name: "放弃尚未保存的授权修改？", exact: true });
      await cancel.click();
      await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
      await expect(discard).toHaveCount(0);
      await preservedDraft();
      await cancel.click();
      await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(opener).toBeFocused();
      expect(writes.filter((write) => write.path.endsWith("/apply"))).toHaveLength(0);
      await unchanged();

      await openEditor();
      await edit();
      const staleReview = await preview();
      // Another administrator changes only the saved priority after this review.
      // This is a real compare-and-swap failure, not a substituted 409 response.
      const concurrent = { ...group, priority: 11 };
      await applySetup(concurrent);
      await review.getByRole("checkbox", { name: consentLabel, exact: true }).check();
      const rejection = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/access-policy/apply" && response.request().method() === "POST");
      await apply.click();
      expect((await rejection).status()).toBe(409);
      await expect(review).toHaveCount(0);
      await preservedDraft();
      const failure = editor.getByRole("group", { name: "操作未完成", exact: true });
      await expect(failure).toBeFocused();
      await expect(editor.getByText("草稿尚未保存，请核对最新版本。", { exact: true })).toBeVisible();
      await capture("stale-draft-retained", editor, failure, "Real rejected stale apply and focused recovery; draft is retained");
      expect(await savedGroup()).toEqual(concurrent);
      expect(await effective(oldId)).toEqual(before.old);
      expect(await effective(newId)).toEqual(before.next);
      expect(writes.filter((write) => write.path.endsWith("/apply"))[0].body.revision).toBe(staleReview.revision);
      await editor.getByRole("button", { name: "查看最新版本", exact: true }).click();
      const latest = editor.getByRole("table", { name: "已保存的用户组变化", exact: true });
      await expect(row(page, latest, "用户组优先级").getByRole("cell")).toHaveText(["10", "11"]);
      await capture("latest-priority", editor, latest, "Concurrent saved priority compared with the opening record; draft not merged");
      await editor.getByRole("button", { name: "使用最新版本重新编辑", exact: true }).click();
      await page.getByRole("alertdialog", { name: "使用最新版本重新编辑？", exact: true })
        .getByRole("button", { name: "使用最新版本", exact: true }).click();
      await expect(editor.getByRole("textbox", { name: "用户组名称", exact: true })).toHaveValue(originalName);
      await expect(editor.getByRole("spinbutton", { name: "用户组优先级", exact: true })).toHaveValue("11");
      await expect(editor.getByRole("button", { name: "上一版草稿（未保存）", exact: true })).toBeVisible();
      await edit();
      const fresh = await preview();
      expect(fresh.revision).not.toBe(staleReview.revision);
      expect((fresh.resource as GroupPolicyResource).after.group.priority).toBe(11);
      const consent = review.getByRole("checkbox", { name: retainedConsent, exact: true });
      await expect(consent).not.toBeChecked();
      await expect(review.getByText("受管入口配置需单独应用。", { exact: true })).toBeVisible();
      await capture("fresh-explicit-decision", review, consent, "Fresh unchecked consent includes retained-draft disposal and separate managed-entry application");
      await consent.check();
      const applied = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/access-policy/apply" && response.request().method() === "POST");
      await apply.click();
      expect((await applied).status()).toBe(200);
      await expect(review).toHaveCount(0);
      await expect(editor).toHaveCount(0);
      await expect(page.getByRole("button", { name: `编辑 ${draftName}`, exact: true })).toBeVisible();
      expect(await savedGroup()).toEqual({ ...concurrent, name: draftName, serviceId: replacementPlan, memberIds: [newId] });
      const outgoing = await effective(oldId);
      expect(outgoing.serviceId).toBeUndefined();
      expect(outgoing).toMatchObject({ groupIds: [], onlineIpLimit: 0, connectionLimit: 0 });
      expect(await effective(newId)).toMatchObject({ serviceId: replacementPlan, groupIds: [group.id], onlineIpLimit: 2, connectionLimit: 8 });
      const applies = writes.filter((write) => write.path.endsWith("/apply"));
      expect(applies).toHaveLength(2);
      expect(applies[1].body.revision).toBe(fresh.revision);
      expect(writes.filter((write) => !["/api/access-policy/preview", "/api/access-policy/apply"].includes(write.path))).toEqual([]);
      expect(browserFailures).toEqual(["409 /api/access-policy/apply"]);
      expect(errors).toEqual([]);
      completed = true;
    } finally {
      await info.attach("group-access-evidence", {
        contentType: "application/json",
        body: JSON.stringify({ completed, viewport: page.viewportSize(), captures,
          browserWrites: writes.map(({ path }) => path), browserFailures, errors,
          scope: "Isolated real backend; synthetic group membership and service access decisions only. No live enforcement, quota policy, client delivery or full accessibility acceptance.",
          pixels: "Naturally settled viewport positions for independent review; screenshot creation is not visual acceptance.",
        }, null, 2),
      });
      await Promise.all([oldAccount.dispose(), newAccount.dispose(), anonymous.dispose()]);
    }
  });
}
