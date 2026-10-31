import { expect, test } from "@playwright/test";
import { openWorkspace } from "./ui-session";

// All preview/list/publish responses are real. External revoke uses the same
// synthetic owner's HTTP session after the real list refresh and before preview.
test.use({ trace: "off", screenshot: "off", video: "off", hasTouch: true });
for (const scenario of ["unchanged", "changed-long-name"] as const) {
  test(`a stale published list reviews the actual replacement link before explicit publication: ${scenario}`, async ({
    page,
  }, info) => {
    await openWorkspace(page);
    const headers = {
      "X-CSRF-Token": (await (await page.request.get("/api/auth/me")).json())
        .csrfToken,
    };
    const id = `consequence-${Date.now().toString(36)}`;
    const name =
      scenario === "unchanged"
        ? "日常订阅"
        : "日常订阅 · 工作与旅行设备的完整路由配置 long-device-subscription"; // Synthetic local fixture.
    const target = { adapterId: "mihomo", version: "1.19.32" };
    const profile = {
      id,
      name: "日常分流",
      target,
      mode: "full",
      ir: {
        schemaVersion: "1.0",
        id,
        name,
        ownerId: "",
        revision: "1",
        endpoints: [],
        groups: [],
        resources: [],
        rules:
          scenario === "unchanged"
            ? []
            : [
                {
                  id: "work",
                  match: { op: "domain-suffix", value: "work.example" },
                  action: { kind: "direct" },
                },
                {
                  id: "travel",
                  match: { op: "domain-suffix", value: "travel.example" },
                  action: { kind: "direct" },
                },
                {
                  id: "retired",
                  match: { op: "domain-suffix", value: "retired.example" },
                  action: { kind: "reject" },
                },
              ],
        defaultAction: { kind: "direct" },
        runtime: { mixedPort: 7890 },
      },
    };
    let created = false;
    let taskError: unknown;
    try {
      expect(
        (
          await page.request.post("/api/me/profiles", {
            headers,
            data: profile,
          })
        ).ok(),
      ).toBe(true);
      const response = await page.request.post("/api/me/outputs", {
        headers,
        data: { id, name, profileId: id, target, mode: "full" },
      });
      expect(response.status()).toBe(201);
      created = true;
      const oldOutput = await response.json();
      if (scenario === "changed-long-name") {
        expect(
          (
            await page.request.put(`/api/me/profiles/${id}`, {
              headers,
              data: {
                ...profile,
                ir: {
                  ...profile.ir,
                  rules: [
                    {
                      id: "travel",
                      match: { op: "domain-suffix", value: "travel.example" },
                      action: { kind: "reject" },
                    },
                    {
                      id: "work",
                      match: { op: "domain-suffix", value: "new-work.example" },
                      action: { kind: "direct" },
                    },
                    {
                      id: "added",
                      match: { op: "domain-suffix", value: "added.example" },
                      action: { kind: "direct" },
                    },
                  ],
                  defaultAction: { kind: "reject" },
                },
              },
            })
          ).ok(),
        ).toBe(true);
      }
      await page.reload();
      const row = page.getByRole("group", {
        name: `客户端订阅 ${name}`,
        exact: true,
      });
      await expect(row.getByText("已发布", { exact: true })).toBeVisible();
      // The entry action refetches outputs. Revoke only after that real response,
      // immediately before the preview reaches the server. The interception is a
      // scheduling barrier, not a mocked response: continue the original request.
      await page.route(
        `**/api/me/profiles/${id}/preview`,
        async (route) => {
          expect(
            (
              await page.request.post(`/api/me/outputs/${id}/revoke`, {
                headers,
              })
            ).ok(),
          ).toBe(true);
          await route.continue();
        },
        { times: 1 },
      );
      const previewResponse = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/me/profiles/${id}/preview`) &&
          r.request().method() === "POST",
      );
      let publications = 0;
      page.on("request", (r) => {
        if (
          r.method() === "POST" &&
          r.url().endsWith(`/api/me/outputs/${id}/publish`)
        )
          publications++;
      });
      const entry = row.getByRole("button", { name: "检查更新", exact: true });
      await entry.click();
      expect((await previewResponse).ok()).toBe(true);
      const review = page.getByRole("dialog", {
        name: `检查订阅更新「${name}」`,
        exact: true,
      });
      await expect(review.getByText(/链接不变/)).toHaveCount(0);
      const publish = review.getByRole("button", {
        name: `重新发布并生成新链接「${name}」`,
        exact: true,
      });
      await expect(publish).toBeEnabled();
      expect(publications).toBe(0);
      const consequence = review.getByText(
        "发布后请在客户端换用新链接，其他订阅不受影响。",
        { exact: true },
      );
      const scope = review.getByRole("group", {
        name: "比较结论与范围",
        exact: true,
      });
      const coverage = scope.getByText("未比较规则文件内容和客户端运行设置。", {
        exact: true,
      });
      // This selected-output review also compares frozen groups/connections;
      // retain its actual exclusion boundary rather than the generic old copy.
      await expect(
        review.getByText("策略组和连接未变化。", { exact: true }),
      ).toBeVisible();
      if (scenario === "changed-long-name") {
        const changes = review.getByRole("list", { name: "分流规则变更" });
        await expect(changes).toBeVisible();
        await expect(
          changes.getByText("新增规则", { exact: true }),
        ).toBeVisible();
        await expect(
          changes.getByText("移除规则", { exact: true }),
        ).toBeVisible();
        await expect(
          review.getByText("默认去向已更换", { exact: true }),
        ).toBeVisible();
        expect(await changes.locator("xpath=ancestor::details").count()).toBe(
          0,
        );
      }
      for (const [width, height] of [
        [1280, 900],
        [390, 640],
        [320, 568],
        [1280, 480],
      ]) {
        await page.setViewportSize({ width, height });
        await review.getByText(/^订阅：/).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: info.outputPath(`review-top-${width}-${height}.png`),
          animations: "disabled",
        });
        await scope.scrollIntoViewIfNeeded();
        await expect(coverage).toBeInViewport({ ratio: 1 });
        if (scenario === "unchanged") {
          const conclusion = scope.locator("summary").filter({
            hasText: "分流规则和默认去向未变化",
          });
          const before = await conclusion.boundingBox();
          const after = await coverage.boundingBox();
          expect(
            after!.y - (before!.y + before!.height),
            "Conclusion stays with its comparison boundary",
          ).toBeLessThanOrEqual(12);
        }
        const technical = review.getByRole("button", {
          name: "查看待发布技术配置",
          exact: true,
        });
        await review
          .getByRole("button", { name: "重新检查", exact: true })
          .focus();
        await page.keyboard.press("Tab");
        const overview = review.locator("summary").filter({
          hasText:
            scenario === "unchanged"
              ? "分流规则和默认去向未变化"
              : "查看待发布规则明细",
        });
        await expect(overview).toBeFocused();
        await expect(overview).toBeInViewport({ ratio: 1 });
        await page.keyboard.press("Enter");
        await expect(overview.locator("..")).toHaveAttribute("open", "");
        await page.keyboard.press("Enter");
        await expect(overview.locator("..")).not.toHaveAttribute("open", "");
        await page.keyboard.press("Tab");
        await expect(technical).toBeFocused();
        await expect(technical).toBeInViewport({ ratio: 1 });
        await technical.press("Enter");
        await expect(technical).toHaveAttribute("aria-expanded", "true");
        await technical.press("Enter");
        await expect(technical).toHaveAttribute("aria-expanded", "false");
        const decision = review.getByRole("group", {
          name: "更新确认",
          exact: true,
        });
        await decision.scrollIntoViewIfNeeded();
        await expect(consequence).toBeInViewport({ ratio: 1 });
        await expect(publish).toBeInViewport({ ratio: 1 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
        expect(publications).toBe(0);
        await page.screenshot({
          path: info.outputPath(`review-decision-${width}-${height}.png`),
          animations: "disabled",
        });
      }
      // Bounded real input evidence: touch-capable cancel, focus return, reopen,
      // browser wheel through the same review, and deliberate touch confirmation.
      await review
        .getByRole("button", { name: /^取\s*消$/, exact: true })
        .tap();
      await expect(review).not.toBeVisible();
      await expect(entry).toBeFocused();
      expect(publications).toBe(0);
      await entry.tap();
      await expect(review).toBeVisible();
      await expect(publish).toBeEnabled();
      await review
        .getByRole("region", { name: "分流比较", exact: true })
        .hover();
      await page.mouse.wheel(0, 3000);
      await expect(consequence).toBeInViewport({ ratio: 1 });
      await expect(publish).toBeInViewport({ ratio: 1 });
      expect(publications).toBe(0);
      await publish.tap();
      await expect(
        page.getByRole("dialog", { name: `获取「${name}」`, exact: true }),
      ).toBeVisible();
      expect(publications).toBe(1);
      const access = await (
        await page.request.get(`/api/me/outputs/${id}/access`)
      ).json();
      expect(
        access.feedPath === oldOutput.feedPath,
        "Approved replacement changes the link",
      ).toBe(false);
      expect((await page.request.get(oldOutput.feedPath)).status()).not.toBe(
        200,
      );
      expect((await page.request.get(access.feedPath)).status()).toBe(200);
    } catch (error) {
      taskError = error;
      throw error;
    } finally {
      // Ant browser button names may contain CJK spacing; use scoped exact
      // whitespace-tolerant task labels. Cleanup must not mask an action failure.
      const cleanup: string[] = [];
      // Outputs have no DELETE API. Revoke owned access before deleting its
      // profile; the isolated demo shutdown removes retained revocation receipts.
      for (const operation of [
        ...(created
          ? [
              {
                path: `/api/me/outputs/${id}/revoke`,
                method: "post",
                success: "revoked",
              },
            ]
          : []),
        {
          path: `/api/me/profiles/${id}`,
          method: "delete",
          success: "deleted",
        },
      ]) {
        try {
          const response =
            operation.method === "post"
              ? await page.request.post(operation.path, { headers, data: {} })
              : await page.request.delete(operation.path, { headers });
          cleanup.push(
            response.ok() ? operation.success : `HTTP ${response.status()}`,
          );
        } catch {
          cleanup.push("request unavailable after task failure");
        }
      }
      await info
        .attach("synthetic-fixture-cleanup", {
          body: JSON.stringify(cleanup),
          contentType: "application/json",
        })
        .catch(() => {});
      if (!taskError)
        expect(cleanup).toEqual(created ? ["revoked", "deleted"] : ["deleted"]);
    }
  });
}
