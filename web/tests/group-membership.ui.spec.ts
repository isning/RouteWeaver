import { test, expect } from "@playwright/test";
import { openWorkspace, navigateWorkspace } from "./ui-session";

// Real loopback backend/rendering. Public setup provisions only synthetic inputs;
// all membership, source-scope and save decisions below use the Profile editor.
test("automatic members are an explicit additive choice over current source, collection and platform connections", async ({
  page,
}, info) => {
  page.setDefaultTimeout(5000);
  await openWorkspace(page);
  await navigateWorkspace(page, "我的订阅");
  const suffix = Date.now().toString(36);
  const profileName = `Membership ${suffix}`;
  const groupName = "Airport choice";
  const sourceName = `Airport ${suffix}`;
  const platformName = "Platform Gate";
  const sourceId = `membership-source-${suffix}`;
  const nodeId = `membership-node-${suffix}`;
  const routeId = `membership-route-${suffix}`;
  const entryId = `membership-entry-${suffix}`;
  const collectionId = `membership-collection-${suffix}`;
  let profileId: string | undefined;
  const read = async (path: string) => {
    const response = await page.request.get(`/api${path}`);
    expect(response.ok(), `Read ${path}`).toBe(true);
    return response.json();
  };
  // Other serialized journeys may have published their own synthetic Outputs.
  // Preserve the entire baseline, not an assumed empty workspace or filtered IDs.
  const outputSnapshot = async () =>
    (await read("/me/outputs")).sort((a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id),
    );
  const beforeOutputs = await outputSnapshot();
  const session = await read("/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const created: string[] = [];
  const evidence: { states: unknown[]; cleanup: unknown[] } = {
    states: [],
    cleanup: [],
  };
  const create = async (path: string, data: unknown, removePath = path) => {
    const response = await page.request.post(`/api${path}`, { headers, data });
    expect(response.ok(), `Synthetic setup ${path}: ${response.status()}`).toBe(
      true,
    );
    created.push(removePath);
    return response.json();
  };
  const choose = async (label: string, text: string) => {
    const input = page.getByRole("combobox", { name: label, exact: true });
    await input.click();
    const search = page.getByRole("combobox", {
      name: "搜索选项",
      exact: true,
    });
    await search.fill(text);
    await search.press("Enter");
    await page.keyboard.press("Escape");
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  };
  const profileWrites: string[] = [];
  const outputWrites: string[] = [];
  page.on("request", (request) => {
    if (!["POST", "PUT", "DELETE"].includes(request.method())) return;
    const path = new URL(request.url()).pathname;
    if (/^\/api\/me\/profiles(?:\/[^/]+)?$/.test(path))
      profileWrites.push(path);
    if (path.startsWith("/api/me/outputs")) outputWrites.push(path);
  });
  const group = page.locator(".group-card");
  const toggle = group.getByRole("switch", { name: "自动加入连接" });
  const saveAndInspect = async (
    state: string,
    members: string[],
    dynamic?: object,
  ) => {
    expect(profileWrites).toHaveLength(evidence.states.length);
    expect(outputWrites).toEqual([]);
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByText("草稿已保存", { exact: true })).toBeVisible();
    if (!profileId)
      profileId = (await read("/me/profiles")).find(
        (p: any) => p.name === profileName,
      )?.id;
    expect(profileId).toBeTruthy();
    const saved = await read(`/me/profiles/${profileId}/reveal`);
    const selected = saved.ir.groups.find((g: any) => g.name === groupName);
    expect(selected.dynamic).toEqual(dynamic);
    expect(selected.members).toHaveLength(1);
    expect(saved.platformEntryIds).toEqual([entryId]);
    const response = await page.request.post(
      `/api/me/profiles/${profileId}/preview`,
      {
        headers,
        data: {
          target: { adapterId: "sing-box", version: "1.14.3" },
          mode: "full",
        },
      },
    );
    expect(
      response.ok(),
      `Real public preview ${state}: ${response.status()}`,
    ).toBe(true);
    const preview = await response.json();
    const config = JSON.parse(
      preview.artifacts.find((a: any) => a.path.endsWith(".json")).content,
    );
    const selector = config.outbounds.find(
      (o: any) => o.type === "selector" && o.tag === groupName,
    );
    expect(selector.outbounds).toEqual(members);
    expect(config.route.final).toBe(groupName);
    evidence.states.push({
      state,
      dynamic: selected.dynamic ?? null,
      members: selector.outbounds,
      route: config.route.final,
      summary: await group.locator(".group-automatic-state").innerText(),
    });
  };
  try {
    await create(
      "/nodes",
      {
        id: nodeId,
        name: "Synthetic platform node",
        host: "platform.example.test",
        port: 1080,
        protocol: "socks",
        status: "unregistered",
      },
      `/nodes/${nodeId}`,
    );
    await create(
      "/routes",
      {
        id: routeId,
        name: "Synthetic assigned route",
        engine: "sing-box",
        hops: [nodeId],
        userIds: [session.user.id],
      },
      `/routes/${routeId}`,
    );
    await create(
      `/users/${session.user.id}/entries`,
      {
        id: entryId,
        name: platformName,
        routeId,
        credentialVersion: "fixture-v1",
        connection: {
          protocol: "socks",
          host: "platform.example.test",
          port: 1080,
        },
      },
      `/users/${session.user.id}/entries/${entryId}`,
    );
    await create(
      "/me/sources",
      {
        id: sourceId,
        name: sourceName,
        kind: "text",
        content:
          "socks5://north.example.test:1080#North Gate\nsocks5://south.example.test:1081#South Gate",
        enabled: true,
      },
      `/me/sources/${sourceId}`,
    );
    await create(
      "/me/collections",
      {
        id: collectionId,
        name: "North collection",
        sources: [{ sourceId, steps: [] }],
        steps: [
          {
            id: "only-north",
            kind: "keep",
            enabled: true,
            filter: { namePattern: "North" },
          },
        ],
      },
      `/me/collections/${collectionId}`,
    );
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .getByRole("button", { name: "新建分流配置", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "配置名称", exact: true })
      .fill(profileName);
    await choose("使用的订阅来源", sourceName);
    await choose("使用的平台入口", platformName);
    await expect(page.getByText("自有连接：2 个", { exact: true })).toBeVisible();
    await expect(page.getByText("平台入口：1 个", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "策略组", exact: true }).click();
    await page.getByRole("button", { name: "添加策略组", exact: true }).click();
    await page
      .getByRole("textbox", { name: "策略组名称", exact: true })
      .fill(groupName);
    await choose(`策略组「${groupName}」的固定成员`, "North Gate");
    await choose("默认流量行为", groupName);
    await expect(toggle).not.toBeChecked();
    await expect(group.getByText("仅固定成员", { exact: true })).toBeVisible();
    await saveAndInspect("off", ["North Gate"]);
    await group.screenshot({
      path: info.outputPath("group-off-1440.png"),
      animations: "disabled",
    });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeFocused();
    await expect(toggle).toBeChecked();
    await saveAndInspect("all", ["North Gate", "South Gate", platformName], {});
    await group.screenshot({
      path: info.outputPath("group-all-1440.png"),
      animations: "disabled",
    });
    await group.getByRole("button", { name: "筛选条件", exact: true }).click();
    await group.getByRole("textbox", { name: "地区", exact: true }).fill("ZZ");
    await saveAndInspect("no-automatic-matches", ["North Gate"], {
      region: "ZZ",
    });
    await group.getByRole("textbox", { name: "地区", exact: true }).fill("");
    await expect(toggle).toBeChecked();
    await saveAndInspect(
      "last-region-cleared",
      ["North Gate", "South Gate", platformName],
      {},
    );
    await group
      .getByRole("textbox", { name: "名称正则", exact: true })
      .fill("South");
    await saveAndInspect(
      "one-automatic-match-plus-fixed",
      ["North Gate", "South Gate"],
      { namePattern: "South" },
    );
    const sourceControl = group.getByRole("combobox", {
      name: "限定来源",
      exact: true,
    });
    await sourceControl.click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: sourceName, exact: true })
      .click();
    await group
      .getByRole("textbox", { name: "名称正则", exact: true })
      .fill("");
    await saveAndInspect("source-only", ["North Gate", "South Gate"], {
      sourceId,
    });
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await group.scrollIntoViewIfNeeded();
      await expect(toggle).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: info.outputPath(`group-filtered-${width}-full.png`),
        animations: "disabled",
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await sourceControl.click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "清除选择", exact: true })
      .click();
    await expect(sourceControl).toHaveAttribute("aria-expanded", "false");
    await expect(sourceControl).toContainText("不限来源");
    await expect(toggle).toBeChecked();
    await saveAndInspect(
      "last-source-cleared",
      ["North Gate", "South Gate", platformName],
      {},
    );
    await group.getByRole("textbox", { name: "地区", exact: true }).fill("ZZ");
    await expect(
      group.getByText("关闭将清除筛选条件", { exact: true }),
    ).toBeVisible();
    await toggle.click();
    await saveAndInspect("explicit-off-clears", ["North Gate"]);
    await toggle.click();
    await saveAndInspect(
      "re-enabled-all",
      ["North Gate", "South Gate", platformName],
      {},
    );
    await page.goto(`/#subscriptions?profile=${profileId}`);
    await page.reload();
    await page
      .getByRole("article", { name: `分流配置 ${profileName}`, exact: true })
      .getByRole("button", { name: "继续配置", exact: true })
      .click();
    // A fresh editor opens its ordinary routing tab; inspect persisted membership
    // through the visible group tab rather than an unmounted previous-session panel.
    await page.getByRole("tab", { name: "策略组", exact: true }).click();
    const savedGroupSummary = page.locator("summary").filter({ hasText: groupName });
    await expect(savedGroupSummary).toContainText("当前配置中的全部连接");
    await savedGroupSummary.click();
    await expect(toggle).toBeChecked();
    await expect(
      group.getByText("当前配置中的全部连接", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "编辑来源", exact: true }).click();
    await page
      .getByRole("radio", { name: "使用节点集合", exact: true })
      .check();
    const collection = page.getByRole("combobox", {
      name: "复用节点集合",
      exact: true,
    });
    await collection.click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "North collection", exact: true })
      .click();
    await expect(page.getByText("自有连接：1 个", { exact: true })).toBeVisible();
    await expect(page.getByText("平台入口：1 个", { exact: true })).toBeVisible();
    await saveAndInspect(
      "processed-collection-plus-platform",
      ["North Gate", platformName],
      {},
    );
    expect(profileWrites).toHaveLength(evidence.states.length);
    expect(outputWrites).toEqual([]);
    expect(await outputSnapshot()).toEqual(beforeOutputs);
  } finally {
    await info.attach("membership-states", {
      body: JSON.stringify(evidence.states, null, 2),
      contentType: "application/json",
    });
    if (!profileId)
      profileId = (await read("/me/profiles")).find(
        (p: any) => p.name === profileName,
      )?.id;
    for (const path of [
      ...(profileId ? [`/me/profiles/${profileId}`] : []),
      ...created.reverse(),
    ]) {
      const response = await page.request.delete(`/api${path}`, { headers });
      evidence.cleanup.push({
        kind: path.split("/").slice(0, -1).join("/"),
        status: response.status(),
      });
      expect(response.ok(), `Remove synthetic ${path}`).toBe(true);
    }
    expect(await outputSnapshot()).toEqual(beforeOutputs);
    await info.attach("membership-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
  }
});

