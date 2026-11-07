import { test, expect } from "@playwright/test";
import { endpointImpactConnection } from "./fixtures/endpoint-impact";

// Controlled synthetic HTTP + actual App geometry; backend authorization/CAS
// is exercised independently by TestEndpointImpactReviewBindsDraftAndDependencies.
test.use({ trace: "off", screenshot: "off", video: "off" });
test("shared endpoint impact review stays readable and cancel preserves exact draft at 320px", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const base = test.info().project.use.baseURL;
  if (
    !base ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)
  )
    throw new Error("Controlled endpoint review requires loopback");
  const endpoint = {
    id: "shared",
    name: "跨区域协作共享入口",
    instanceId: "core",
    revisionToken: "fixture-revision",
    connection: { ...endpointImpactConnection },
  };
  const fixtures: Record<string, unknown> = {
    "/auth/me": {
      user: { id: "admin", name: "Admin", role: "admin" },
      csrfToken: "fixture",
    },
    "/state": {
      nodes: [],
      users: [],
      routes: [],
      revisions: [],
      capabilities: [],
    },
    "/hosts": [{ id: "host", name: "参考服务器", address: "127.0.0.1" }],
    "/core-instances": [
      {
        id: "core",
        hostId: "host",
        name: "参考核心",
        adapterId: "routeweaver/xray",
        version: "26.10.31",
      },
    ],
    "/managed-endpoints": [endpoint],
    "/managed-endpoints/shared/reveal": endpoint,
    "/links": [],
    "/server-deployments": [],
    "/published-routes": [],
    "/services": [],
    "/rates": [],
    "/user-groups": [],
    "/settings": {},
  };
  const unexpected: string[] = [];
  let reviews = 0;
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== new URL(base).origin) {
      unexpected.push("external");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const key = url.pathname.slice(4);
    if (
      key === "/managed-endpoints/shared/impact" &&
      request.method() === "POST"
    ) {
      reviews++;
      const draft = request.postDataJSON();
      expect(draft.name).toBe("保留的共享入口修改");
      expect(draft.connection).toEqual(endpointImpactConnection);
      expect(request.headers()["if-match"]).toBe("fixture-revision");
      return route.fulfill({
        json: {
          endpoint: { id: endpoint.id, name: endpoint.name },
          proposed: {
            name: draft.name,
            instanceId: "core",
            instanceName: "参考核心",
            protocol: draft.connection.protocol,
            host: draft.connection.host,
            port: draft.connection.port,
          },
          changedFields: ["名称"],
          deployments: [
            { id: "deployment", name: "欧洲与亚太联合维护的共享转发配置" },
          ],
          routes: [{ id: "route", name: "跨区域协作用户的公开线路" }],
          links: [{ id: "link", name: "共享连接关系" }],
          reviewToken: `review-${reviews}`,
        },
      });
    }
    if (request.method() !== "GET" || !(key in fixtures)) {
      unexpected.push(`${request.method()} ${key}`);
      return route.fulfill({
        status: 503,
        json: { detail: "Unexpected controlled request" },
      });
    }
    return route.fulfill({ json: fixtures[key] });
  });
  await page.goto("/#servers");
  await page.getByRole("tab", { name: "监听端点 1" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑监听端点" });
  const port = editor.getByRole("spinbutton", { name: "端口", exact: true });
  for (const raw of ["1e", "443.0000000000000000001"]) {
    await port.fill(raw);
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(port).toHaveAttribute("aria-invalid", "true");
    await expect(port).toHaveValue(raw);
    expect(reviews).toBe(0);
  }
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  const discard = page.getByRole("alertdialog", { name: "放弃尚未保存的配置修改？", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(port).toHaveValue("443.0000000000000000001");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(port).toHaveValue(String(endpointImpactConnection.port));
  const name = editor.getByLabel("端点名称", { exact: true });
  await name.fill("保留的共享入口修改");
  const save = editor.getByRole("button", { name: "保存", exact: true });
  for (let n = 0; n < 2; n++) {
    await save.click();
    const review = page.getByRole("alertdialog", {
      name: `保存端点「${endpoint.name}」的修改？`,
    });
    await expect(
      review.getByText("跨区域协作用户的公开线路", { exact: false }),
    ).toBeVisible();
    await expect(review).not.toContainText(endpointImpactConnection.password);
    const box = await review.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const cancel = review.getByRole("button", {
      name: "返回编辑",
      exact: true,
    });
    await cancel.scrollIntoViewIfNeeded();
    await expect(cancel).toBeInViewport();
    await expect(
      review.getByRole("button", { name: "确认保存端点" }),
    ).toBeInViewport();
    if (n === 0)
      await page.screenshot({
        path: info.outputPath("endpoint-impact-320.png"),
      });
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await expect(save).toBeFocused();
    await expect(name).toHaveValue("保留的共享入口修改");
  }
  expect(reviews).toBe(2);
  expect(unexpected).toEqual([]);
});
