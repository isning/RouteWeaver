import { createHash } from "node:crypto";
import {
  expect,
  test,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import type { Output } from "../src/types";
import { openWorkspace, navigateWorkspace } from "./ui-session";

// Setup is explicit synthetic API fixture creation. The recovery/publication
// journey uses the real UI/backend; only one owner reveal response is faulted.
// Never retain access credentials in traces, screenshots, video or attachments.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api${path}`);
  expect(response.ok(), `Read owned synthetic ${path}`).toBe(true);
  return response.json();
}

async function publication(page: Page, id: string) {
  const outputs = await read<Output[]>(page, "/me/outputs");
  const metadata = outputs.find((output) => output.id === id);
  expect(metadata, "The exact owned Output remains available").toBeTruthy();
  const access = await read<{ feedPath: string }>(
    page,
    `/me/outputs/${id}/access`,
  );
  const path = new URL(access.feedPath, "http://127.0.0.1:4173").pathname;
  const feed = await page.request.get(path);
  expect(feed.ok(), "Frozen synthetic delivery is readable").toBe(true);
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return {
    metadata: metadata!,
    accessHash: hash(path),
    feedHash: hash(await feed.text()),
  };
}

test("source replacement recovery preserves selected Output and sibling publication until explicit update", async ({
  page,
}, info) => {
  page.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  const session = await read<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const suffix = Date.now().toString(36);
  const sourceID = `recovery-source-${suffix}`;
  const profileID = `recovery-profile-${suffix}`;
  const sourceName = `云帆机场 ${suffix}`;
  const profileName = `日常分流 ${suffix}`;
  const owned = {
    sources: [] as string[],
    profiles: [] as string[],
    outputs: [] as string[],
  };
  const outputWrites: { method: string; path: string }[] = [];
  const watchWrites = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
      /^\/api\/me\/outputs(?:\/|$)/.test(path)
    )
      outputWrites.push({ method: request.method(), path });
  };
  const revealPattern = `**/api/me/profiles/${profileID}/reveal`;
  let revealFault: ((route: Route) => Promise<void>) | undefined;
  try {
    const createdSource = await page.request.post("/api/me/sources", {
      headers,
      data: {
        id: sourceID,
        name: sourceName,
        kind: "text",
        applyMode: "manual",
        enabled: true,
        content:
          "socks5://hongkong.synthetic.invalid:1080#香港-日常\nsocks5://tokyo.synthetic.invalid:1080#东京-ChatGPT",
      },
    });
    expect(createdSource.ok(), "Create owned synthetic source").toBe(true);
    owned.sources.push(sourceID);
    const source: { snapshot: { endpoints: { id: string; name: string }[] } } =
      await createdSource.json();
    const hongkong = source.snapshot.endpoints.find(
      (node) => node.name === "香港-日常",
    )!;
    const tokyo = source.snapshot.endpoints.find(
      (node) => node.name === "东京-ChatGPT",
    )!;
    const profile = {
      id: profileID,
      name: profileName,
      sourceIds: [sourceID],
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      ir: {
        schemaVersion: "1.0",
        id: profileID,
        name: profileName,
        ownerId: "",
        revision: "1",
        endpoints: [],
        groups: [],
        resources: [],
        rules: [
          {
            id: "chatgpt",
            match: { op: "domain-suffix", value: "chatgpt.com" },
            action: { kind: "endpoint", ref: tokyo.id },
          },
        ],
        defaultAction: { kind: "endpoint", ref: hongkong.id },
        runtime: { mixedPort: 7890 },
      },
    };
    const saved = await page.request.post("/api/me/profiles", {
      headers,
      data: profile,
    });
    expect(saved.ok(), "Create owned synthetic configuration").toBe(true);
    owned.profiles.push(profileID);
    const outputs: Output[] = [];
    for (const [label, adapterId, version] of [
      ["MacBook", "mihomo", "1.19.32"],
      ["Android", "sing-box", "1.14.3"],
    ]) {
      const id = `recovery-${label.toLowerCase()}-${suffix}`;
      const created = await page.request.post("/api/me/outputs", {
        headers,
        data: {
          id,
          name: `${label} ${suffix}`,
          profileId: profileID,
          target: { adapterId, version },
          mode: "full",
        },
      });
      expect(created.ok(), "Create owned synthetic publication").toBe(true);
      owned.outputs.push(id);
      outputs.push(await created.json());
    }
    const [selected, sibling] = outputs;
    const before = await Promise.all(
      outputs.map((output) => publication(page, output.id)),
    );
    const unchanged = async () =>
      expect(
        await Promise.all(
          outputs.map((output) => publication(page, output.id)),
        ),
      ).toEqual(before);
    page.on("request", watchWrites);
    await page.reload();
    await page.getByText("订阅素材", { exact: true }).click();
    await navigateWorkspace(page, "订阅来源");
    await page
      .getByRole("button", { name: `编辑 ${sourceName}`, exact: true })
      .click();
    await page
      .getByLabel("节点链接或配置内容", { exact: true })
      .fill(
        "socks5://hongkong.synthetic.invalid:1081#香港-日常\nsocks5://tokyo.synthetic.invalid:1080#东京-ChatGPT",
      );
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: `应用更新 ${sourceName}`, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", {
        name: `查看上次应用结果 ${sourceName}`,
        exact: true,
      })
      .click();
    const receipt = page.getByRole("dialog", {
      name: "上次应用详情",
      exact: true,
    });
    await unchanged();
    expect(outputWrites).toEqual([]);
    await receipt
      .getByRole("link", { name: `查看订阅 ${selected.name}`, exact: true })
      .click();
    const detail = page.getByRole("dialog", {
      name: `订阅详情 · ${selected.name}`,
      exact: true,
    });
    const cause = "已保存配置的默认流量去向不可用。已发布内容未因此改变。";
    const repair = detail.getByRole("button", {
      name: `修复「${profileName}」配置`,
      exact: true,
    });
    await expect(detail.getByText(cause, { exact: true })).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "重新检查更新", exact: true }),
    ).toHaveCount(0);
    const status = await read<{ draftComparison: unknown }>(
      page,
      `/me/outputs/${selected.id}/status`,
    );
    expect(status.draftComparison).toEqual({
      state: "unavailable",
      reason: "missing-action-reference",
      location: "default",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await repair.scrollIntoViewIfNeeded();
    await expect(repair).toBeInViewport({ ratio: 1 });
    expect(
      await repair.evaluate(
        (element) => element.getBoundingClientRect().right <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });

    let injected = 0;
    revealFault = async (route) => {
      injected++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "配置暂时无法读取，请重试" }),
      });
    };
    await page.route(revealPattern, revealFault);
    await repair.click();
    await expect(
      detail
        .getByRole("alert")
        .getByText("配置暂时无法读取，请重试", { exact: true }),
    ).toBeVisible();
    expect(injected).toBe(1);
    await page.unroute(revealPattern, revealFault);
    revealFault = undefined;
    await unchanged();
    await repair.click();
    await expect(
      page.getByRole("alert", { name: "部分流量去向当前不可用", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(repair).toBeFocused();
    expect(new URL(page.url()).hash).toBe(
      `#subscriptions?output=${selected.id}`,
    );
    await unchanged();
    expect(outputWrites).toEqual([]);

    await repair.click();
    const control = page.getByRole("combobox", {
      name: "默认流量行为",
      exact: true,
    });
    await control.click();
    const search = page.getByRole("combobox", {
      name: "搜索选项",
      exact: true,
    });
    await search.fill("香港-日常");
    await search.press("Enter");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(
      page
        .getByRole("group", { name: "保存与检查配置", exact: true })
        .getByRole("status"),
    ).toHaveText("草稿已保存");
    await unchanged();
    expect(outputWrites).toEqual([]);
    await page.getByRole("button", { name: "检查发布", exact: true }).click();
    const chooser = page.getByRole("dialog", {
      name: "选择客户端订阅",
      exact: true,
    });
    await expect(
      chooser.getByRole("radio", {
        name: `更新「${selected.name}」 · mihomo · 完整配置`,
        exact: true,
      }),
    ).toBeChecked();
    await chooser
      .getByRole("button", { name: "返回编辑", exact: true })
      .click();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    const check = detail.getByRole("button", { name: "检查更新", exact: true });
    await expect(check).toBeFocused();
    await expect(
      detail.getByText("已保存的修改尚未发布", { exact: true }),
    ).toBeVisible();
    await check.click();
    const update = page.getByRole("dialog", {
      name: `检查订阅更新「${selected.name}」`,
      exact: true,
    });
    const confirm = update.getByRole("button", {
      name: `确认更新「${selected.name}」`,
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    await unchanged();
    expect(outputWrites).toEqual([]);
    await confirm.click();
    await expect(update).not.toBeVisible();
    const after = await Promise.all(
      outputs.map((output) => publication(page, output.id)),
    );
    expect(after[1]).toEqual(before[1]);
    expect(after[0].metadata.id).toBe(selected.id);
    expect(after[0].metadata.profileId).toBe(profileID);
    expect(after[0].metadata.target).toEqual(before[0].metadata.target);
    expect(after[0].metadata.revision).not.toBe(before[0].metadata.revision);
    expect(after[0].feedHash).not.toBe(before[0].feedHash);
    expect(after[0].accessHash).toBe(before[0].accessHash);
    expect(outputWrites).toEqual([
      { method: "POST", path: `/api/me/outputs/${selected.id}/publish` },
    ]);
    const siblingStatus = await read<{ draftComparison: { state: string } }>(
      page,
      `/me/outputs/${sibling.id}/status`,
    );
    expect(siblingStatus.draftComparison.state).toBe("changed");
    await info.attach("selected-output-recovery", {
      body: JSON.stringify({
        sourceAcceptedWithoutPublication: true,
        sameSelectedOutputPreserved: true,
        revealFaultCount: injected,
        cancelFocus: "repair",
        savedRepairFocus: "check-update",
        explicitSelectedUpdateOnly: true,
        siblingCompletePublicMetadataAndFeedUnchanged: true,
        scope:
          "Real loopback UI/backend with owned synthetic fixtures and one injected reveal503. Full persisted-record equality is separately covered at the HTTP/persistence seam.",
      }),
      contentType: "application/json",
    });
  } finally {
    page.off("request", watchWrites);
    if (revealFault) await page.unroute(revealPattern, revealFault);
    // Outputs expose no DELETE API: revoke only owned synthetic access first.
    // The demo shutdown removes the retained revocation receipts.
    for (const id of owned.outputs) {
      const response = await page.request.post(`/api/me/outputs/${id}/revoke`, {
        headers,
        data: {},
      });
      expect(response.ok(), "Revoke owned synthetic Output").toBe(true);
    }
    for (const kind of ["profiles", "sources"] as const) {
      for (const id of owned[kind]) {
        const response = await page.request.delete(`/api/me/${kind}/${id}`, {
          headers,
        });
        expect(response.ok(), `Remove owned synthetic ${kind}`).toBe(true);
      }
    }
  }
});

test("update-check copy and neutral detail remain readable at desktop and 390px without extra operations", async ({
  page,
}, info) => {
  await openWorkspace(page);
  const session = await read<{ csrfToken: string }>(page, "/auth/me");
  const headers = { "X-CSRF-Token": session.csrfToken };
  const suffix = Date.now().toString(36);
  const sourceID = `copy-source-${suffix}`,
    profileID = `copy-profile-${suffix}`;
  const sourceName = `检查更新来源 ${suffix}`,
    profileName = `日常设备更新 ${suffix}`;
  const owned = {
    sources: [] as string[],
    profiles: [] as string[],
    outputs: [] as string[],
  };
  const requests: { method: string; path: string }[] = [];
  const observe = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/me/"))
      requests.push({ method: request.method(), path });
  };
  try {
    const createdSource = await page.request.post("/api/me/sources", {
      headers,
      data: {
        id: sourceID,
        name: sourceName,
        kind: "text",
        enabled: true,
        content:
          "socks5://hongkong.synthetic.invalid:1080#香港-日常\nsocks5://tokyo.synthetic.invalid:1080#东京-ChatGPT",
      },
    });
    expect(createdSource.ok(), "Create owned synthetic source").toBe(true);
    owned.sources.push(sourceID);
    const source: { snapshot: { endpoints: { id: string; name: string }[] } } =
      await createdSource.json();
    const hongkong = source.snapshot.endpoints.find(
      (node) => node.name === "香港-日常",
    )!;
    const tokyo = source.snapshot.endpoints.find(
      (node) => node.name === "东京-ChatGPT",
    )!;
    const profile = {
      id: profileID,
      name: profileName,
      sourceIds: [sourceID],
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      ir: {
        schemaVersion: "1.0",
        id: profileID,
        name: profileName,
        ownerId: "",
        revision: "1",
        endpoints: [],
        groups: [],
        resources: [],
        rules: [
          {
            id: "chatgpt",
            match: { op: "domain-suffix", value: "chatgpt.com" },
            action: { kind: "endpoint", ref: tokyo.id },
          },
        ],
        defaultAction: { kind: "endpoint", ref: hongkong.id },
        runtime: { mixedPort: 7890 },
      },
    };
    const saved = await page.request.post("/api/me/profiles", {
      headers,
      data: profile,
    });
    expect(saved.ok(), "Create owned synthetic configuration").toBe(true);
    owned.profiles.push(profileID);

    const outputs: Output[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await page.request.post("/api/me/outputs", {
        headers,
        data: {
          id: `copy-${suffix}-${index}`,
          name: `设备 ${index + 1} ${suffix}`,
          profileId: profileID,
          target: { adapterId: "mihomo", version: "1.19.32" },
          mode: "full",
        },
      });
      expect(response.ok()).toBe(true);
      const output: Output = await response.json();
      expect(output.publishedAt).toBeTruthy();
      expect(output.revision).toBeTruthy();
      outputs.push(output);
      owned.outputs.push(output.id);
    }
    page.on("request", observe);
    await page.goto(`/#subscriptions?profile=${profileID}`);
    // Public-API fixture setup does not invalidate the already mounted UI cache.
    await page.reload();
    const group = page.getByRole("article", {
      name: `分流配置 ${profileName}`,
      exact: true,
    });
    await expect(group.getByText("未检查更新", { exact: true })).toHaveCount(5);
    const batch = group.getByRole("button", {
      name: `检查 5 个订阅的更新 · ${profileName}`,
      exact: true,
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await batch.scrollIntoViewIfNeeded();
      await expect(batch).toBeVisible();
      const box = await batch.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(
        await batch.evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`copy-list-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      const trigger = group.getByRole("button", {
        name: `查看订阅 ${outputs[0].name}`,
        exact: true,
      });
      await trigger.click();
      const detail = page.getByRole("dialog", {
        name: `订阅详情 · ${outputs[0].name}`,
        exact: true,
      });
      await expect(detail.getByText("已发布", { exact: true })).toHaveClass(
        "subscription-publication-state",
      );
      await expect(
        detail.getByText("与已保存草稿一致", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath(`copy-detail-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(detail).not.toBeVisible();
      await expect(trigger).toBeFocused();
    }
    expect(
      requests.filter((item) =>
        /\/(?:comparison|access|preview)$/.test(item.path),
      ),
    ).toEqual([]);
    expect(
      requests.filter((item) => item.path.endsWith("/status")),
    ).toHaveLength(2);
    await batch.click();
    await expect(
      group.getByText("与保存草稿一致", { exact: true }),
    ).toHaveCount(5);
    expect(
      requests
        .filter((item) => item.path.endsWith("/comparison"))
        .map((item) => item.path)
        .sort(),
    ).toEqual(
      outputs.map((output) => `/api/me/outputs/${output.id}/comparison`).sort(),
    );
    expect(
      requests.filter(
        (item) => !["GET", "HEAD", "OPTIONS"].includes(item.method),
      ),
    ).toEqual([]);
    expect(
      requests.some((item) => /\/(?:access|preview)$/.test(item.path)),
    ).toBe(false);
    await info.attach("copy-scope-requests", {
      body: JSON.stringify(requests),
      contentType: "application/json",
    });
  } finally {
    page.off("request", observe);
    for (const id of owned.outputs) {
      const response = await page.request.post(`/api/me/outputs/${id}/revoke`, {
        headers,
        data: {},
      });
      expect(response.ok()).toBe(true);
    }
    for (const kind of ["profiles", "sources"] as const) {
      for (const id of owned[kind]) {
        const response = await page.request.delete(`/api/me/${kind}/${id}`, {
          headers,
        });
        expect(response.ok()).toBe(true);
      }
    }
  }
});
