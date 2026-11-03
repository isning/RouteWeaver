import { expect, test } from "@playwright/test";
import { openWorkspace } from "./ui-session";

// Real HTTP/store responses throughout. The competing writer is another HTTP
// editor; no synthetic 409, response interception or native activation is used.
for (const width of [1280, 390]) {
  test(`stale profile keeps its submitted draft and explicitly reopens the accepted version at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const session = await (await page.request.get("/api/auth/me")).json();
    const headers = { "X-CSRF-Token": session.csrfToken };
    const id = `profile-revision-${width}-${Date.now().toString(36)}`;
    const profile = {
      id,
      name: `Revision fixture ${width}`,
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      ir: {
        schemaVersion: "1.0",
        id,
        name: `Revision fixture ${width}`,
        ownerId: "",
        revision: "draft",
        endpoints: [],
        groups: [],
        rules: [],
        resources: [],
        defaultAction: { kind: "direct" },
        runtime: {
          mixedPort: 7890,
          sniff: false,
          dns: {
            servers: [
              { id: "dns1", type: "tls", address: "1.1.1.1", port: 853 },
            ],
            final: "dns1",
          },
        },
      },
    };
    let outputCreated = false;
    let taskError: unknown;
    try {
      const create = await page.request.post("/api/me/profiles", {
        headers,
        data: profile,
      });
      expect(create.status(), await create.text()).toBe(200);
      const publication = await page.request.post("/api/me/outputs", {
        headers,
        data: {
          id,
          name: "Frozen subscription",
          profileId: id,
          target: profile.target,
          mode: "full",
        },
      });
      expect(publication.status(), await publication.text()).toBe(201);
      outputCreated = true;
      const output = await publication.json();
      const beforeResponse = await page.request.get(output.feedPath);
      expect(beforeResponse.status()).toBe(200);
      const before = await beforeResponse.text();
      await page.goto(`/#subscriptions?profile=${id}`);
      // Fixture writes happened outside the mounted catalog's query lifecycle.
      await page.reload();
      const article = page.getByRole("article", {
        name: `分流配置 ${profile.name}`,
        exact: true,
      });
      const opening = page.waitForResponse((response) =>
        response.url().endsWith(`/api/me/profiles/${id}/reveal`),
      );
      await article
        .getByRole("button", { name: "编辑配置", exact: true })
        .click();
      const opened = await (await opening).json();
      expect(opened.revisionToken).toBeTruthy();
      const name = page.getByRole("textbox", { name: "配置名称", exact: true });
      await name.fill("My retained draft");
      await page.getByRole("tab", { name: "运行设置", exact: true }).click();
      await page
        .getByRole("textbox", { name: "DNS 服务器 1", exact: true })
        .fill("192.0.2.53");
      await page
        .getByRole("switch", { name: "启用流量嗅探", exact: true })
        .click();
      const accepted = await page.request.put(`/api/me/profiles/${id}`, {
        headers: { ...headers, "If-Match": opened.revisionToken },
        data: { ...profile, name: "Accepted competing draft" },
      });
      expect(accepted.status(), await accepted.text()).toBe(200);
      const committed = await accepted.json();
      const writes: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "PUT" &&
          request.url().endsWith(`/api/me/profiles/${id}`)
        )
          writes.push(request.postData() || "");
      });
      const stale = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith(`/api/me/profiles/${id}`),
      );
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      const rejected = await stale;
      expect(rejected.status()).toBe(409);
      expect((await rejected.json()).code).toBe("PROFILE_DRAFT_CHANGED");
      expect(rejected.request().headers()["if-match"]).toBe(
        opened.revisionToken,
      );
      expect(JSON.parse(writes[0])).not.toHaveProperty("revisionToken");
      await expect(name).toHaveValue("My retained draft");
      await expect(
        page.getByRole("textbox", { name: "DNS 服务器 1", exact: true }),
      ).toHaveValue("192.0.2.53");
      await expect(
        page.getByRole("switch", { name: "启用流量嗅探", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        page.getByRole("button", { name: "保存草稿", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "保存并检查", exact: true }),
      ).toBeDisabled();
      const latest = await (
        await page.request.get(`/api/me/profiles/${id}`)
      ).json();
      expect(latest.name).toBe("Accepted competing draft");
      expect(latest.revisionToken).toBe(committed.revisionToken);
      expect(await (await page.request.get(output.feedPath)).text()).toBe(
        before,
      );
      const discard = page.getByRole("button", {
        name: "放弃修改并返回",
        exact: true,
      });
      await discard.click();
      let confirmation = page.getByRole("alertdialog", {
        name: "放弃当前修改并返回？",
        exact: true,
      });
      await expect(
        confirmation.getByRole("button", { name: "保留当前输入", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(confirmation).toHaveCount(0);
      await expect(discard).toBeFocused();
      await expect(name).toHaveValue("My retained draft");
      await discard.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      const inspectionTab = page.getByRole("tab", { name: "检查与预览", exact: true });
      await expect(inspectionTab).toHaveCSS("white-space", "nowrap");
      expect(await inspectionTab.evaluate(el => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
      })).toBe(1);
      const tabListBox = (await page.getByRole("tablist").boundingBox())!;
      const activePanelBox = (await page.getByRole("tabpanel", { name: "运行设置", exact: true }).boundingBox())!;
      // Local navigation remains next to its panels, not above a long shared editor.
      expect(activePanelBox.y - tabListBox.y - tabListBox.height).toBeGreaterThanOrEqual(0);
      expect(activePanelBox.y - tabListBox.y - tabListBox.height).toBeLessThanOrEqual(32);
      const nameBox = (await name.boundingBox())!;
      const linkedBox = (await page.getByText("关联订阅（1）", { exact: true }).boundingBox())!;
      expect(nameBox.x + nameBox.width <= linkedBox.x || nameBox.y + nameBox.height <= linkedBox.y).toBe(true);
      await page.screenshot({
        path: info.outputPath(`profile-conflict-${width}.png`),
      });
      await discard.click();
      confirmation = page.getByRole("alertdialog", {
        name: "放弃当前修改并返回？",
        exact: true,
      });
      await confirmation
        .getByRole("button", { name: "放弃修改并返回", exact: true })
        .click();
      await expect(name).toHaveCount(0);
      const updated = page.getByRole("article", {
        name: "分流配置 Accepted competing draft",
        exact: true,
      });
      await updated
        .getByRole("button", { name: "编辑配置", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "配置名称", exact: true }),
      ).toHaveValue("Accepted competing draft");
      expect(writes).toHaveLength(1);
      // Reopening adopts the complete accepted draft and its token together.
      // Each later accepted save must supply its own successor token, not the
      // original opening token or a fresh token fetched over retained values.
      let expectedRevision = committed.revisionToken;
      for (const nextName of ["Recovered draft one", "Recovered draft two"]) {
        await page
          .getByRole("textbox", { name: "配置名称", exact: true })
          .fill(nextName);
        const saving = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            response.url().endsWith(`/api/me/profiles/${id}`),
        );
        await page
          .getByRole("button", { name: "保存草稿", exact: true })
          .click();
        const savedResponse = await saving;
        expect(savedResponse.status()).toBe(200);
        expect(savedResponse.request().headers()["if-match"]).toBe(
          expectedRevision,
        );
        const saved = await savedResponse.json();
        expect(saved.revisionToken).not.toBe(expectedRevision);
        expectedRevision = saved.revisionToken;
        await expect(
          page
            .getByRole("group", { name: "保存与检查配置" })
            .getByRole("status"),
        ).toHaveText("草稿已保存");
      }
      expect(writes).toHaveLength(3);
      expect(await (await page.request.get(output.feedPath)).text()).toBe(
        before,
      );
    } catch (error) {
      taskError = error;
      throw error;
    } finally {
      const cleanup: (number | string)[] = [];
      const clean = async (run: () => Promise<{ status: () => number }>) => {
        try {
          cleanup.push((await run()).status());
        } catch {
          cleanup.push("cleanup request unavailable");
        }
      };
      if (outputCreated)
        await clean(() =>
          page.request.post(`/api/me/outputs/${id}/revoke`, {
            headers,
            data: {},
          }),
        );
      await clean(() =>
        page.request.delete(`/api/me/profiles/${id}`, { headers }),
      );
      await info
        .attach("profile-fixture-cleanup", {
          body: JSON.stringify(cleanup),
          contentType: "application/json",
        })
        .catch(() => {});
      if (!taskError)
        expect(cleanup).toEqual(outputCreated ? [200, 200] : [200]);
    }
  });
}
