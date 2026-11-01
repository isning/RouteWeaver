import { test, expect, type Request } from "@playwright/test";
import { openWorkspace } from "./ui-session";

// Real URL safe-fetch denial only. No route interception, remote fetch,
// success replay, source-kind substitution or acceptance claim.
test("URL safe-fetch denial retains masked input and the rich parent draft", async ({
  page,
}, info) => {
  await openWorkspace(page);
  const read = async (path: string) => {
    const response = await page.request.get(`/api${path}`);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const csrf = (await read("/auth/me")).csrfToken;
  const headers = { "X-CSRF-Token": csrf };
  const suffix = Date.now().toString(36);
  const ids: string[] = [];
  const collectionID = `url_error_collection_${suffix}`;
  const originalName = `URL original ${suffix}`;
  const draftName = `URL unsaved ${suffix}`;
  const sourceName = `URL denied ${suffix}`;
  const syntheticURL = "https://localhost/url-fixture?token=synthetic-only";
  let collectionCreated = false;
  let originalFailure: unknown;
  let observing = false;
  const writes: { method: string; path: string; body: any }[] = [];
  const observe = (request: Request) => {
    if (
      !observing ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    )
      return;
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return;
    let body: any;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    writes.push({ method: request.method(), path, body });
    // Capture the test's generated ID before inspecting its response, so a
    // later assertion failure cannot orphan a successfully retained source.
    if (
      path === "/api/me/sources" &&
      request.method() === "POST" &&
      body?.name === sourceName &&
      body.id
    )
      ids.push(body.id);
  };
  page.on("request", observe);
  try {
    for (const [index, name] of ["URL North", "URL South"].entries()) {
      const id = `url_error_seed_${suffix}_${index}`;
      ids.push(id);
      const response = await page.request.post("/api/me/sources", {
        headers,
        data: {
          id,
          name,
          kind: "text",
          enabled: true,
          content: `socks5://synthetic.example:${1080 + index}#${encodeURIComponent(name)}`,
        },
      });
      expect(response.ok()).toBe(true);
    }
    const recipe = {
      id: collectionID,
      name: originalName,
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
    collectionCreated = seeded.ok();
    expect(collectionCreated).toBe(true);
    const beforeCollections = await read("/me/collections");
    const beforeProfiles = await read("/me/profiles");
    const beforeOutputs = await read("/me/outputs");
    const beforeSources = await read("/me/sources");
    observing = true;
    await page.goto("/#collections");
    await page
      .getByRole("button", {
        name: `${originalName} 2 个来源 · 1 个聚合步骤 编辑集合`,
        exact: true,
      })
      .click();
    await page.getByLabel("集合名称", { exact: true }).fill(draftName);
    await page.getByRole("button", { name: "下移来源 1", exact: true }).click();
    await page.getByRole("button", { name: /2\. URL North.*来源处理/ }).click();
    await page
      .getByLabel("步骤 1 命名模板", { exact: true })
      .fill("unsaved-{name}");
    await page.getByRole("button", { name: "添加来源", exact: true }).click();
    let editor = page.getByRole("dialog", {
      name: "添加订阅来源",
      exact: true,
    });
    await editor.getByRole("radio", { name: "订阅 URL", exact: true }).check();
    await editor.getByLabel("来源名称").fill(sourceName);
    await editor.getByLabel("订阅地址", { exact: true }).fill(syntheticURL);
    await expect(
      editor.getByLabel("订阅地址", { exact: true }),
    ).toHaveAttribute("type", "password");
    await expect(
      editor.getByText(
        "订阅由平台服务器解析，平台运营者可处理其中的连接信息。来源仅对你的账号可见，不会自动加入共享服务器线路。",
        { exact: true },
      ),
    ).toBeVisible();
    const failed = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/me/sources") && r.request().method() === "POST",
    );
    await editor.getByRole("button", { name: "导入来源", exact: true }).click();
    const response = await failed;
    expect(response.status()).toBe(422);
    const raw = await response.text();
    const failure = JSON.parse(raw);
    const retained = failure.source;
    expect(retained.id).toBe(writes[0].body.id);
    expect(retained.revision).toBeTruthy();
    expect(retained.kind).toBe("url");
    expect(retained.lastErrorCode).toBe("source_url_not_allowed");
    expect(retained.refreshStatus).toBe("failed");
    expect(retained.snapshot).toBeUndefined();
    expect(retained.candidate).toBeUndefined();
    expect(failure.detail).toBe("resource URL is not allowed");
    expect(raw).not.toContain("synthetic-only");
    expect(raw).not.toContain("localhost");
    await expect(
      editor.getByText("输入已保存，导入未完成", { exact: true }),
    ).toBeVisible();
    await expect(editor.getByLabel("来源名称")).toHaveValue(sourceName);
    await expect(editor.getByLabel("订阅地址", { exact: true })).toHaveValue(
      syntheticURL,
    );
    await expect(
      editor.getByLabel("订阅地址", { exact: true }),
    ).toHaveAttribute("type", "password");
    expect(await editor.innerText()).not.toContain("synthetic-only");
    await expect(
      editor.getByText(
        /无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。/,
      ),
    ).toBeVisible();
    expect(await editor.innerText()).not.toContain(
      "resource URL is not allowed",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.screenshot({
      path: info.outputPath("url-denied-retained-390.png"),
      animations: "disabled",
    });
    await editor.getByRole("button", { name: /^取\s*消$/ }).click();
    const parent = page.getByRole("dialog", { name: draftName, exact: true });
    await expect(parent.getByLabel("集合名称", { exact: true })).toHaveValue(
      draftName,
    );
    await expect(
      parent.getByText("1. URL South", { exact: true }),
    ).toBeVisible();
    await expect(
      parent.getByText("2. URL North", { exact: true }),
    ).toBeVisible();
    await expect(
      parent.getByLabel("步骤 1 命名模板", { exact: true }),
    ).toHaveValue("unsaved-{name}");
    await expect(
      parent.getByRole("button", { name: "添加来源", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("alertdialog", {
        name: "放弃尚未保存的来源修改？",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      parent.getByText(
        "无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。",
        { exact: true },
      ),
    ).toBeVisible();
    expect(await parent.innerText()).not.toContain(
      "resource URL is not allowed",
    );
    await parent.screenshot({
      path: info.outputPath("url-denied-parent-390.png"),
      animations: "disabled",
    });
    const reveal = page.waitForResponse((r) =>
      r.url().endsWith(`/api/me/sources/${retained.id}/reveal`),
    );
    await parent.getByRole("button", { name: "继续编辑", exact: true }).click();
    const revealedResponse = await reveal;
    expect(revealedResponse.status()).toBe(200);
    const revealed = await revealedResponse.json();
    expect(revealed.id).toBe(retained.id);
    expect(revealed.revision).toBe(retained.revision);
    expect(revealed.url).toBe(syntheticURL);
    editor = page.getByRole("dialog", { name: "编辑来源", exact: true });
    await expect(editor.getByLabel("订阅地址", { exact: true })).toHaveValue(
      syntheticURL,
    );
    await expect(
      editor.getByLabel("订阅地址", { exact: true }),
    ).toHaveAttribute("type", "password");
    await expect(editor.getByLabel("来源名称")).toHaveValue(sourceName);
    await editor.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(
      parent.getByLabel("步骤 1 命名模板", { exact: true }),
    ).toHaveValue("unsaved-{name}");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      path: "/api/me/sources",
      body: { kind: "url", url: syntheticURL },
    });
    expect(await read("/me/collections")).toEqual(beforeCollections);
    expect(await read("/me/profiles")).toEqual(beforeProfiles);
    expect(await read("/me/outputs")).toEqual(beforeOutputs);
    const afterSources = await read("/me/sources");
    expect(afterSources.filter((s: any) => s.id !== retained.id)).toEqual(
      beforeSources,
    );
    expect(afterSources.filter((s: any) => s.id === retained.id)).toHaveLength(
      1,
    );
    expect(JSON.stringify(afterSources)).not.toContain("synthetic-only");
  } catch (error) {
    originalFailure = error;
    throw error;
  } finally {
    observing = false;
    page.off("request", observe);
    const cleanupErrors: string[] = [];
    // Delete only records owned by this test, collection before its sources.
    // Existing DELETE routes are defined by tenant.go, not guessed endpoints.
    const targets = [
      ...(collectionCreated ? [`collections/${collectionID}`] : []),
      ...new Set(ids.map((id) => `sources/${id}`)),
    ];
    for (const target of targets) {
      try {
        const exists = await page.request.get(`/api/me/${target}`);
        if (exists.status() === 404) continue;
        if (!exists.ok()) throw new Error(`read status ${exists.status()}`);
        const deleted = await page.request.delete(`/api/me/${target}`, {
          headers,
        });
        if (!deleted.ok()) throw new Error(`delete status ${deleted.status()}`);
        const gone = await page.request.get(`/api/me/${target}`);
        if (gone.status() !== 404)
          throw new Error(`post-delete status ${gone.status()}`);
      } catch (error) {
        cleanupErrors.push(`${target}: ${String(error)}`);
      }
    }
    if (cleanupErrors.length) {
      await info
        .attach("cleanup-errors", {
          body: cleanupErrors.join("\n"),
          contentType: "text/plain",
        })
        .catch(() => {});
      // Never replace the useful initial browser/assertion failure with cleanup.
      if (!originalFailure)
        throw new Error(`Fixture cleanup failed: ${cleanupErrors.join("; ")}`);
    }
  }
});
