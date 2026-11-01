import { test, expect, type Page } from "@playwright/test";
import { openWorkspace } from "./ui-session";
const fullConfig = JSON.stringify({
  outbounds: [
    {
      type: "socks",
      tag: "London",
      server: "synthetic.example",
      server_port: 1080,
      version: "5",
    },
    { type: "direct", tag: "direct" },
  ],
  route: { final: "London" },
});
const cleanupJobs = new Map<Page, () => Promise<void>>();
test.afterEach(async ({ page }) => {
  await cleanupJobs.get(page)?.();
  cleanupJobs.delete(page);
});
const read = async (page: Page, path: string) => {
  const r = await page.request.get(`/api${path}`);
  expect(r.ok()).toBe(true);
  return r.json();
};
async function context(page: Page) {
  await openWorkspace(page);
  return {
    csrf: (await read(page, "/auth/me")).csrfToken,
    beforeProfiles: await read(page, "/me/profiles"),
    beforeOutputs: await read(page, "/me/outputs"),
  };
}
async function clean(
  page: Page,
  csrf: string,
  ids: string[],
  collection?: string,
) {
  if (collection)
    expect(
      (
        await page.request.delete(`/api/me/collections/${collection}`, {
          headers: { "X-CSRF-Token": csrf },
        })
      ).ok(),
    ).toBe(true);
  for (const id of ids)
    expect(
      (
        await page.request.delete(`/api/me/sources/${id}`, {
          headers: { "X-CSRF-Token": csrf },
        })
      ).ok(),
    ).toBe(true);
}
async function newCollection(page: Page, name: string) {
  await page.goto("/#collections");
  await page
    .getByRole("button", { name: "新建集合", exact: true })
    .first()
    .click();
  const parent = page.getByRole("dialog", { name: "新建集合", exact: true });
  await parent.getByLabel("集合名称", { exact: true }).fill(name);
  await parent.getByRole("button", { name: "添加来源", exact: true }).click();
  return page.getByRole("dialog", { name: "添加订阅来源", exact: true });
}
async function discardParent(page: Page, title: string) {
  await page
    .getByRole("dialog", { name: title, exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page
    .getByRole("alertdialog", { name: "放弃尚未保存的集合修改？", exact: true })
    .getByRole("button", { name: "放弃修改", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("full sing-box import returns directly to the rich collection draft without saving or publishing it", async ({
  page,
}, info) => {
  const { csrf, beforeProfiles, beforeOutputs } = await context(page);
  const suffix = Date.now().toString(36);
  const ids: string[] = [];
  let collectionID: string | undefined;
  const headers = { "X-CSRF-Token": csrf };
  try {
    for (const [index, name] of ["North", "South"].entries()) {
      const response = await page.request.post("/api/me/sources", {
        headers,
        data: {
          id: `src_task_${suffix}_${index}`,
          name,
          kind: "text",
          enabled: true,
          content: `socks5://synthetic.example:${1080 + index}#${name}`,
        },
      });
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).id);
    }
    const recipe = {
      id: `collection_task_${suffix}`,
      name: `Original ${suffix}`,
      sources: [
        {
          sourceId: ids[0],
          steps: [
            {
              id: "rename",
              kind: "rename",
              enabled: true,
              template: "{name}-saved",
            },
          ],
        },
        { sourceId: ids[1], steps: [] },
      ],
      steps: [{ id: "dedup", kind: "deduplicate", enabled: true }],
    };
    const seeded = await page.request.post("/api/me/collections", {
      headers,
      data: recipe,
    });
    expect(seeded.ok()).toBe(true);
    const savedRecipe = await seeded.json();
    collectionID = recipe.id;
    await page.goto("/#collections");
    await page
      .getByRole("button", {
        name: `Original ${suffix} 2 个来源 · 1 个聚合步骤 编辑集合`,
        exact: true,
      })
      .click();
    await page.getByLabel("集合名称", { exact: true }).fill(`Draft ${suffix}`);
    await page.getByRole("button", { name: "下移来源 1", exact: true }).click();
    await page.getByRole("button", { name: /2\. North.*来源处理/ }).click();
    await page
      .getByLabel("步骤 1 命名模板", { exact: true })
      .fill("unsaved-{name}");
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "添加订阅来源",
      exact: true,
    });
    await expect(
      editor.getByRole("radio", { name: "订阅 URL", exact: true }),
    ).toBeVisible();
    await editor.getByLabel("来源名称").fill(`Full config ${suffix}`);
    await editor.getByLabel("节点链接或配置内容").fill(fullConfig);
    const importWrites: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/me\/sources(?:$|\/[^/]+\/(?:apply|candidate\/accept)$)/.test(
          new URL(request.url()).pathname,
        )
      )
        importWrites.push(new URL(request.url()).pathname);
    });
    const imported = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/me/sources") && r.request().method() === "POST",
    );
    await editor
      .getByRole("button", { name: "导入来源", exact: true })
      .dblclick();
    const savedResponse = await imported;
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json();
    ids.push(saved.id);
    expect(saved.candidate).toBeUndefined();
    expect(saved.snapshot.endpoints).toHaveLength(1);
    expect(
      saved.diagnostics.map((item: { code: string }) => item.code),
    ).toEqual(["connection-extraction", "non-connection-outbound"]);
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "查看导入变化", exact: true }),
    ).toHaveCount(0);
    const parent = page.getByRole("dialog", {
      name: `Draft ${suffix}`,
      exact: true,
    });
    await expect(
      parent.getByRole("button", { name: "添加来源", exact: true }),
    ).toBeFocused();
    await expect(parent.getByText("1. South", { exact: true })).toBeVisible();
    await expect(
      parent.getByLabel("步骤 1 命名模板", { exact: true }),
    ).toHaveValue("unsaved-{name}");
    await expect(
      parent.getByText(`3. Full config ${suffix}`, { exact: true }),
    ).toBeVisible();
    expect(importWrites).toEqual(["/api/me/sources"]);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await parent.screenshot({
        path: info.outputPath(`direct-import-${width}.png`),
        animations: "disabled",
      });
      expect(
        await parent.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
    }
    const preview = page.waitForRequest((r) =>
      r.url().endsWith("/me/collections/preview"),
    );
    await parent
      .getByRole("button", { name: "预览处理结果", exact: true })
      .click();
    const body = (await preview).postDataJSON();
    expect(body.sources).toEqual([
      { sourceId: ids[1], steps: [] },
      {
        sourceId: ids[0],
        steps: [
          { ...savedRecipe.sources[0].steps[0], template: "unsaved-{name}" },
        ],
      },
      { sourceId: ids[2], steps: [] },
    ]);
    expect(body.steps).toEqual(savedRecipe.steps);
    await expect(parent.getByText("逐阶段预览", { exact: true })).toBeVisible();
    await parent.screenshot({
      path: info.outputPath("returned-parent-320.png"),
      animations: "disabled",
    });
    await discardParent(page, `Draft ${suffix}`);
    const persisted = (await read(page, "/me/collections")).find(
      (item: any) => item.id === collectionID,
    );
    expect(persisted.name).toBe(recipe.name);
    expect(persisted.sources).toEqual(savedRecipe.sources);
    expect(await read(page, "/me/profiles")).toEqual(beforeProfiles);
    expect(await read(page, "/me/outputs")).toEqual(beforeOutputs);
  } finally {
    cleanupJobs.set(page, () => clean(page, csrf, ids, collectionID));
  }
});

