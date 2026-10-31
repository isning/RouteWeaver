import { expect, test } from "@playwright/test";
import { openWorkspace } from "./ui-session";

test("saved parse failures give one Chinese recovery state before and after an accepted snapshot", async ({
  page,
}, info) => {
  await openWorkspace(page);
  const actor = await (await page.request.get("/api/auth/me")).json();
  const headers = { "X-CSRF-Token": actor.csrfToken };
  const name = `Saved parse ${Date.now().toString(36)}`;
  let id: string | undefined;
  const parseFailure =
    "source parse failed; check the supported input format and resolve ambiguous changed entries";
  const action = "订阅内容未能导入。请检查格式和连接设置后重试。";
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto("/#sources");
    await page
      .getByRole("button", { name: "添加来源", exact: true })
      .first()
      .click();
    let editor = page.getByRole("dialog", {
      name: "添加订阅来源",
      exact: true,
    });
    await editor.getByLabel("来源名称").fill(name);
    await editor
      .getByLabel("节点链接或配置内容")
      .fill("invalid synthetic first input");
    const firstFailure = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/me/sources") &&
        response.request().method() === "POST",
    );
    await editor.getByRole("button", { name: "导入来源", exact: true }).click();
    const firstResponse = await firstFailure;
    expect(firstResponse.status()).toBe(422);
    const firstBody = await firstResponse.json();
    id = firstBody.source.id;
    expect(firstBody.detail).toBe(parseFailure);
    expect(firstBody.source.snapshot).toBeUndefined();
    await expect(editor.getByRole("alert")).toHaveCount(1);
    await expect(
      editor.getByText("输入已保存，导入未完成", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText(
        `此来源尚无可用节点。${action}关闭不会撤销已保存的输入。`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(editor.getByText("操作未完成", { exact: true })).toHaveCount(
      0,
    );
    await expect(editor.getByText(parseFailure, { exact: true })).toHaveCount(
      0,
    );
    await editor.screenshot({
      path: info.outputPath("saved-failed-input-390.png"),
      animations: "disabled",
    });
    expect(
      await editor.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await editor.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(editor).toHaveCount(0);
    let stored = await (
      await page.request.get(`/api/me/sources/${id}/reveal`)
    ).json();
    expect(stored.content).toBe("invalid synthetic first input");
    expect(stored.revision).toBe(firstBody.source.revision);
    await page.getByRole("textbox", { name: "搜索来源" }).fill(name);
    await page
      .getByRole("button", { name: `编辑 ${name}`, exact: true })
      .click();
    editor = page.getByRole("dialog", { name: "编辑来源", exact: true });
    await expect(editor.getByLabel("节点链接或配置内容")).toHaveValue(
      "invalid synthetic first input",
    );
    await editor
      .getByLabel("节点链接或配置内容")
      .fill("socks5://synthetic.example:1080#Earlier");
    const success = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/me/sources/${id}`) &&
        response.request().method() === "PUT",
    );
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    const acceptedResponse = await success;
    expect(acceptedResponse.status()).toBe(200);
    const accepted = await acceptedResponse.json();
    expect(accepted.snapshot.endpoints).toHaveLength(1);
    await expect(editor).toHaveCount(0);
    await expect(page.getByText("来源已更新", { exact: true })).toHaveCount(0);
    await page
      .getByRole("button", { name: `编辑 ${name}`, exact: true })
      .click();
    editor = page.getByRole("dialog", { name: "编辑来源", exact: true });
    await expect(editor.getByLabel("节点链接或配置内容")).toHaveValue(
      "socks5://synthetic.example:1080#Earlier",
    );
    await editor
      .getByLabel("节点链接或配置内容")
      .fill("invalid synthetic updated input");
    const failedUpdate = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/me/sources/${id}`) &&
        response.request().method() === "PUT",
    );
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    const failedResponse = await failedUpdate;
    expect(failedResponse.status()).toBe(422);
    const failedBody = await failedResponse.json();
    expect(failedBody.source.snapshot).toEqual(accepted.snapshot);
    expect(failedBody.source.revision).not.toBe(accepted.revision);
    await expect(editor.getByRole("alert")).toHaveCount(1);
    await expect(
      editor.getByText(
        `之前可用节点仍保留。${action}关闭不会撤销已保存的输入。`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(editor.getByText("操作未完成", { exact: true })).toHaveCount(
      0,
    );
    await expect(editor.getByText(parseFailure, { exact: true })).toHaveCount(
      0,
    );
    await editor.screenshot({
      path: info.outputPath("saved-failed-update-390.png"),
      animations: "disabled",
    });
    expect(
      await editor.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await editor.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(editor).toHaveCount(0);
    stored = await (
      await page.request.get(`/api/me/sources/${id}/reveal`)
    ).json();
    expect(stored.content).toBe("invalid synthetic updated input");
    expect(stored.snapshot).toEqual(accepted.snapshot);
  } finally {
    if (id)
      expect(
        (await page.request.delete(`/api/me/sources/${id}`, { headers })).ok(),
      ).toBe(true);
  }
});
