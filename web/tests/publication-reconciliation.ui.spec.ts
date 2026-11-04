import { test, expect, type Page } from "@playwright/test";
import { surfaceMotionState } from "./ui-surface-stability";
// Controlled HTTP browser evidence, not backend receipt persistence or native apply proof.
for (const width of [1440, 390])
  test(`unknown publication survives close and reload, then explicitly reconciles at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const instance = {
      id: "core",
      name: "法兰克福实例",
      hostId: "host",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    };
    const listener = {
      id: "entry",
      name: "法兰克福入口",
      instanceId: "core",
      connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
    };
    const deployment = {
      id: "office",
      name: "欧洲转发路径",
      status: "draft",
      diagnostics: [],
      revisionToken: "fixture-opened",
      ir: {
        schemaVersion: "1.0",
        id: "office",
        topologyRevision: "fixture",
        programs: [
          {
            instance,
            listener,
            egress: [],
            rules: [],
            resources: [],
            defaultAction: { kind: "direct" },
          },
        ],
      },
    };
    const writes: Record<string, unknown>[] = [];
    let lookups = 0;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      if (url === "/auth/me")
        return route.fulfill({
          json: {
            user: { id: "admin-a", name: "测试管理员", role: "admin" },
            csrfToken: "synthetic",
          },
        });
      if (url.endsWith("/office/publish")) {
        const body = route.request().postDataJSON();
        writes.push(body);
        const stored = await page.evaluate(() =>
          JSON.parse(
            sessionStorage.getItem("routeweaver.publication-request.v1")!,
          ),
        );
        expect(body).toEqual({
          operationId: stored.operationId,
          ...stored.request,
        });
        return route.abort("failed");
      }
      if (url.includes("/publication-requests/")) {
        lookups++;
        const sent = writes[0];
        return route.fulfill({
          json: {
            request: {
              leaseSeconds: sent.leaseSeconds,
              accessAllowed: sent.accessAllowed,
              quotaCertain: sent.quotaCertain,
              expectedFingerprint: sent.expectedFingerprint,
            },
            result: {
              operationId: sent.operationId,
              deploymentId: "office",
              status: "publication-accepted",
              nativeChecked: false,
              instances: [
                {
                  instanceId: "core",
                  generation: "9007199254740993",
                  operationId: "agent-a",
                  revisionId: "revision-a",
                },
              ],
            },
          },
        });
      }
      if (url.endsWith("/office/validate"))
        return route.fulfill({
          json: {
            valid: true,
            diagnostics: [],
            artifacts: [],
            fingerprint: "a".repeat(64),
          },
        });
      const data: Record<string, unknown> = {
        "/hosts": [{ id: "host", name: "法兰克福", address: "10.0.0.1" }],
        "/core-instances": [instance],
        "/managed-endpoints": [listener],
        "/server-deployments": [deployment],
        "/core-instances/core/state": {
          instanceId: "core",
          phase: "unregistered",
        },
      };
      return route.fulfill({ json: data[url] || [] });
    });
    await page.goto("/#routes?deployment=office");
    const detail = page.getByRole("dialog", {
      name: "欧洲转发路径",
      exact: true,
    });
    await expect(detail).toBeVisible();
    await expect
      .poll(() => detail.evaluate(surfaceMotionState))
      .toEqual({ opacity: "1", preparing: false, running: false });
    const open = detail.getByRole("button", {
      name: "查看修改并应用",
      exact: true,
    });
    await open.focus();
    await page.keyboard.press("Enter");
    const review = page.getByRole("dialog", {
      name: "应用转发路径修改",
      exact: true,
    });
    await review
      .getByRole("checkbox", {
        name: "确认允许此转发路径提供访问",
        exact: true,
      })
      .check();
    await review
      .getByRole("checkbox", {
        name: "已确认目标实例可执行当前额度策略",
        exact: true,
      })
      .check();
    await review
      .getByRole("button", { name: "确认并应用", exact: true })
      .click();
    await expect(
      review.getByText("提交结果待确认", { exact: true }),
    ).toBeVisible();
    await expect(
      review.getByRole("button", { name: "查询提交结果", exact: true }),
    ).toBeEnabled();
    expect(writes).toHaveLength(1);
    expect(lookups).toBe(0);
    await expect
      .poll(() => review.evaluate(surfaceMotionState))
      .toEqual({ opacity: "1", preparing: false, running: false });
    await page.screenshot({
      path: info.outputPath(`unknown-${width}.png`),
      fullPage: true,
    });
    await review.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(review).toHaveCount(0);
    await page.reload();
    await expect(
      detail.getByRole("button", { name: "查询提交结果", exact: true }),
    ).toBeEnabled();
    expect(writes).toHaveLength(1);
    expect(lookups).toBe(0);
    const reconcile = detail.getByRole("button", {
      name: "查询提交结果",
      exact: true,
    });
    await reconcile.focus();
    await page.keyboard.press("Enter");
    await expect(
      detail.getByText("该次提交已接收", { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByText("提交已接收，实际应用结果请查看实例状态。", { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "再次检查并应用", exact: true }),
    ).toHaveAttribute("data-variant", "outline");
    await expect
      .poll(() =>
        page.evaluate(() =>
          sessionStorage.getItem("routeweaver.publication-request.v1"),
        ),
      )
      .toBeNull();
    expect(writes).toHaveLength(1);
    expect(lookups).toBe(1);
    await expect
      .poll(() => detail.evaluate(surfaceMotionState))
      .toEqual({ opacity: "1", preparing: false, running: false });
    await page.screenshot({
      path: info.outputPath(`accepted-${width}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