test("a real retained 422 returns its saved source for in-place correction without a duplicate or parent save", async ({
  page,
}, info) => {
  const { csrf, beforeProfiles, beforeOutputs } = await context(page);
  const ids: string[] = [];
  const name = `Retained ${Date.now().toString(36)}`;
  const beforeCollections = await read(page, "/me/collections");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const editor = await newCollection(page, "Keep this unsaved draft");
    await editor.getByLabel("来源名称").fill(name);
    await editor
      .getByLabel("节点链接或配置内容")
      .fill("invalid synthetic input");
    const failed = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/me/sources") && r.request().method() === "POST",
    );
    await editor.getByRole("button", { name: "导入来源", exact: true }).click();
    const response = await failed;
    expect(response.status()).toBe(422);
    const retained = (await response.json()).source;
    ids.push(retained.id);
    await expect(
      editor.getByText("输入已保存，导入未完成", { exact: true }),
    ).toBeVisible();
    await editor.screenshot({
      path: info.outputPath("saved-failed-input-390.png"),
      animations: "disabled",
    });
    await editor.getByRole("button", { name: /^取\s*消$/ }).click();
    const parent = page.getByRole("dialog", { name: "新建集合", exact: true });
    await expect(
      parent.getByRole("button", { name: "继续编辑", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("alertdialog", {
        name: "放弃尚未保存的来源修改？",
        exact: true,
      }),
    ).toHaveCount(0);
    await parent.getByRole("button", { name: "继续编辑", exact: true }).click();
    const correction = page.getByRole("dialog", {
      name: "编辑来源",
      exact: true,
    });
    await expect(correction.getByLabel("节点链接或配置内容")).toHaveValue(
      "invalid synthetic input",
    );
    await correction
      .getByLabel("节点链接或配置内容")
      .fill("socks5://synthetic.example:1080#Corrected");
    const corrected = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/me/sources/${retained.id}`) &&
        r.request().method() === "PUT",
    );
    await correction
      .getByRole("button", { name: "导入来源", exact: true })
      .click();
    expect((await corrected).status()).toBe(200);
    await expect(parent.getByText(`1. ${name}`, { exact: true })).toBeVisible();
    expect(
      (await read(page, "/me/sources")).filter((s: any) => s.name === name),
    ).toHaveLength(1);
    await discardParent(page, "新建集合");
    expect(await read(page, "/me/collections")).toEqual(beforeCollections);
    expect(await read(page, "/me/profiles")).toEqual(beforeProfiles);
    expect(await read(page, "/me/outputs")).toEqual(beforeOutputs);
  } finally {
    cleanupJobs.set(page, () => clean(page, csrf, ids));
  }
});

test("a committed manual application with a dropped response is read back without retry or unrelated saves", async ({
  page,
}, info) => {
  const { csrf, beforeProfiles, beforeOutputs } = await context(page);
  const ids: string[] = [];
  const headers = { "X-CSRF-Token": csrf };
  const name = `Lost response source ${Date.now().toString(36)}`;
  let decisionWrites = 0;
  try {
    const created = await page.request.post("/api/me/sources", {
      headers,
      data: {
        name,
        kind: "text",
        enabled: true,
        applyMode: "manual",
        content: "socks5://synthetic.example:1081#Earlier",
      },
    });
    expect(created.status()).toBe(200);
    const initial = await created.json();
    ids.push(initial.id);
    const updated = await page.request.put(`/api/me/sources/${initial.id}`, {
      headers,
      data: {
        id: initial.id,
        name,
        kind: "text",
        enabled: true,
        applyMode: "manual",
        revision: initial.revision,
        content: fullConfig,
      },
    });
    expect(updated.status()).toBe(200);
    const pending = await updated.json();
    expect(pending.candidate).toBeTruthy();
    expect(pending.snapshot).toEqual(initial.snapshot);
    await page.route(`**/api/me/sources/${initial.id}/apply`, async (route) => {
      decisionWrites++;
      expect(route.request().postDataJSON()).toEqual({
        candidateId: pending.candidate.id,
        sourceRevision: pending.revision,
      });
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    });
    await page.goto("/#sources");
    await page
      .getByRole("textbox", { name: "搜索来源", exact: true })
      .fill(name);
    await page
      .getByRole("button", { name: `应用更新 ${name}`, exact: true })
      .click();
    let review = page.getByRole("dialog", { name: "查看变化", exact: true });
    await expect(
      review.getByText("尚未确认这次选择的结果", { exact: true }),
    ).toBeVisible();
    await expect(
      review.getByRole("button", { name: "应用更新", exact: true }),
    ).toBeDisabled();
    await review
      .getByRole("button", { name: "核对当前状态", exact: true })
      .dblclick();
    review = page.getByRole("dialog", { name: "核对来源状态", exact: true });
    await expect(
      review.getByText("当前没有待检查内容", { exact: true }),
    ).toBeVisible();
    await expect(review.getByLabel("来源检查摘要")).toBeFocused();
    expect(decisionWrites).toBe(1);
    await expect(
      page.getByRole("dialog", { name: "上次应用详情", exact: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await review.screenshot({
      path: info.outputPath("verified-current-390.png"),
      animations: "disabled",
    });
    await review.getByRole("button", { name: "返回来源", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `应用更新 ${name}`, exact: true }),
    ).toHaveCount(0);
    const current = await read(page, `/me/sources/${initial.id}`);
    expect(current.candidate).toBeUndefined();
    expect(current.snapshot.snapshotId).not.toBe(initial.snapshot.snapshotId);
    expect(current.snapshot.endpoints).toHaveLength(1);
    expect(current.applyHistory).toHaveLength(2);
    expect(decisionWrites).toBe(1);
    expect(await read(page, "/me/profiles")).toEqual(beforeProfiles);
    expect(await read(page, "/me/outputs")).toEqual(beforeOutputs);
  } finally {
    cleanupJobs.set(page, () => clean(page, csrf, ids));
  }
});

test("a rich Profile keeps its routing and ordered inputs through immediate real Mihomo import", async ({
  page,
}, info) => {
  const { csrf, beforeOutputs } = await context(page);
  const ids: string[] = [];
  const headers = { "X-CSRF-Token": csrf };
  const suffix = Date.now().toString(36);
  let profileID: string | undefined;
  try {
    const endpoints: any[] = [];
    for (const [index, name] of ["Profile North", "Profile South"].entries()) {
      const response = await page.request.post("/api/me/sources", {
        headers,
        data: {
          id: `src_profile_task_${suffix}_${index}`,
          name,
          kind: "text",
          enabled: true,
          content: `socks5://synthetic.example:${1080 + index}#${encodeURIComponent(name)}`,
        },
      });
      expect(response.ok()).toBe(true);
      const saved = await response.json();
      ids.push(saved.id);
      endpoints.push(saved.snapshot.endpoints[0]);
    }
    const id = `profile_task_${suffix}`;
    const original = {
      id,
      name: `Profile task ${suffix}`,
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      sourceIds: [ids[1], ids[0]],
      ir: {
        schemaVersion: "1.0",
        id,
        name: `Profile task ${suffix}`,
        ownerId: "",
        revision: "1",
        endpoints: [],
        groups: [
          {
            id: "chosen-group",
            name: "Chosen group",
            kind: "select",
            members: [{ kind: "endpoint", ref: endpoints[0].id }],
            dynamic: {},
          },
        ],
        rules: [
          {
            id: "kept-rule",
            match: { op: "domain-suffix", value: "example.com" },
            action: { kind: "group", ref: "chosen-group" },
          },
        ],
        resources: [],
        defaultAction: { kind: "group", ref: "chosen-group" },
        runtime: { mixedPort: 7890 },
      },
    };
    expect(
      (
        await page.request.post("/api/me/profiles", { headers, data: original })
      ).ok(),
    ).toBe(true);
    profileID = id;
    await page.goto("/#subscriptions");
    await page.reload();
    // This API-created Profile may be beyond the current public list page.
    await page
      .getByRole("textbox", { name: "搜索配置或客户端订阅", exact: true })
      .fill(original.name);
    const card = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: original.name, exact: true }),
    });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "继续配置", exact: true }).click();
    await page
      .getByLabel("配置名称", { exact: true })
      .fill("Unsaved rich Profile");
    await page.getByRole("tab", { name: "策略组", exact: true }).click();
    await page
      .getByLabel("策略组名称", { exact: true })
      .fill("Unsaved chosen group");
    await page.getByRole("button", { name: "编辑来源", exact: true }).click();
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "添加订阅来源",
      exact: true,
    });
    await editor.getByLabel("来源名称").fill("Full Mihomo source");
    await editor
      .getByLabel("节点链接或配置内容")
      .fill(
        "proxies:\n  - name: Profile London\n    type: socks5\n    server: synthetic.example\n    port: 1080\nrules:\n  - MATCH,DIRECT\n",
      );
    const importWrites: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/me\/sources(?:$|\/[^/]+\/(?:apply|candidate\/accept)$)/.test(
          new URL(request.url()).pathname,
        )
      )
        importWrites.push(new URL(request.url()).pathname);
    });
    const created = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/me/sources") && r.request().method() === "POST",
    );
    await editor.getByRole("button", { name: "导入来源", exact: true }).focus();
    await page.keyboard.down("Enter");
    const source = await (await created).json();
    ids.push(source.id);
    expect(source.candidate).toBeUndefined();
    expect(source.snapshot.endpoints).toHaveLength(1);
    expect(
      source.diagnostics.map((item: { code: string }) => item.code),
    ).toContain("connection-extraction");
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "查看导入变化", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
      "Unsaved rich Profile",
    );
    await expect(page.getByLabel("策略组名称", { exact: true })).toHaveValue(
      "Unsaved chosen group",
    );
    const selectedSourceControl = page.getByRole("combobox", {
      name: "使用的订阅来源",
      exact: true,
    });
    await expect(selectedSourceControl).toContainText("已选择 3 项");
    const selectedSources = selectedSourceControl
      .locator("xpath=ancestor::label")
      .getByLabel("已选项目", { exact: true });
    const selectedNames = [
      "Profile South",
      "Profile North",
      "Full Mihomo source",
    ];
    for (const name of selectedNames)
      await expect(
        selectedSources.getByText(name, { exact: true }),
      ).toBeVisible();
    expect(
      await selectedSources
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        ),
    ).toEqual(selectedNames.map((name) => `移除 ${name}`));
    await expect(
      page.getByRole("button", { name: "添加来源", exact: true }),
    ).toBeFocused();
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expect(
      page.getByRole("dialog", { name: "添加订阅来源", exact: true }),
    ).toHaveCount(0);
    expect(importWrites).toEqual(["/api/me/sources"]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: info.outputPath("profile-returned-390.png"),
      animations: "disabled",
      fullPage: false,
    });
    // Public editable JSON shows the unsaved draft without saving or publishing it.
    await page.getByRole("tab", { name: "运行设置", exact: true }).click();
    await page
      .getByRole("button", { name: "高级：配置意图与目标版本", exact: true })
      .click();
    await page
      .getByRole("button", { name: "编辑配置意图 JSON", exact: true })
      .click();
    const draftIR = JSON.parse(
      await page.getByLabel("配置意图 JSON 文本", { exact: true }).inputValue(),
    );
    expect(draftIR.groups).toEqual([
      { ...original.ir.groups[0], name: "Unsaved chosen group" },
    ]);
    expect(draftIR.rules).toEqual(original.ir.rules);
    expect(draftIR.defaultAction).toEqual(original.ir.defaultAction);
    await page
      .getByRole("dialog", { name: "配置意图 JSON", exact: true })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    const persisted = await read(page, `/me/profiles/${profileID}/reveal`);
    expect(persisted.name).toBe(original.name);
    expect(persisted.sourceIds).toEqual(original.sourceIds);
    expect(persisted.ir.groups).toEqual(original.ir.groups);
    expect(await read(page, "/me/outputs")).toEqual(beforeOutputs);
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true })
      .getByRole("button", { name: "放弃修改", exact: true })
      .click();
  } finally {
    cleanupJobs.set(page, async () => {
      if (profileID)
        expect(
          (
            await page.request.delete(`/api/me/profiles/${profileID}`, {
              headers,
            })
          ).ok(),
        ).toBe(true);
      await clean(page, csrf, ids);
    });
  }
});
