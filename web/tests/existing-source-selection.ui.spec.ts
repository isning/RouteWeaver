import { test, expect, type Page } from "@playwright/test";
import { openWorkspace } from "./ui-session";
import { emptyProfile } from "../src/model";
const jobs = new Map<Page, () => Promise<void>>();
test.afterEach(async ({ page }) => {
  await jobs.get(page)?.();
  jobs.delete(page);
});
async function setup(page: Page) {
  await openWorkspace(page);
  const csrf = (await (await page.request.get("/api/auth/me")).json())
    .csrfToken;
  const headers = { "X-CSRF-Token": csrf };
  const records: { kind: string; id: string }[] = [];
  jobs.set(page, async () => {
    for (const kind of ["profiles", "collections", "sources"])
      for (const r of records.filter((r) => r.kind === kind))
        expect(
          (
            await page.request.delete(`/api/me/${kind}/${r.id}`, { headers })
          ).ok(),
        ).toBe(true);
  });
  const put = async (kind: string, data: any, expectedStatus = 200) => {
    const response = await page.request.post(`/api/me/${kind}`, {
      headers,
      data,
    });
    expect(response.status()).toBe(expectedStatus);
    records.push({ kind, id: data.id });
    const result = await response.json();
    return expectedStatus === 422 ? result.source : result;
  };
  const read = async (path: string) => {
    const r = await page.request.get(`/api/me/${path}`);
    expect(r.ok()).toBe(true);
    return r.json();
  };
  return { headers, put, read };
}
const full = JSON.stringify({
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
const source = (
  id: string,
  name: string,
  content = `socks5://synthetic.example:1080#${name}`,
) => ({ id, name, kind: "text", enabled: true, content });

test("an existing failed first import is selected explicitly and corrected in the same rich Collection draft", async ({
  page,
}, info) => {
  const { put, read } = await setup(page);
  const prefix = `selection_${Date.now().toString(36)}`;
  const north = await put("sources", source(`${prefix}_north`, "North"));
  const south = await put("sources", source(`${prefix}_south`, "South"));
  const original = await put("collections", {
    id: `${prefix}_collection`,
    name: "Original selection collection",
    sources: [
      {
        sourceId: north.id,
        steps: [
          {
            id: "rename",
            kind: "rename",
            enabled: true,
            template: "{name}-saved",
          },
        ],
      },
      { sourceId: south.id, steps: [] },
    ],
    steps: [{ id: "dedup", kind: "deduplicate", enabled: true }],
  });
  const pending = await put(
    "sources",
    source(`${prefix}_pending`, "Pending provider", "invalid synthetic input"),
    422,
  );
  expect(pending.snapshot).toBeUndefined();
  expect(pending.candidate).toBeUndefined();
  expect(pending.refreshStatus).toBe("failed");
  await page.goto("/#collections");
  await page
    .getByRole("button", { name: /Original selection collection/ })
    .click();
  await page
    .getByLabel("集合名称", { exact: true })
    .fill("Unsaved selection collection");
  await page.getByRole("button", { name: "下移来源 1", exact: true }).click();
  await page.getByRole("button", { name: /2\. North.*来源处理/ }).click();
  await page
    .getByLabel("步骤 1 命名模板", { exact: true })
    .fill("unsaved-{name}");
  await page.getByRole("combobox", { name: "订阅来源", exact: true }).click();
  await page
    .getByText("Pending provider · 导入未完成，尚无可用节点", { exact: true })
    .last()
    .click();
  await page.getByLabel("集合名称", { exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "保存集合", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "预览处理结果", exact: true }),
  ).toBeDisabled();
  const issues = page.getByRole("region", { name: "需要处理的来源" });
  await expect(
    issues.getByText("Pending provider · 导入未完成，尚无可用节点", {
      exact: true,
    }),
  ).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 390) {
      for (const button of await issues.getByRole("button").all()) {
        const box = await button.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
    }
    await page
      .getByRole("dialog", {
        name: "Unsaved selection collection",
        exact: true,
      })
      .screenshot({
        path: info.outputPath(`selection-${width}.png`),
        animations: "disabled",
      });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await issues
    .getByRole("button", { name: "编辑来源 Pending provider", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "编辑来源", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "编辑来源 Pending provider",
      exact: true,
    }),
  ).toBeFocused();
  await expect(page.getByText("来源尚未加入集合", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "编辑来源 Pending provider", exact: true })
    .click();
  let decisions = 0;
  page.on("request", (r) => {
    if (r.url().endsWith(`/sources/${pending.id}`) && r.method() === "PUT")
      decisions++;
  });
  const accepted = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/sources/${pending.id}`) &&
      r.request().method() === "PUT",
  );
  const correction = page.getByRole("dialog", {
    name: "编辑来源",
    exact: true,
  });
  await correction.getByLabel("节点链接或配置内容", { exact: true }).fill(full);
  await correction
    .getByRole("button", { name: "导入来源", exact: true })
    .focus();
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  expect(decisions).toBe(0);
  await page.keyboard.up("Space");
  const response = await accepted;
  expect(response.status()).toBe(200);
  const corrected = await response.json();
  expect(corrected.id).toBe(pending.id);
  expect(corrected.candidate).toBeUndefined();
  expect(corrected.snapshot.endpoints).toHaveLength(1);
  const parent = page.getByRole("dialog", {
    name: "Unsaved selection collection",
    exact: true,
  });
  await expect(
    parent.getByRole("button", { name: "添加来源", exact: true }),
  ).toBeFocused();
  expect(decisions).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(parent.getByText("1. South", { exact: true })).toBeVisible();
  await expect(
    parent.getByText("3. Pending provider", { exact: true }),
  ).toBeVisible();
  await expect(
    parent.getByLabel("步骤 1 命名模板", { exact: true }),
  ).toHaveValue("unsaved-{name}");
  const request = page.waitForRequest((r) =>
    r.url().endsWith("/me/collections/preview"),
  );
  await parent
    .getByRole("button", { name: "预览处理结果", exact: true })
    .click();
  const body = (await request).postDataJSON();
  expect(body.sources.map((r: any) => r.sourceId)).toEqual([
    south.id,
    north.id,
    pending.id,
  ]);
  expect(body.sources[1].steps[0].template).toBe("unsaved-{name}");
  expect(body.steps).toEqual(original.steps);
  expect(await read(`collections/${original.id}`)).toEqual(original);
});

test("Profile collection source correction preserves mode and intent; explicit clear removes only its input selection", async ({
  page,
}, info) => {
  const { headers, put, read } = await setup(page);
  const prefix = `profile_selection_${Date.now().toString(36)}`;
  const imported = source(`${prefix}_source`, "Paused collection provider");
  const accepted = await put("sources", imported);
  const collection = await put("collections", {
    id: `${prefix}_collection`,
    name: "Selected shared collection",
    sources: [
      {
        sourceId: accepted.id,
        steps: [
          {
            id: "rename",
            kind: "rename",
            enabled: true,
            template: "{name}-kept",
          },
        ],
      },
    ],
    steps: [],
  });
  const profile = emptyProfile();
  profile.id = `${prefix}_profile`;
  profile.name = "Collection mode Profile";
  profile.collectionId = collection.id;
  profile.ir.groups = [
    {
      id: "kept-group",
      name: "Kept group",
      kind: "select",
      members: [],
      dynamic: {},
    },
  ];
  profile.ir.defaultAction = { kind: "group", ref: "kept-group" };
  profile.ir.rules = [
    {
      id: "kept-rule",
      match: { op: "domain-suffix", value: "example.com" },
      action: { kind: "group", ref: "kept-group" },
    },
  ];
  await put("profiles", profile);
  const original = await read(`profiles/${profile.id}/reveal`);
  expect(
    (
      await page.request.put(`/api/me/sources/${accepted.id}`, {
        headers,
        data: { ...imported, revision: accepted.revision, enabled: false },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/#subscriptions");
  await page.reload();
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: profile.name, exact: true }),
    })
    .getByRole("button", { name: "继续配置", exact: true })
    .click();
  await page
    .getByLabel("配置名称", { exact: true })
    .fill("Unsaved collection mode Profile");
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("source has no enabled accepted snapshot", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "编辑来源 Paused collection provider",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "编辑来源", exact: true })
    .getByRole("button", { name: /取\s*消/ })
    .click();
  await expect(
    page.getByRole("button", {
      name: "编辑来源 Paused collection provider",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    page.getByText("来源已保存，尚未加入此草稿", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "编辑来源 Paused collection provider",
      exact: true,
    })
    .click();
  const editor = page.getByRole("dialog", { name: "编辑来源", exact: true });
  await editor.getByRole("switch", { name: "启用来源", exact: true }).click();
  let sourceWrites = 0;
  page.on("request", (r) => {
    if (r.url().endsWith(`/sources/${accepted.id}`) && r.method() === "PUT")
      sourceWrites++;
  });
  const changed = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/sources/${accepted.id}`) &&
      r.request().method() === "PUT",
  );
  await editor.getByRole("button", { name: "导入来源", exact: true }).focus();
  await page.keyboard.down("Enter");
  expect((await changed).status()).toBe(200);
  // The selected source's repair action disappears once it is usable. Return
  // to the visible source disclosure, not the concealed Add source control.
  const sourceSettings = page.getByRole("button", {
    name: "编辑来源",
    exact: true,
  });
  await expect(sourceSettings).toBeFocused();
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  expect(sourceWrites).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(sourceSettings).toHaveAttribute("aria-expanded", "false");
  await sourceSettings.click();
  await expect(
    page.getByRole("radio", { name: "使用节点集合", exact: true }),
  ).toBeChecked();
  await expect(
    page
      .getByRole("combobox", { name: "复用节点集合", exact: true })
      .locator("xpath=ancestor::label"),
  ).toContainText(collection.name);
  expect(await read(`profiles/${profile.id}/reveal`)).toEqual(original);
  expect(await read(`collections/${collection.id}`)).toEqual(collection);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: info.outputPath("profile-returned-390.png"),
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page
    .getByRole("combobox", { name: "复用节点集合", exact: true })
    .click();
  await page.getByRole("option", { name: "清除选择", exact: true }).click();
  await expect(page.getByText("0 个有效连接", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "使用节点集合", exact: true }),
  ).toBeChecked();
  const savedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/profiles/${profile.id}`) &&
      r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  const response = await savedResponse;
  expect(response.status()).toBe(200);
  const body = response.request().postDataJSON();
  expect(body.collectionId).toBeUndefined();
  expect(body.sourceIds).toEqual([]);
  expect(body.ir.endpoints).toEqual([]);
  expect(body.ir.groups).toEqual(original.ir.groups);
  expect(body.ir.rules).toEqual(original.ir.rules);
  expect(body.ir.defaultAction).toEqual(original.ir.defaultAction);
  expect(await read(`collections/${collection.id}`)).toEqual(collection);
});

test("removing the last direct Source keeps input focus and saves no old materialized connections", async ({
  page,
}, info) => {
  const { headers, put, read } = await setup(page);
  const prefix = `direct_remove_${Date.now().toString(36)}`;
  const input = source(`${prefix}_source`, "Paused direct provider");
  const accepted = await put("sources", input);
  const profile = emptyProfile();
  profile.id = `${prefix}_profile`;
  profile.name = "Remove last Source";
  profile.sourceIds = [accepted.id];
  await put("profiles", profile);
  const original = await read(`profiles/${profile.id}/reveal`);
  expect(original.ir.endpoints.length).toBe(1);
  const pausedResponse = await page.request.put(
    `/api/me/sources/${accepted.id}`,
    {
      headers,
      data: { ...input, revision: accepted.revision, enabled: false },
    },
  );
  expect(pausedResponse.ok()).toBe(true);
  const paused = await read(`sources/${accepted.id}`);
  await page.goto("/#subscriptions");
  await page.reload();
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: profile.name, exact: true }),
    })
    .getByRole("button", { name: "继续配置", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "保存草稿", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "移除来源 Paused direct provider",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("combobox", { name: "使用的订阅来源", exact: true }),
  ).toBeFocused();
  await expect(page.getByText("0 个有效连接", { exact: true })).toBeVisible();
  const savedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/profiles/${profile.id}`) &&
      r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  const saved = await savedResponse;
  expect(saved.status()).toBe(200);
  const body = saved.request().postDataJSON();
  expect(body.sourceIds).toEqual([]);
  expect(body.collectionId).toBeUndefined();
  expect(body.ir.endpoints).toEqual([]);
  expect(body.ir.defaultAction).toEqual(original.ir.defaultAction);
  expect(await read(`sources/${accepted.id}`)).toEqual(paused);
  await page.screenshot({
    path: info.outputPath("direct-source-removed.png"),
    animations: "disabled",
  });
});
