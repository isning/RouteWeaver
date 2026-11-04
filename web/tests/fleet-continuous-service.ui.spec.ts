import { expect, test, type Locator, type Page } from "@playwright/test";

async function scrollSheetToBottom(page: Page, dialog: Locator) {
  const body = dialog.locator("[data-task-overlay-body]");
  await expect(body).toBeVisible();
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.hover();
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  return body;
}

async function visibleControl(control: Locator, body: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  const box = (await control.boundingBox())!, bounds = (await body.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
  expect(await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === element || (hit !== null && element.contains(hit));
  })).toBe(true);
}

// Controlled preview only; no batch creation, node execution or real service mutation.
for (const width of [320, 390, 1440]) {
  test(`continuous service is explicit and review-bound at ${width}`, async ({
    page,
  }, info) => {
    const baseURL = test.info().project.use.baseURL;
    if (
      !baseURL ||
      !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
    )
      throw new Error("Controlled fleet review requires loopback");
    const origin = new URL(baseURL).origin;
    const instance = {
      id: "core",
      name: "Core",
      hostId: "host",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "viewer", name: "Admin", role: "admin" },
        csrfToken: "synthetic",
      },
      "/api/admin/fleet-batches": [],
      "/api/hosts": [{ id: "host", name: "Host", address: "10.0.0.1" }],
      "/api/core-instances": [instance],
      "/api/managed-endpoints": [],
      "/api/links": [],
      "/api/server-deployments": [
        {
          id: "path",
          name: "Path",
          status: "draft",
          diagnostics: [],
          ir: {
            programs: [
              {
                instance,
                listener: {
                  id: "entry",
                  connection: {
                    protocol: "socks",
                    host: "0.0.0.0",
                    port: 1080,
                  },
                },
                egress: [],
                rules: [],
                resources: [],
              },
            ],
          },
        },
      ],
    };
    const unexpected: string[] = [],
      previews: any[] = [];
    await page.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push("external");
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (
        url.pathname === "/api/admin/fleet-batches/preview" &&
        request.method() === "POST"
      ) {
        const input = request.postDataJSON();
        previews.push(input);
        return route.fulfill({
          json: {
            ...input,
            fingerprint: "synthetic-reviewed",
            targets: [],
            affectedUsers: 0,
            supported: true,
            diagnostics: [],
          },
        });
      }
      if (request.method() !== "GET" || !(url.pathname in fixtures)) {
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({
          status: 503,
          json: { detail: "Unexpected controlled fleet request" },
        });
      }
      return route.fulfill({ json: fixtures[url.pathname] });
    });
    await page.setViewportSize({ width, height: width === 320 ? 360 : 844 });
    await page.goto("/#fleet");
    await page.getByRole("button", { name: "计划变更", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "计划批量变更",
      exact: true,
    });
    const continuing = dialog.getByRole("checkbox", {
      name: "持续运行并有限自动恢复",
      exact: true,
    });
    await expect(continuing).not.toBeChecked();
    await dialog
      .getByRole("combobox", { name: "批量变更转发路径", exact: true })
      .click();
    await page.getByRole("option", { name: "Path", exact: true }).click();
    await dialog
      .getByRole("button", { name: "选择筛选结果", exact: true })
      .click();
    await continuing.check();
    const preview = dialog.getByRole("button", { name: "预览影响与差异", exact: true });
    if (width === 390) {
      const body = await scrollSheetToBottom(page, dialog);
      const cancel = dialog.getByRole("button", { name: "取消", exact: true });
      await visibleControl(cancel, body);
      await cancel.focus();
      await page.keyboard.press("Tab");
      await expect(preview).toBeFocused();
      await visibleControl(preview, body);
      const cancelBox = (await cancel.boundingBox())!, previewBox = (await preview.boundingBox())!;
      expect(cancelBox.x + cancelBox.width <= previewBox.x + 1 || cancelBox.y + cancelBox.height <= previewBox.y + 1).toBe(true);
      await info.attach("fleet-drawer-390-plan-bottom-keyboard", {
        body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
      });
    }
    await preview.click();
    await expect(dialog.getByText(/最多自动恢复 3 次/)).toBeVisible();
    const consequence = dialog.getByText(/最多自动恢复 3 次/);
    await consequence.scrollIntoViewIfNeeded();
    await expect(consequence).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`continuous-service-consequence-${width}.png`),
    });
    const reviewed = dialog.getByRole("checkbox", {
      name: "我已核对实例、阶段与影响范围",
      exact: true,
    });
    await reviewed.check();
    const create = dialog.getByRole("button", {
      name: "创建待执行批次",
      exact: true,
    });
    if (width === 390) {
      const body = await scrollSheetToBottom(page, dialog);
      await reviewed.focus();
      await page.keyboard.press("Tab");
      await expect(create).toBeFocused();
      await visibleControl(create, body);
      await expect(dialog.getByText("创建计划不会执行。下一步逐阶段确认开始。", { exact: true })).toBeInViewport({ ratio: 1 });
      await info.attach("fleet-drawer-390-review-bottom-keyboard", {
        body: await page.screenshot({ animations: "disabled" }), contentType: "image/png",
      });
    } else await create.focus();
    await expect(create).toBeInViewport();
    await page.screenshot({
      path: info.outputPath(`continuous-service-review-${width}.png`),
    });
    await continuing.uncheck();
    await expect(create).toHaveCount(0);
    expect(previews).toHaveLength(1);
    expect(previews[0].continuousService).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect(unexpected).toEqual([]);
  });
}
