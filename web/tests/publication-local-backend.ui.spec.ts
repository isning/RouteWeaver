import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { surfaceMotionState } from "./ui-surface-stability";
import { openWorkspace } from "./ui-session";
// Actual loopback demo HTTP persistence; no agent starts, native apply or traffic.
for (const width of [1440, 390])
  test(`real accepted publication with dropped response recovers after reload at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await openWorkspace(page);
    const me = await page.request.get("/api/auth/me");
    expect(me.ok(), "The normally authenticated actor remains confirmed").toBe(
      true,
    );
    const session = await me.json();
    const headers = { "X-CSRF-Token": session.csrfToken };
    const suffix = `rw-pub-${width}-${Date.now().toString(36)}`;
    const fixture = JSON.parse(
      (
        await readFile(
          new URL("./fixtures/publication-local-server.json", import.meta.url),
          "utf8",
        )
      ).replaceAll("rw-publication", suffix),
    );
    for (const record of fixture) {
      const response = await page.request.post(`/api/${record.path}`, {
        headers,
        data: record.body,
      });
      expect(response.status(), `bootstrap ${record.path}`).toBe(200);
    }
    const draft = fixture.find(
      (record: { path: string }) => record.path === "server-deployments",
    ).body;
    for (const program of draft.ir.programs) {
      const enrolled = await page.request.post("/api/agent/enrollments", {
        headers,
        data: {
          nodeId: program.instance.hostId,
          instanceId: program.instance.id,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(enrolled.status()).toBe(201); // Deliberately never read or attach returned enrollment token.
    }
    let writes = 0,
      reads = 0;
    let exactBody: Record<string, unknown> | undefined,
      receipt: Record<string, unknown> | undefined;
    await page.route(
      `**/api/server-deployments/${draft.id}/publish`,
      async (route) => {
        writes++;
        exactBody = route.request().postDataJSON();
        const stored = await page.evaluate(() =>
          JSON.parse(
            sessionStorage.getItem("routeweaver.publication-request.v1")!,
          ),
        );
        expect(exactBody).toEqual({
          operationId: stored.operationId,
          ...stored.request,
        });
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        receipt = await response.json();
        expect(receipt?.status).toBe("publication-accepted");
        await route.abort("failed");
      },
    );
    page.on("request", (request) => {
      if (request.url().includes("/publication-requests/")) reads++;
    });
    const started = Date.now();
    const phases: {
      kind: string;
      path: string;
      elapsedMs: number;
      status?: number;
    }[] = [];
    const inventoryPaths = [
      "/api/hosts",
      "/api/core-instances",
      "/api/managed-endpoints",
      "/api/links",
      "/api/server-deployments",
    ];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (inventoryPaths.includes(path))
        phases.push({ kind: "request", path, elapsedMs: Date.now() - started });
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (inventoryPaths.includes(path))
        phases.push({
          kind: "response",
          path,
          status: response.status(),
          elapsedMs: Date.now() - started,
        });
    });
    // Await the actual cold inventory dependency, not a guessed render interval. The
    // original 45s whole-task budget still bounds this and all later phases.
    const inventoryLoaded = Promise.all(
      inventoryPaths.map((path) =>
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path &&
            response.request().method() === "GET",
        ),
      ),
    );
    await page.goto(`/#routes?deployment=${draft.id}`);
    try {
      await expect(
        page.getByRole("heading", { name: "转发路径", exact: true, level: 1 }),
      ).toBeVisible();
      for (const response of await inventoryLoaded)
        expect(response.status()).toBe(200);
    } finally {
      await writeFile(
        info.outputPath("cold-inventory-phases.json"),
        JSON.stringify({
          phases,
          hash: await page.evaluate(() => location.hash),
        }),
      );
    }
    const detail = page.getByRole("dialog", { name: draft.name, exact: true });
    await expect(detail).toBeVisible();
    await detail
      .getByRole("button", { name: "查看修改并应用", exact: true })
      .click();
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
    const apply = review.getByRole("button", {
      name: "确认并应用",
      exact: true,
    });
    if (width === 390) await apply.tap();
    else {
      await apply.focus();
      await page.keyboard.press("Enter");
    }
    await expect(
      review.getByText("提交结果待确认", { exact: true }),
    ).toBeVisible();
    await expect(
      review.getByRole("button", { name: "查询提交结果", exact: true }),
    ).toBeEnabled();
    expect(writes).toBe(1);
    expect(reads).toBe(0);
    await expect
      .poll(() => review.evaluate(surfaceMotionState))
      .toEqual({ opacity: "1", preparing: false, running: false });
    await page.screenshot({
      path: info.outputPath(`actual-unknown-${width}.png`),
      fullPage: false,
    });
    await review.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect
      .soft(
        detail.getByRole("button", { name: "查询提交结果", exact: true }),
        "unknown review close returns focus to its available recovery action",
      )
      .toBeFocused();
    await writeFile(
      info.outputPath("after-close-focus.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          label: document.activeElement?.getAttribute("aria-label"),
          hasFocus: document.hasFocus(),
          visibility: document.visibilityState,
          text:
            document.activeElement?.tagName === "BUTTON"
              ? document.activeElement.textContent
              : undefined,
        })),
      ),
    );
    await page.reload();
    const reconcile = detail.getByRole("button", {
      name: "查询提交结果",
      exact: true,
    });
    await expect(reconcile).toBeEnabled();
    expect(writes).toBe(1);
    expect(reads).toBe(0);
    if (width === 390) await reconcile.tap();
    else {
      await reconcile.focus();
      await page.keyboard.press("Enter");
    }
    await expect(
      detail.getByText("该次提交已接收", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          sessionStorage.getItem("routeweaver.publication-request.v1"),
        ),
      )
      .toBeNull();
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    const desiredBefore = [];
    for (const program of draft.ir.programs) {
      const response = await page.request.get(
        `/api/agent/instances/${program.instance.id}/state`,
      );
      expect(response.status()).toBe(200);
      const state = await response.json();
      const acknowledged = (
        receipt!.instances as { instanceId: string; generation: string }[]
      ).find((item) => item.instanceId === program.instance.id);
      expect(String(state.desired.generation)).toBe(acknowledged!.generation);
      expect(state.phase).toBe("queued");
      desiredBefore.push(state.desired);
    }
    const replay = await page.request.post(
      `/api/server-deployments/${draft.id}/publish`,
      { headers, data: exactBody },
    );
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    for (let index = 0; index < draft.ir.programs.length; index++) {
      const response = await page.request.get(
        `/api/agent/instances/${draft.ir.programs[index].instance.id}/state`,
      );
      const state = await response.json();
      expect(state.desired).toEqual(desiredBefore[index]);
      expect(state.phase).toBe("queued");
    }
    await expect(
      detail.getByText("接收记录不代表当前实例已应用。", { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "再次检查并应用", exact: true }),
    ).toHaveAttribute("data-variant", "outline");
    await expect
      .poll(() => detail.evaluate(surfaceMotionState))
      .toEqual({ opacity: "1", preparing: false, running: false });
    await page.screenshot({
      path: info.outputPath(`actual-accepted-${width}.png`),
      fullPage: false,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
