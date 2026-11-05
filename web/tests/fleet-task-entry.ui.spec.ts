import { expect, test } from "@playwright/test";
import { settledTask } from "./ui-settled-task";

// Actual production task, strict read-only loopback fixtures. No preview, batch
// creation, node command, service permission or persistent change is performed.
for (const width of [390, 1440]) {
  test(`fleet range follows path selection and retains canceled choices at ${width}`, async ({
    page,
  }, info) => {
    const baseURL = test.info().project.use.baseURL;
    if (
      !baseURL ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
    )
      throw new Error("Fleet task review requires loopback");
    const origin = new URL(baseURL).origin;
    const core = {
      id: "core",
      name: "办公核心",
      hostId: "host",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    };
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "reviewer", name: "审查管理员", role: "admin" },
        csrfToken: "unused-read-only-fixture",
      },
      "/api/admin/fleet-batches": [],
      "/api/hosts": [
        {
          id: "host",
          name: "办公服务器",
          group: "办公",
          tags: ["常用"],
          address: "example.test",
        },
      ],
      "/api/core-instances": [core],
      "/api/managed-endpoints": [],
      "/api/links": [],
      "/api/server-deployments": ["办公路径", "备用路径"].map(
        (name, index) => ({
          id: `path-${index}`,
          name,
          ir: { programs: [{ instance: core }] },
        }),
      ),
    };
    const unexpected: string[] = [];
    await page.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push("external request");
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (request.method() !== "GET" || !(url.pathname in fixtures)) {
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({
          status: 503,
          json: { detail: "Unsupported fleet task fixture request" },
        });
      }
      return route.fulfill({ json: fixtures[url.pathname] });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#fleet");
    const opener = page.getByRole("button", { name: "计划变更", exact: true });
    await opener.click();
    const plan = page.getByRole("dialog", {
      name: "计划批量变更",
      exact: true,
    });
    await settledTask(plan);
    await expect(
      plan.getByText("先选择已保存的转发路径。", { exact: true }),
    ).toBeInViewport();
    await expect(
      plan.getByRole("search", { name: "筛选执行范围", exact: true }),
    ).toHaveCount(0);
    await expect(
      plan.getByRole("combobox", { name: "执行顺序", exact: true }),
    ).toHaveCount(0);
    await expect(
      plan.getByRole("button", { name: "预览影响与差异", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: info.outputPath(`fleet-choose-path-${width}.png`),
      animations: "disabled",
    });
    const path = plan.getByRole("combobox", {
      name: "批量变更转发路径",
      exact: true,
    });
    await path.click();
    await page.getByRole("option", { name: "办公路径", exact: true }).click();
    await plan
      .getByRole("button", { name: "选择筛选结果", exact: true })
      .click();
    const strategy = plan.getByRole("combobox", {
      name: "执行顺序",
      exact: true,
    });
    await strategy.click();
    await page
      .getByRole("option", { name: /^自定义分组\s*为实例指定阶段$/ })
      .click();
    const stage = plan.getByRole("spinbutton", {
      name: "办公核心 的执行阶段",
      exact: true,
    });
    await stage.fill("3");
    const search = plan.getByRole("textbox", {
      name: "筛选批量变更实例",
      exact: true,
    });
    await search.fill("没有匹配");
    await expect(
      plan.getByText("没有匹配的实例", { exact: true }),
    ).toBeVisible();
    const reset = plan.getByRole("button", { name: "清除筛选", exact: true });
    await reset.scrollIntoViewIfNeeded();
    await expect(reset).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`fleet-no-filter-match-${width}.png`),
      animations: "disabled",
    });
    await reset.focus();
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await expect(
      plan.getByRole("checkbox", { name: "选择实例 办公核心", exact: true }),
    ).toBeChecked();
    await expect(stage).toHaveValue("3");
    for (let attempt = 0; attempt < 2; attempt++) {
      await path.click();
      await page.getByRole("option", { name: "备用路径", exact: true }).click();
      const decision = page.getByRole("alertdialog", {
        name: "更换转发路径？",
        exact: true,
      });
      await settledTask(decision);
      const keep = decision.getByRole("button", {
        name: "保留当前路径",
        exact: true,
      });
      await expect(keep).toBeFocused();
      for (const action of [
        keep,
        decision.getByRole("button", { name: "更换路径", exact: true }),
      ]) {
        await expect(action).toBeInViewport({ ratio: 1 });
        expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      if (attempt === 0)
        await page.screenshot({
          path: info.outputPath(`fleet-change-path-confirmation-${width}.png`),
          animations: "disabled",
        });
      await page.keyboard.press("Escape");
      await expect(decision).toHaveCount(0);
      await expect(path).toBeFocused();
      await expect(path).toHaveText("办公路径");
      await expect(stage).toHaveValue("3");
      await expect(
        plan.getByRole("checkbox", { name: "选择实例 办公核心", exact: true }),
      ).toBeChecked();
    }
    await path.click();
    await page.getByRole("option", { name: "备用路径", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "更换转发路径？", exact: true })
      .getByRole("button", { name: "更换路径", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(path).toBeFocused();
    await expect(path).toHaveText("备用路径");
    await expect(
      plan.getByText("已选择 0 个实例", { exact: true }),
    ).toBeVisible();
    await expect(stage).toHaveValue("1");
    await plan.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("alertdialog", {
        name: "放弃未创建的批量变更计划？",
        exact: true,
      })
      .getByRole("button", { name: "放弃计划", exact: true })
      .click();
    await expect(plan).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect(unexpected).toEqual([]);
  });
}
