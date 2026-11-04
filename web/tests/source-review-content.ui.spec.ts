import { expect, test } from "@playwright/test";
import { openWorkspace } from "./ui-session";

test("first import is immediately usable and manual updates explain one warning summary before explicit application", async ({
  page,
}, info) => {
  await openWorkspace(page);
  const actor = await (await page.request.get("/api/auth/me")).json();
  const headers = { "X-CSRF-Token": actor.csrfToken };
  const name = `Import clarity ${Date.now().toString(36)}`;
  const content = (port: number) =>
    JSON.stringify({
      outbounds: [
        {
          type: "socks",
          tag: "London",
          server: "synthetic.example",
          server_port: port,
          version: "5",
        },
        { type: "direct", tag: "direct" },
      ],
      route: { final: "London" },
    });
  let source: any;
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/me\/sources\/[^/]+\/(?:apply|candidate\/accept)$/.test(
        new URL(request.url()).pathname,
      )
    )
      writes.push(new URL(request.url()).pathname);
  });
  try {
    await page.goto("/#sources");
    await page
      .getByRole("button", { name: "添加来源", exact: true })
      .first()
      .click();
    const editor = page.getByRole("dialog", {
      name: "添加订阅来源",
      exact: true,
    });
    await editor.getByLabel("来源名称").fill(name);
    await editor.getByLabel("节点链接或配置内容").fill(content(1080));
    await editor
      .getByRole("combobox", { name: "更新应用方式", exact: true })
      .click();
    await page.getByRole("option", { name: "手动应用", exact: true }).click();
    await expect(
      editor.getByText(
        "首次导入立即可用。后续更新按此方式应用到来源，不会自动发布订阅。",
        { exact: true },
      ),
    ).toBeVisible();
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/me/sources") &&
        response.request().method() === "POST",
    );
    await editor.getByRole("button", { name: "导入来源", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(200);
    source = await createdResponse.json();
    expect(source.applyMode).toBe("manual");
    expect(source.candidate).toBeUndefined();
    expect(source.snapshot.endpoints).toHaveLength(1);
    expect(
      source.diagnostics.map((item: { code: string }) => item.code),
    ).toEqual(["connection-extraction", "non-connection-outbound"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(writes).toEqual([]);
    await page.getByRole("textbox", { name: "搜索来源" }).fill(name);
    const row = page.getByRole("row").filter({
      has: page.getByRole("button", { name: `更多操作 ${name}`, exact: true }),
    });
    await expect(row).toContainText("已导入");
    await expect(
      row.getByRole("button", { name: `应用更新 ${name}`, exact: true }),
    ).toHaveCount(0);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: info.outputPath(`first-import-${width}.png`),
        animations: "disabled",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
    }
    const firstSnapshot = source.snapshot;
    for (const port of [1081, 1082]) {
      const updated = await page.request.put(`/api/me/sources/${source.id}`, {
        headers,
        data: {
          id: source.id,
          name,
          kind: "text",
          enabled: true,
          applyMode: "manual",
          revision: source.revision,
          content: content(port),
        },
      });
      expect(updated.status()).toBe(200);
      const pending = await updated.json();
      expect(pending.snapshot).toEqual(source.snapshot);
      expect(pending.candidate).toBeTruthy();
      await page.reload();
      await page.getByRole("textbox", { name: "搜索来源" }).fill(name);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await row.getByRole("button", { name: "查看变化", exact: true }).click();
      const review = page.getByRole("dialog", {
        name: "查看变化",
        exact: true,
      });
      await expect(review.getByLabel("来源检查摘要")).toBeFocused();
      await expect(
        review.getByText("仅导入连接选项", { exact: true }),
      ).toHaveCount(1);
      await expect(review.getByRole("alert")).toHaveCount(1);
      const consequence = review.getByText("应用后，配置和预览将使用新选项。", {
        exact: true,
      });
      await expect(consequence).toBeVisible();
      await expect(
        review.getByText("现有草稿保留当前选择，已发布订阅保留原版本。", {
          exact: true,
        }),
      ).toBeVisible();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(
          review.getByRole("button", { name: "应用更新", exact: true }),
        ).toBeVisible();
        await expect(
          review.getByRole("button", { name: "忽略本次更新", exact: true }),
        ).toBeVisible();
        await review.screenshot({
          path: info.outputPath(`update-${port}-${width}.png`),
          animations: "disabled",
        });
        await info.attach(`update-layout-${port}-${width}`, {
          body: JSON.stringify({
            warning: await review.getByRole("alert").boundingBox(),
            consequence: await consequence.evaluate((element) => ({
              fontSize: getComputedStyle(element).fontSize,
              color: getComputedStyle(element).color,
            })),
          }),
          contentType: "application/json",
        });
        expect(
          await review.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
      }
      if (port === 1081) {
        await review
          .getByRole("button", { name: "稍后处理", exact: true })
          .click();
        await expect(review).toHaveCount(0);
        expect(writes).toEqual([]);
        const applied = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/me/sources/${source.id}/apply`) &&
            response.request().method() === "POST",
        );
        await row
          .getByRole("button", { name: `应用更新 ${name}`, exact: true })
          .click();
        const response = await applied;
        expect(response.status()).toBe(200);
        expect(response.request().postDataJSON()).toEqual({
          candidateId: pending.candidate.id,
          sourceRevision: pending.revision,
        });
        source = await response.json();
        expect(source.snapshot.snapshotId).not.toBe(firstSnapshot.snapshotId);
        expect(source.candidate).toBeUndefined();
        await expect(page.getByRole("dialog")).toHaveCount(0);
      } else {
        const ignored = page.waitForResponse(
          (response) =>
            response
              .url()
              .endsWith(`/api/me/sources/${source.id}/candidate/reject`) &&
            response.request().method() === "POST",
        );
        await review
          .getByRole("button", { name: "忽略本次更新", exact: true })
          .click();
        const response = await ignored;
        expect(response.status()).toBe(200);
        const retained = await response.json();
        expect(retained.snapshot).toEqual(source.snapshot);
        expect(retained.candidate).toBeUndefined();
        await expect(review).toHaveCount(0);
      }
    }
    expect(writes).toEqual([`/api/me/sources/${source.id}/apply`]);
  } finally {
    if (source)
      expect(
        (
          await page.request.delete(`/api/me/sources/${source.id}`, { headers })
        ).ok(),
      ).toBe(true);
  }
});
