import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { surfaceMotionState } from "./ui-surface-stability";

// Public HTTP-shaped synthetic fixtures. No request escapes to a backend,
// no native apply runs, and no actual account or credential is modified.
for (const { width, origin } of [
  { width: 1280, origin: "users" },
  { width: 390, origin: "users" },
  { width: 390, origin: "line detail" },
]) {
  test(`rotated managed entry retains its named path continuation from ${origin} at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const member = {
      id: "rotation-owner",
      name: "小林",
      enabled: true,
      quotaBytes: 0,
      usedBytes: 0,
    };
    const line = {
      id: "managed-line",
      name: "伦敦线路",
      deploymentId: "managed-path",
      endpointIds: ["entry"],
      publicHost: "public.example.invalid",
      publicPort: 443,
      status: "effective",
      diagnostics: [],
    };
    const instance = {
      id: "core",
      hostId: "host",
      name: "入口实例",
      adapterId: "routeweaver/managed-xray",
      version: "26.3.27-rw1",
    };
    const listener = {
      id: "entry",
      name: "伦敦入口",
      instanceId: "core",
      connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
    };
    const deployment = {
      id: "managed-path",
      name: "伦敦转发",
      revisionToken: "synthetic-opened-revision",
      status: "draft",
      ir: {
        schemaVersion: "1.0",
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
    let status = "effective";
    let phase = "authenticated Users readiness";
    const requests: { method: string; path: string }[] = [];
    const writes: { path: string; body: unknown }[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      requests.push({ method: request.method(), path });
      if (request.method() !== "GET") {
        writes.push({ path, body: request.postDataJSON() });
        if (path === "/api/published-routes/managed-line/principals") {
          status = "pending-deployment";
          return route.fulfill({
            status: 201,
            json: { status, entryId: "managed-grant" },
          });
        }
      } else {
        const data: Record<string, unknown> = {
          "/api/auth/me": {
            user: { id: "administrator", name: "Administrator", role: "admin" },
            csrfToken: "synthetic-csrf",
          },
          "/api/state": {
            nodes:
              origin === "line detail"
                ? [
                    {
                      id: "legacy-node",
                      name: "旧连接",
                      protocol: "socks",
                      host: "127.0.0.1",
                      port: 1080,
                    },
                  ]
                : [],
            routes:
              origin === "line detail"
                ? [
                    {
                      id: line.id,
                      name: "同 ID 的旧线路",
                      engine: "xray",
                      hops: ["legacy-node"],
                      userIds: [member.id],
                    },
                  ]
                : [],
            users: [member],
            revisions: [],
            capabilities: [],
            deploymentAvailable: true,
            publishedRoutes: [line],
          },
          "/api/published-routes": [line],
          "/api/published-routes/managed-line/resolve": line,
          "/api/settings": {},
          "/api/services": [],
          "/api/user-groups": [],
          "/api/access-policy/groups": [],
          "/api/links": [],
          "/api/hosts": [
            {
              id: "host",
              name: "入口服务器",
              address: "public.example.invalid",
            },
          ],
          "/api/core-instances": [instance],
          "/api/managed-endpoints": [listener],
          "/api/server-deployments": [deployment],
          "/api/agent/instances/core/state": { phase: "unregistered" },
          "/api/users/rotation-owner/entries": [
            {
              id: "managed-grant",
              name: "小林的入口",
              routeId: line.id,
              publishedRouteId: line.id,
              deploymentId: deployment.id,
              credentialVersion: "synthetic-version",
              status,
            },
          ],
          "/api/users/rotation-owner/entitlement": {},
          "/api/users/rotation-owner/effective-policy": {
            userId: member.id,
            routeIds: [line.id],
            status: "active",
            provenance: { routes: "direct" },
            entitlement: { cycle: { mode: "none" } },
          },
        };
        if (Object.hasOwn(data, path))
          return route.fulfill({ json: data[path] });
        if (
          path.endsWith("/notifications") ||
          path.endsWith("/unread") ||
          path.endsWith("/entitlements") ||
          path.endsWith("/groups")
        )
          return route.fulfill({ json: [] });
      }
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 500,
        json: { detail: "Unexpected synthetic request" },
      });
    });
    try {
      if (origin === "users") {
        await page.goto("/#users");
        await expect(
          page.getByRole("heading", { name: "用户", exact: true, level: 1 }),
        ).toBeVisible();
        const user = page.getByRole("row", { name: /小林/ });
        await expect(user).toBeVisible();
        const trigger = user.getByRole("button", {
          name: "平台入口",
          exact: true,
        });
        await trigger.click();
        let surface = page.getByRole("dialog", {
          name: "小林 的平台入口",
          exact: true,
        });
        await expect
          .poll(() => surface.evaluate(surfaceMotionState))
          .toMatchObject({ preparing: false, running: false, opacity: "1" });
        await surface
          .getByRole("button", { name: "关闭", exact: true })
          .click();
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect
          .poll(() => surface.evaluate(surfaceMotionState))
          .toMatchObject({ preparing: false, running: false, opacity: "1" });
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
        await trigger.click();
      } else {
        await page.goto(
          "/#published-routes?line=managed-line&user=rotation-owner",
        );
        const detail = page.getByRole("dialog", {
          name: "伦敦线路",
          exact: true,
        });
        await expect(detail).toBeVisible();
        await detail
          .getByRole("button", { name: "管理此用户入口", exact: true })
          .click();
      }
      phase = "open named entry";
      const drawer = page.getByRole("dialog", {
        name: "小林 的平台入口",
        exact: true,
      });
      await expect
        .poll(() => drawer.evaluate(surfaceMotionState))
        .toMatchObject({ preparing: false, running: false, opacity: "1" });
      const row = drawer.getByRole("listitem", {
        name: "小林的入口",
        exact: true,
      });
      await expect(row).toBeVisible();
      await expect(row.getByText("伦敦线路", { exact: true })).toBeVisible();
      await expect(
        row.getByText("同 ID 的旧线路", { exact: true }),
      ).toHaveCount(0);
      phase = "explicit rotation";
      await row.getByRole("button", { name: "轮换凭据", exact: true }).click();
      await page
        .getByRole("button", { name: "准备新凭据", exact: true })
        .click();
      await expect(row).toContainText("尚未确认生效");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path: "/api/published-routes/managed-line/principals",
        body: { accountId: member.id, entryId: "managed-grant" },
      });
      phase = "persistent continuation";
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`rotated-entry-${width}.png`),
      });
      await writeFile(
        info.outputPath("persistent-row.txt"),
        await row.innerText(),
      );
      const next = row.getByRole("link", {
        name: "检查并应用路径",
        exact: true,
      });
      await expect(next).toBeVisible();
      await expect(row.getByText("伦敦线路", { exact: true })).toBeVisible();
      await expect(next).toHaveAttribute(
        "href",
        `#routes?deployment=managed-path&line=managed-line&user=${member.id}`,
      );
      for (const target of [
        row.getByRole("heading"),
        row.getByText("伦敦线路", { exact: true }),
        next,
        row.getByRole("button", { name: "轮换凭据", exact: true }),
        row.getByRole("button", { name: "停止交付", exact: true }),
      ]) {
        const bounds = await target.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await next.click();
      await expect(
        page.getByRole("dialog", { name: "伦敦转发", exact: true }),
      ).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
      phase = "complete";
    } finally {
      await writeFile(
        info.outputPath("journey.json"),
        JSON.stringify(
          { phase, requests, writes, unexpected, errors },
          null,
          2,
        ),
      );
    }
  });
}
