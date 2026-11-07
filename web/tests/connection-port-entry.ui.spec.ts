import { test, expect } from "@playwright/test";

// Public user tasks with a synthetic HTTP boundary; no backend writes escape.
test("user entry rejects rounded and incomplete ports and resets only after discard", async ({ page }) => {
  const base = test.info().project.use.baseURL;
  if (!base || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
    throw new Error("Connection port regression requires loopback");
  const member = { id: "port-owner", name: "端口用户", enabled: true, quotaBytes: 0, usedBytes: 0 };
  const entry = {
    id: "port-entry", name: "端口入口", routeId: "port-route",
    credentialVersion: "fixture-version", status: "configured",
    connection: { protocol: "socks", host: "endpoint.test", port: 1080 },
  };
  const fixtures: Record<string, unknown> = {
    "/auth/me": { user: { id: "admin", name: "Admin", role: "admin" }, csrfToken: "fixture" },
    "/state": {
      nodes: [], users: [member], revisions: [], capabilities: [],
      routes: [{ id: "port-route", name: "端口线路", engine: "sing-box", hops: [], userIds: [member.id] }],
    },
    "/settings": {}, "/services": [], "/rates": [], "/user-groups": [],
    "/access-policy/groups": [], "/published-routes": [],
    "/users/port-owner/entries": [entry],
    "/users/port-owner/entries/port-entry/reveal": entry,
    "/users/port-owner/entitlement": {},
    "/users/port-owner/effective-policy": { userId: member.id, routeIds: ["port-route"], status: "active", provenance: { routes: "direct" }, entitlement: { cycle: { mode: "none" } } },
  };
  const writes: unknown[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(base).origin) {
      unexpected.push("external request");
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    if (request.method() === "POST" && path === "/users/port-owner/entries") {
      writes.push(request.postDataJSON());
      return route.fulfill({ status: 503, json: { detail: "entry port fixture rejected" } });
    }
    if (request.method() === "GET" && path in fixtures)
      return route.fulfill({ json: fixtures[path] });
    if (request.method() === "GET" && /\/(notifications|unread|entitlements|groups)$/.test(path))
      return route.fulfill({ json: [] });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { detail: "Unexpected port fixture request" } });
  });
  await page.goto("/#users");
  await page.getByRole("row", { name: /端口用户/ }).getByRole("button", { name: "平台入口", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "端口用户 的平台入口", exact: true });
  const edit = sheet.getByRole("listitem", { name: "端口入口", exact: true }).getByRole("button", { name: "编辑", exact: true });
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "编辑 端口入口", exact: true });
  const port = dialog.getByRole("spinbutton", { name: "端口", exact: true });
  await expect(port).toHaveValue("1080");
  for (const raw of ["1e", "1080.0000000000000000001"]) {
    await port.fill(raw);
    await dialog.getByRole("button", { name: "保存入口", exact: true }).click();
    await expect(port).toHaveAttribute("aria-invalid", "true");
    await expect(port).toHaveValue(raw);
    expect(writes).toEqual([]);
  }
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  const discard = page.getByRole("alertdialog", { name: "放弃未保存的入口修改？", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(port).toHaveValue("1080.0000000000000000001");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await discard.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(dialog).toBeHidden();
  await edit.click();
  await expect(port).toHaveValue("1080");
  await dialog.getByRole("button", { name: "保存入口", exact: true }).click();
  await expect(dialog.getByText("entry port fixture rejected", { exact: true })).toBeVisible();
  expect(writes).toEqual([expect.objectContaining({ connection: entry.connection })]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
