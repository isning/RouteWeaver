import { sourceRowAction } from "./source-row-actions";
import { openWorkspace, navigateWorkspace } from "./ui-session";
import { test as base, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

async function frozenSourceOutput(page: Page, id: string) {
  const list = await (await page.request.get("/api/me/outputs")).json();
  const output = list.find((item: { id: string }) => item.id === id);
  const access = await (
    await page.request.get(`/api/me/outputs/${id}/access`)
  ).json();
  const path = new URL(access.feedPath, "http://127.0.0.1:4173").pathname;
  const content = await page.request.get(path);
  expect(content.ok(), "Synthetic frozen delivery succeeds").toBe(true);
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return {
    id: output.id,
    profileId: output.profileId,
    target: output.target,
    mode: output.mode,
    revision: output.revision,
    routingSummary: output.routingSummary,
    access: hash(path),
    content: hash(await content.text()),
  };
}

type SourceJourney = {
  headers: Record<string, string>;
  owned: Record<"sources" | "profiles" | "outputs", Set<string>>;
};
const test = base.extend<{ sourceJourney: SourceJourney }>({
  sourceJourney: async ({ page }, use) => {
    await openWorkspace(page);
    const sessionResponse = await page.request.get("/api/auth/me");
    expect(sessionResponse.ok()).toBe(true);
    const session = await sessionResponse.json();
    const headers = { "X-CSRF-Token": session.csrfToken };
    const owned = {
      sources: new Set<string>(),
      profiles: new Set<string>(),
      outputs: new Set<string>(),
    };
    const sourceCaptures: Promise<void>[] = [];
    const captureSource = (response: import("@playwright/test").Response) => {
      if (
        new URL(response.url()).pathname !== "/api/me/sources" ||
        response.request().method() !== "POST" ||
        !response.ok()
      )
        return;
      sourceCaptures.push(
        response.json().then((source) => {
          expect(typeof source.id).toBe("string");
          expect(source.id).not.toBe("");
          owned.sources.add(source.id);
        }),
      );
    };
    page.on("response", captureSource);
    try {
      await use({ headers, owned });
    } finally {
      // Fixture teardown has its normal separate cleanup budget. A task failure
      // must remain the primary error even if cleanup also fails.
      await Promise.all(sourceCaptures);
      page.off("response", captureSource);
      // Outputs have no deletion endpoint. Revoke only owned access first;
      // the isolated demo shutdown removes the retained revocation receipts.
      for (const id of owned.outputs) {
        const response = await page.request.post(
          `/api/me/outputs/${encodeURIComponent(id)}/revoke`,
          { headers, data: {} },
        );
        expect(response.ok(), "Revoke owned synthetic Output").toBe(true);
      }
      for (const kind of ["profiles", "sources"] as const) {
        for (const id of owned[kind]) {
          const response = await page.request.delete(
            `/api/me/${kind}/${encodeURIComponent(id)}`,
            { headers },
          );
          expect(response.ok(), `Remove owned synthetic ${kind} fixture`).toBe(
            true,
          );
        }
      }
    }
  },
});

test("reviews material source changes and preserves accepted options until an explicit decision", async ({
  page,
  sourceJourney: { headers, owned },
}, testInfo) => {
  const name = `Review airport ${Date.now().toString(36)}`;
  await page.getByText("订阅素材", { exact: true }).click();
  await navigateWorkspace(page, "订阅来源");
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "添加来源", exact: true })
    .click();
  const importDialog = page.getByRole("dialog", {
    name: "添加订阅来源",
    exact: true,
  });
  await expect(importDialog).toBeVisible();
  await page.getByLabel("来源名称").fill(name);
  await page
    .getByRole("combobox", { name: "更新应用方式", exact: true })
    .click();
  await page.getByRole("option", { name: "手动应用", exact: true }).click();
  await page
    .getByLabel("节点链接或配置内容")
    .fill(
      "socks5://synthetic:before-fixture@one.example:1080#London\nsocks5://two.example:1080#Tokyo",
    );
  await page.getByRole("button", { name: "导入来源", exact: true }).click();
  // A closing field popover also has role=dialog. Wait for this owned task,
  // not a strict single-element match across unrelated transient overlays.
  await expect(importDialog).not.toBeVisible();
  let list = await (await page.request.get("/api/me/sources")).json();
  const original = list.find((item: { name: string }) => item.name === name);
  expect(original.snapshot.endpoints).toHaveLength(2);
  // Separate setup: two same-named configurations/Outputs expose stable-ID navigation.
  const suffix = Date.now().toString(36);
  const sharedProfileName = `Related routing ${suffix}`;
  const sharedOutputName = `Related client ${suffix}`;
  const profiles = [];
  const outputs = [];
  for (const [index, action] of [
    { kind: "endpoint", ref: original.snapshot.endpoints[1].id },
    { kind: "direct" },
  ].entries()) {
    const id = `source-continuation-${suffix}-${index}`;
    const profile = {
      id,
      name: sharedProfileName,
      sourceIds: [original.id],
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      ir: {
        schemaVersion: "1.0",
        id,
        name: sharedProfileName,
        ownerId: "",
        revision: "1",
        endpoints: [],
        groups: [],
        rules: [],
        resources: [],
        defaultAction: action,
        runtime: { mixedPort: 7890 },
      },
    };
    const saved = await page.request.post("/api/me/profiles", {
      headers,
      data: profile,
    });
    expect(saved.ok(), "Related synthetic configuration setup succeeds").toBe(
      true,
    );
    owned.profiles.add(profile.id);
    profiles.push(profile);
    const created = await page.request.post("/api/me/outputs", {
      headers,
      data: {
        id: `source-client-${suffix}-${index}`,
        name: sharedOutputName,
        profileId: id,
        target: profile.target,
        mode: "full",
      },
    });
    expect(created.ok(), "Related synthetic Output setup succeeds").toBe(true);
    const output = await created.json();
    owned.outputs.add(output.id);
    outputs.push(output);
  }
  const beforeOutputs = await Promise.all(
    outputs.map((output) => frozenSourceOutput(page, output.id)),
  );
  await page.getByRole("textbox", { name: "搜索来源", exact: true }).fill(name);
  await (await sourceRowAction(page, "编辑", name)).click();
  await page
    .getByLabel("节点链接或配置内容")
    .fill("socks5://synthetic:after-fixture@one.example:1080#London");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "查看变化", exact: true }).click();
  const review = page.getByRole("dialog", { name: "查看变化", exact: true });
  await expect(review).toBeVisible();
  await expect(review.getByRole("heading", { name: "移除 1", exact: true })).toBeVisible();
  await expect(review.getByRole("heading", { name: "连接变更 1", exact: true })).toBeVisible();
  await expect(review.getByText("登录密码", { exact: true })).toBeVisible();
  await expect(review).not.toContainText("after-fixture");
  list = await (await page.request.get("/api/me/sources")).json();
  const pending = list.find((item: { id: string }) => item.id === original.id);
  expect(pending.snapshot.snapshotId).toBe(original.snapshot.snapshotId);
  await page.screenshot({
    path: testInfo.outputPath("source-review-desktop.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(review).not.toBeVisible();
  const sourceRow = page.getByRole("row").filter({
    has: page.getByRole("button", { name: `更多操作 ${name}`, exact: true }),
  });
  await expect(sourceRow).toHaveCount(1);
  await sourceRow
    .getByRole("button", { name: "查看变化", exact: true })
    .click();
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "应用更新", exact: true }).click();
  await expect(review).not.toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: `查看上次应用结果 ${name}`, exact: true })
    .click();
  const receipt = page.getByRole("dialog", {
    name: "上次应用详情",
    exact: true,
  });
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText("来源已更新，已发布订阅未改变。");
  await expect(
    receipt.getByRole("link", {
      name: new RegExp(`^查看配置 ${sharedProfileName}(?: |$)`),
    }),
  ).toHaveCount(2);
  await expect(
    receipt.getByRole("link", {
      name: new RegExp(`^查看订阅 ${sharedOutputName}(?: |$)`),
    }),
  ).toHaveCount(2);
  await expect(receipt).not.toContainText("after-fixture");
  expect(
    await Promise.all(
      outputs.map((output) => frozenSourceOutput(page, output.id)),
    ),
  ).toEqual(beforeOutputs);
  // The two fixtures have identical names AND client/mode metadata. A reader
  // must be able to distinguish them visibly, not by inspecting an href.
  const profileRows = profiles.map((profile) =>
    receipt
      .getByRole("listitem")
      .filter({ hasText: `配置标识：${profile.id}` }),
  );
  const outputRows = outputs.map((output) =>
    receipt.getByRole("listitem").filter({ hasText: `订阅标识：${output.id}` }),
  );
  for (const row of [...profileRows, ...outputRows]) {
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("mihomo 完整配置");
  }
  const profileLink = profileRows[0].getByRole("link", {
    name: /^查看配置 /,
  });
  await expect(profileLink).toHaveAttribute(
    "href",
    `#subscriptions?profile=${profiles[0].id}`,
  );
  await page.screenshot({
    path: testInfo.outputPath("source-accepted-related-objects.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await profileRows[0].scrollIntoViewIfNeeded();
  await expect(profileRows[0]).toBeInViewport({ ratio: 1 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.screenshot({
    path: testInfo.outputPath("source-duplicate-profiles-mobile.png"),
    animations: "disabled",
  });
  await outputRows[1].scrollIntoViewIfNeeded();
  await expect(outputRows[1]).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: testInfo.outputPath("source-duplicate-outputs-mobile.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await profileLink.click();
  await expect(page).toHaveURL(
    new RegExp(`#subscriptions\\?profile=${profiles[0].id}$`),
  );
  const scoped = page.getByRole("article", {
    name: `分流配置 ${sharedProfileName}`,
    exact: true,
  });
  await expect(scoped).toHaveCount(1);
  await scoped.getByRole("button", { name: "编辑配置", exact: true }).click();
  await page.getByRole("tab", { name: "检查与预览", exact: true }).click();
  const checked = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/profiles/preview") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "预览配置", exact: true }).click();
  const previewResponse = await checked;
  expect(
    previewResponse.status(),
    "Missing source reference is rejected by the real backend",
  ).toBe(400);
  const preview = await previewResponse.json();
  expect(preview.detail).toBe("defaultAction: endpoint reference missing");
  expect(preview.validation).toMatchObject({
    code: "missing_action_reference",
    location: { kind: "default" },
    reference: { kind: "endpoint", id: original.snapshot.endpoints[1].id },
  });
  const failure = page.getByRole("alert", {
    name: "无法检查：默认流量去向已不可用",
  });
  await expect(failure).toBeVisible();
  const realError = failure.getByText(preview.detail, { exact: true });
  await expect(realError).not.toBeVisible();
  await failure.getByText("技术信息", { exact: true }).click();
  await expect(realError).toBeVisible();
  await failure.getByText("技术信息", { exact: true }).click();
  await failure
    .getByRole("button", { name: "调整默认流量去向", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "默认流量行为", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("combobox", { name: "默认流量行为", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("dialog", { name: "草稿配置预览", exact: true }),
  ).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("source-removed-reference-real-error.png"),
    animations: "disabled",
  });
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "订阅来源", exact: true }),
  ).toBeVisible();
  const reopen = page.getByRole("button", {
    name: `查看上次应用结果 ${name}`,
    exact: true,
  });
  await reopen.click();
  await expect(receipt).toBeVisible();
  const outputLink = outputRows[1].getByRole("link", { name: /^查看订阅 / });
  await expect(outputLink).toHaveAttribute(
    "href",
    `#subscriptions?output=${outputs[1].id}`,
  );
  await outputLink.click();
  await expect(page).toHaveURL(
    new RegExp(`#subscriptions\\?output=${outputs[1].id}$`),
  );
  await expect(
    page.getByRole("dialog", {
      name: `${sharedOutputName} 的订阅详情`,
      exact: true,
    }),
  ).toBeVisible();
  await page.goBack();
  await expect(reopen).toBeVisible();
  await reopen.click();
  await receipt
    .getByRole("button", { name: "查看本次更新", exact: true })
    .click();
  await expect(receipt.getByText("Tokyo", { exact: true })).toBeVisible();
  await expect(receipt).not.toContainText("after-fixture");
  await receipt.getByRole("button", { name: "完成", exact: true }).click();
  await expect(receipt).not.toBeVisible();
  expect(
    await Promise.all(
      outputs.map((output) => frozenSourceOutput(page, output.id)),
    ),
  ).toEqual(beforeOutputs);
  const unchangedDraft = await (
    await page.request.get(`/api/me/profiles/${profiles[0].id}`)
  ).json();
  expect(unchangedDraft.ir.defaultAction).toEqual(profiles[0].ir.defaultAction);
  list = await (await page.request.get("/api/me/sources")).json();
  const accepted = list.find((item: { id: string }) => item.id === original.id);
  expect(accepted.candidate).toBeUndefined();
  expect(accepted.snapshot.endpoints).toHaveLength(1);
  expect(accepted.snapshot.endpoints[0].id).toBe(
    original.snapshot.endpoints[0].id,
  );
  await (await sourceRowAction(page, "刷新", name)).click();
  await expect(page.getByText("已是最新内容", { exact: true })).toBeVisible();
  await expect(review).not.toBeVisible();
  await (await sourceRowAction(page, "编辑", name)).click();
  await page.getByLabel("节点链接或配置内容").fill('{"proxies":[]}');
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "查看变化", exact: true }).click();
  await expect(review.getByText("此来源现在不含连接选项")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("source-review-mobile.png"),
    fullPage: false,
    animations: "disabled",
  });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await review
    .getByRole("button", { name: "忽略本次更新", exact: true })
    .click();
  await expect(review).not.toBeVisible();
  list = await (await page.request.get("/api/me/sources")).json();
  const rejected = list.find((item: { id: string }) => item.id === original.id);
  expect(rejected.snapshot.snapshotId).toBe(accepted.snapshot.snapshotId);
  expect(rejected.candidate).toBeUndefined();
  await testInfo.attach("journey-result", {
    body: JSON.stringify({
      journey: "source acceptance and exact related-object continuation",
      evidence: {
        setup:
          "two API-seeded same-named configurations and Outputs; local synthetic nodes",
        realSourceEditAndAcceptance: true,
        stableIdentityLinksNotNameLookup: true,
        visuallyIdenticalMetadataHasVisibleFullIdentityFallback: true,
        missingEndpointRejectedByRealBackend: 400,
        missingDraftReferencePreserved: true,
        frozenOutputContentAndAccessUnchanged: true,
        receiptReopenedAfterProfileAndOutputNavigation: true,
        rejectedCandidatePreservedAcceptedSnapshot: true,
      },
      scope:
        "Real loopback control plane; no live proxy traffic or runtime application.",
    }),
    contentType: "application/json",
  });
});
