import { test, expect } from "@playwright/test";
import { openWorkspace, navigateWorkspace } from "./ui-session";

test("first subscription skips the empty target gate but preserves save, cancel, review, and explicit publication", async ({
  page,
}, info) => {
  page.setDefaultTimeout(5000);
  const suffix = Date.now().toString(36);
  const profileName = `首份分流 ${suffix}`;
  const outputName = `首份订阅 ${suffix}`;
  let csrf = "",
    profileID: string | undefined,
    outputID: string | undefined;
  const read = async (path: string) => {
    const result = await page.request.get(`/api${path}`);
    expect(result.ok(), `Read ${path} succeeds`).toBe(true);
    return result.json();
  };
  const outputWrites: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      (path === "/api/me/outputs" ||
        /^\/api\/me\/outputs\/[^/]+\/publish$/.test(path))
    )
      outputWrites.push(path);
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorkspace(page);
  await navigateWorkspace(page, "我的订阅");
    csrf = (await read("/auth/me")).csrfToken;
    const before = await read("/me/outputs");
    await page
      .getByRole("button", { name: "新建分流配置", exact: true })
      .click();
    await page.getByLabel("配置名称", { exact: true }).fill(profileName);
    const route = page.getByLabel("默认流量行为", { exact: true });
    await route.click();
    await page.getByRole("option", { name: "直连", exact: true }).click();
    await expect(route).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "保存并检查", exact: true }).click();
    const create = page.getByRole("dialog", {
      name: "新增客户端订阅",
      exact: true,
    });
    await expect(create).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "选择客户端订阅", exact: true }),
    ).toHaveCount(0);
    await expect(create.getByLabel("订阅名称", { exact: true })).toHaveValue(
      profileName,
    );
    await expect(
      create.getByRole("button", { name: "检查发布内容", exact: true }),
    ).toBeEnabled();
    await expect(
      create.getByRole("button", { name: /创建并发布/ }),
    ).toHaveCount(0);
    expect(outputWrites).toEqual([]);
    expect(await read("/me/outputs")).toEqual(before);
    profileID = (await read("/me/profiles")).find(
      (profile: { name: string }) => profile.name === profileName,
    )?.id;
    expect(Boolean(profileID), "Save/check saved the exact Profile").toBe(true);
    await create.getByRole("button", { name: /^取\s*消$/ }).click();
    await expect(create).not.toBeVisible();
    await expect(page.getByLabel("配置名称", { exact: true })).toHaveValue(
      profileName,
    );
    await expect(
      page
        .getByRole("group", { name: "保存与检查配置", exact: true })
        .getByRole("status"),
    ).toHaveText("草稿已保存");
    expect((await read(`/me/profiles/${profileID}`)).name).toBe(profileName);
    expect(await read("/me/outputs")).toEqual(before);
    // AntD can retain its decorative loading icon in the accessible name after
    // the save completes. Require visible action text and actual readiness.
    const checkSaved = page
      .getByRole("button")
      .filter({ hasText: /^检查发布$/ });
    await expect(checkSaved).toHaveCount(1);
    await expect(checkSaved).toBeEnabled();
    await expect(checkSaved).not.toHaveAttribute("aria-busy", "true");
    await checkSaved.click();
    await expect(create).toBeVisible();
    await create.getByLabel("订阅名称", { exact: true }).fill(outputName);
    await create.getByLabel("目标客户端", { exact: true }).click();
    await page
      .getByRole("option", { name: "sing-box 1.14.3", exact: true })
      .click();
    for (const width of [1280, 390, 375, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
      await expect(
        create.getByLabel("订阅名称", { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        create.getByText("创建独立的客户端订阅，其他订阅保留原版本。", { exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expect(
        create.getByRole("button", { name: "检查发布内容", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: info.outputPath(`first-subscription-form-${width}.png`),
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await create
      .getByRole("button", { name: "检查发布内容", exact: true })
      .dblclick();
    const reviewed = create
      .getByRole("status")
      .filter({ hasText: "兼容检查通过。" });
    await expect(reviewed).toBeFocused();
    await page.keyboard.press("Enter");
    expect(outputWrites).toEqual([]);
    expect(await read("/me/outputs")).toEqual(before);
    const publish = create.getByRole("button", {
      name: `创建并发布「${outputName}」`,
      exact: true,
    });
    await expect(publish).toBeEnabled();
    await expect(publish).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath("first-subscription-review-390.png"),
      animations: "disabled",
    });
    await publish.click();
    await expect(
      page.getByRole("dialog", { name: `获取「${outputName}」`, exact: true }),
    ).toBeVisible();
    const after = await read("/me/outputs");
    const created = after.find(
      (output: { name: string }) => output.name === outputName,
    );
    outputID = created?.id;
    expect(created).toMatchObject({
      profileId: profileID,
      status: "published",
      mode: "full",
      target: { adapterId: "sing-box", version: "1.14.3" },
    });
    expect(outputWrites).toEqual(["/api/me/outputs"]);
    expect(
      after.filter((output: { id: string }) => output.id !== outputID),
    ).toEqual(before);
    await info.attach("safe-result", {
      body: JSON.stringify({
        skippedEmptyGate: true,
        cancelKeptSavedDraft: true,
        writesBeforeConfirmation: 0,
        explicitCreationWrites: outputWrites.length,
        existingOutputsUnchanged: true,
      }),
      contentType: "application/json",
    });
  } finally {
    if (csrf) {
      if (!outputID)
        outputID = (await read("/me/outputs")).find(
          (output: { name: string }) => output.name === outputName,
        )?.id;
      if (!profileID)
        profileID = (await read("/me/profiles")).find(
          (profile: { name: string }) => profile.name === profileName,
        )?.id;
      // Outputs have no deletion endpoint: revoke only this synthetic link,
      // then remove its Profile. The ephemeral demo teardown removes the receipt.
      if (outputID) {
        const revoked = await page.request.post(
          `/api/me/outputs/${outputID}/revoke`,
          {
            headers: { "X-CSRF-Token": csrf },
            data: {},
          },
        );
        expect(revoked.ok(), "Revoke the exact synthetic Output").toBe(true);
      }
      if (profileID) {
        const removed = await page.request.delete(
          `/api/me/profiles/${profileID}`,
          {
            headers: { "X-CSRF-Token": csrf },
          },
        );
        expect(removed.ok(), "Remove the exact synthetic Profile").toBe(true);
      }
    }
  }
});
