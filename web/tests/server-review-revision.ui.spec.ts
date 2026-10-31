import { expect, test } from "@playwright/test";
import path from "node:path";

for (const width of [1440, 390]) {
  test(`a changed saved path requires visible reload and a new review at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const writes: string[] = [];
    // The review journey must never invoke native/live application.
    await page.route("**/api/server-deployments/*/publish", async (route) => {
      writes.push(route.request().url());
      await route.abort("blockedbyclient");
    });
    const auth = await page.request.post("/api/auth/login", {
      data: { username: "routeweaver", password: "local-demo-password" },
    });
    expect(auth.ok()).toBeTruthy();
    const session = await auth.json();
    const headers = { "X-CSRF-Token": session.csrfToken };
    const create = async (kind: string, data: unknown) => {
      const response = await page.request.post(`/api/${kind}`, {
        headers,
        data,
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const suffix = `${width}-${Date.now().toString(36)}`;
    const host = {
      id: `review-host-${suffix}`,
      name: "Review server",
      address: "review.example.invalid",
    };
    const instance = {
      id: `review-core-${suffix}`,
      hostId: host.id,
      name: "Review core",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    };
    const listener = {
      id: `review-listener-${suffix}`,
      instanceId: instance.id,
      name: "Review listener",
      connection: {
        protocol: "socks",
        host: "0.0.0.0",
        port: 1080,
        username: "fixture-user",
        password: "fixture-password",
      },
    };
    await create("hosts", host);
    await create("core-instances", instance);
    await create("managed-endpoints", listener);
    const draft = {
      id: `review-path-${suffix}`,
      name: "Review path",
      ir: {
        schemaVersion: "1.0",
        id: `review-path-${suffix}`,
        topologyRevision: "fixture-1",
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
    const opened = await create("server-deployments", draft);
    await page.goto(`/#routes?deployment=${draft.id}`);
    let detail = page.getByRole("dialog", { name: "Review path", exact: true });
    await expect(detail.getByText("直连", { exact: true })).toBeVisible();
    // Another editor saves B while this view still shows A. No server apply.
    const changed = {
      ...draft,
      ir: {
        ...draft.ir,
        programs: [
          { ...draft.ir.programs[0], defaultAction: { kind: "reject" } },
        ],
      },
    };
    const saved = await page.request.put(
      `/api/server-deployments/${draft.id}`,
      {
        headers: { ...headers, "If-Match": opened.revisionToken },
        data: changed,
      },
    );
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const staleCheck = page.waitForResponse((response) =>
      response.url().endsWith(`/${draft.id}/validate`),
    );
    await detail.getByRole("button", { name: "查看修改并应用" }).click();
    const response = await staleCheck;
    expect(response.status()).toBe(409);
    const refusal = await response.json();
    expect(refusal.code).toBe("SERVER_DRAFT_CHANGED");
    expect(refusal.fingerprint).toBeUndefined();
    await expect(
      detail.getByText("转发路径已变化", { exact: true }),
    ).toBeVisible();
    await expect(detail.getByText("直连", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认并应用" })).toHaveCount(
      0,
    );
    await expect(
      detail.getByRole("button", { name: "查看修改并应用" }),
    ).toBeDisabled();
    if (width === 390) {
      const notice = detail
        .getByRole("alert")
        .filter({ hasText: "转发路径已变化" });
      const description = await notice
        .locator("[data-slot=alert-description]")
        .boundingBox();
      const recovery = await notice
        .getByRole("button", { name: "重新载入转发路径" })
        .boundingBox();
      expect(description!.width).toBeGreaterThan(260);
      expect(recovery!.y).toBeGreaterThanOrEqual(
        description!.y + description!.height,
      );
      expect(recovery!.height).toBeGreaterThanOrEqual(44);
    }
    const output = process.env.ROUTEWEAVER_EVIDENCE_DIR;
    if (output)
      await page.screenshot({
        path: path.join(output, `stale-review-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    await detail.getByRole("button", { name: "重新载入转发路径" }).click();
    detail = page.getByRole("dialog", { name: "Review path", exact: true });
    await expect(detail.getByText("拒绝连接", { exact: true })).toBeVisible();
    await expect(detail.getByText("直连", { exact: true })).toHaveCount(0);
    await detail.getByRole("button", { name: "查看修改并应用" }).click();
    const review = page.getByRole("dialog", {
      name: "应用转发路径修改",
      exact: true,
    });
    await expect(review.getByText("拒绝连接", { exact: true })).toBeVisible();
    await expect(
      review.getByRole("button", { name: "确认并应用" }),
    ).toBeDisabled();
    for (const checkbox of await review.getByRole("checkbox").all())
      await expect(checkbox).not.toBeChecked();
    if (output)
      await page.screenshot({
        path: path.join(output, `reloaded-review-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    await expect(page.locator("body")).not.toContainText("fixture-password");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    expect(overflow).toBe(false);
    await review.getByRole("button", { name: /^返\s*回$/ }).click();
    const state = await page.request.get(
      `/api/agent/instances/${instance.id}/state`,
    );
    expect((await state.json()).phase).toBe("unregistered");
    expect(writes).toHaveLength(0);
  });
}
