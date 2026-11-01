import { test, expect } from "@playwright/test";

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
    connection: { protocol: "socks", host: "127.0.0.1", port: 1080 },
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
      expect(request.headers()["if-match"]).toBe("fixture-revision");
      return route.fulfill({
        json: {
          endpoint,
          proposed: {
            name: draft.name,
            instanceId: "core",
            instanceName: "参考核心",
            ...draft.connection,
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
