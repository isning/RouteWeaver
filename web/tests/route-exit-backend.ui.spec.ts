import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openWorkspace } from "./ui-session";

// Requires an isolated ephemeral local --demo service. This is real HTTP/domain
// draft-save evidence, not an apply, native engine, credential provisioning or traffic test.
test.use({ trace: "off", screenshot: "off" });
test("existing managed route selects stored plain TCP endpoint absent from its programs and saves a real draft", async ({
  page,
}, info) => {
  await openWorkspace(page);
  const session = await page.request.get("/api/auth/me");
  expect(session.ok()).toBeTruthy();
  const headers = { "X-CSRF-Token": (await session.json()).csrfToken };
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/route-exit-existing-managed.json", import.meta.url),
      "utf8",
    ),
  ) as { path: string; body: Record<string, unknown> }[];
  for (const item of fixture) {
    const result = await page.request.post(`/api/${item.path}`, {
      headers,
      data: item.body,
    });
    if (!result.ok()) {
      const failure = await result.json();
      await info.attach(`bootstrap-${item.path}-error`, {
        contentType: "application/json",
        body: JSON.stringify({
          status: result.status(),
          error: failure.error,
          detail: failure.detail,
          diagnostics: failure.diagnostics,
        }),
      });
    }
    expect(
      result.ok(),
      `Synthetic bootstrap ${item.path}: ${result.status()}`,
    ).toBeTruthy();
  }
  const before = await (
    await page.request.get("/api/server-deployments")
  ).json();
  const original = before.find(
    (item: { id: string }) => item.id === "deployment",
  );
  expect(
    original.ir.programs.map(
      (program: { listener: { id: string } }) => program.listener.id,
    ),
  ).toEqual(["fra", "uk"]);
  const observedWrites: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      new URL(request.url()).pathname.startsWith("/api/")
    )
      observedWrites.push(new URL(request.url()).pathname);
  });
  await page.goto("/#published-routes");
  await page
    .getByRole("button", { name: "Synthetic managed route", exact: true })
    .click();
  await page.getByRole("button", { name: "更换出口", exact: true }).click();
  await page.getByRole("combobox", { name: "新出口服务器" }).click();
  await page.getByText("Alternative UK", { exact: true }).last().click();
  await page.getByRole("combobox", { name: "新出口端点" }).click();
  await page
    .getByText("Alternative UK · vless:1080 · xray", { exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "检查变更", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "核对草稿变更" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "保存后需单独应用，订阅保留原发布版本；应用生效后，使用此入口的已有客户端也会改用新出口。",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("real-backend-managed-retarget-draft-review.png"),
  });
  await page.getByRole("button", { name: "保存出口草稿", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "更换出口", exact: true }),
  ).toBeVisible();
  const routes = await (await page.request.get("/api/published-routes")).json();
  expect(
    routes.find((item: { id: string }) => item.id === "route").endpointIds,
  ).toEqual(["fra", "new-uk"]);
  const after = await (
    await page.request.get("/api/server-deployments")
  ).json();
  expect(
    after
      .find((item: { id: string }) => item.id === "deployment")
      .ir.programs.map(
        (program: { listener: { id: string } }) => program.listener.id,
      ),
  ).toEqual(["fra", "uk", "new-uk"]);
  expect(observedWrites).toEqual([
    "/api/published-routes/route/retarget/preview",
    "/api/published-routes/route/retarget",
  ]);
});
