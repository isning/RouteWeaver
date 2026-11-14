import { expect, test, type Page } from "@playwright/test";
import type { Output } from "../src/types";
import { navigateWorkspace, openWorkspace } from "./ui-session";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";

// Real UI and backend, synthetic data only. Access credentials stay in memory:
// no recordings, screenshots, response dumps, or token-bearing assertions.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function metadata(page: Page, id: string): Promise<Output> {
  const response = await page.request.get("/api/me/outputs");
  expect(response.ok(), "Read owned publication metadata").toBe(true);
  const outputs: Output[] = await response.json();
  const output = outputs.find((item) => item.id === id);
  expect(!!output, "Exact synthetic publication exists").toBe(true);
  return output!;
}

async function accessPath(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/me/outputs/${id}/access`);
  expect(response.ok(), "Read current owned access").toBe(true);
  const access: { feedPath?: string } = await response.json();
  expect(typeof access.feedPath === "string", "Feed delivery is available").toBe(true);
  try {
    return new URL(access.feedPath!, "http://127.0.0.1:4173").pathname;
  } catch {
    throw new Error("Cannot parse synthetic subscription access.");
  }
}

// Playwright request instrumentation may record a failing URL even with traces
// disabled. Keep bearer delivery reads outside it and return only the status.
async function feedStatus(path: string): Promise<number> {
  try {
    const origin = "http://127.0.0.1:8080";
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/feed/"))
      throw new Error();
    const response = await globalThis.fetch(url, { redirect: "manual" });
    await response.arrayBuffer();
    return response.status;
  } catch {
    // Never retain a transport/body error or its URL as a cause.
    throw new Error("Cannot retrieve synthetic subscription delivery.");
  }
}

for (const operation of ["rotate", "revoke"] as const) {
  test(`stale ${operation} confirmation cannot invalidate a newer subscription link`, async ({ page }) => {
    await openWorkspace(page);
    const sessionResponse = await page.request.get("/api/auth/me");
    expect(sessionResponse.ok(), "Read authenticated synthetic session").toBe(true);
    const session: { csrfToken: string } = await sessionResponse.json();
    const headers = { "X-CSRF-Token": session.csrfToken };
    const suffix = `${operation}-${Date.now().toString(36)}`;
    const profileID = `access-conflict-profile-${suffix}`;
    const outputID = `access-conflict-output-${suffix}`;
    const name = `Sample phone ${suffix}`;
    let profileCreated = false;
    let outputCreated = false;
    let primaryFailure = false;
    try {
      const saved = await page.request.post("/api/me/profiles", {
        headers,
        data: {
          id: profileID,
          name: `Sample routing ${suffix}`,
          sourceIds: [],
          target: { adapterId: "mihomo", version: "1.19.32" },
          mode: "full",
          ir: {
            schemaVersion: "1.0",
            id: profileID,
            name: `Sample routing ${suffix}`,
            ownerId: "",
            revision: "1",
            endpoints: [],
            groups: [],
            rules: [],
            resources: [],
            defaultAction: { kind: "direct" },
            runtime: { mixedPort: 7890 },
          },
        },
      });
      expect(saved.ok(), "Create synthetic routing configuration").toBe(true);
      profileCreated = true;
      const created = await page.request.post("/api/me/outputs", {
        headers,
        data: {
          id: outputID,
          name,
          profileId: profileID,
          target: { adapterId: "mihomo", version: "1.19.32" },
          mode: "full",
        },
      });
      expect(created.ok(), "Publish synthetic subscription").toBe(true);
      outputCreated = true;
      const opened = await metadata(page, outputID);
      expect(!!opened.accessRevision, "Publication has an access revision").toBe(true);
      await page.reload();
      await waitForConfirmedWorkspace(page);
      // Enter subscription management explicitly from the default overview.
      // Confirmation ownership remains scoped to the selected subscription.
      await navigateWorkspace(page, "我的订阅");
      expect(new URL(page.url()).hash, "Subscription management has an explicit route").toBe("#subscriptions");
      const openDecision = async () => {
        await page.getByRole("button", { name: `管理 ${name}`, exact: true }).click();
        await page.getByRole("menuitem", {
          name: operation === "rotate" ? "更换订阅链接" : "撤销订阅",
          exact: true,
        }).click();
        const decision = page.getByRole("alertdialog", {
          name: operation === "rotate" ? `更换「${name}」的订阅链接？` : `撤销「${name}」？`,
          exact: true,
        });
        await expect(decision).toBeVisible();
        return decision;
      };
      const decision = await openDecision();

      // A separate authenticated API client changes access while the old
      // decision remains open. No routing mock replaces the real backend.
      const changed = await page.request.post(`/api/me/outputs/${outputID}/${operation}`, {
        headers: { ...headers, "If-Match": opened.accessRevision! },
        data: {},
      });
      expect(changed.ok(), "Independent matched access action succeeds").toBe(true);
      if (operation === "revoke") {
        const revoked = await metadata(page, outputID);
        expect(revoked.status === "revoked" && !!revoked.accessRevision &&
          revoked.accessRevision !== opened.accessRevision,
          "Independent revocation changes the access revision").toBe(true);
        const republished = await page.request.post(`/api/me/outputs/${outputID}/publish`, {
          headers,
          data: {},
        });
        expect(republished.ok(), "Independently republish the revoked subscription").toBe(true);
        const restored = await metadata(page, outputID);
        expect(restored.status === "published" && !!restored.accessRevision &&
          restored.accessRevision !== revoked.accessRevision,
          "Republishing creates another access revision").toBe(true);
      }
      const newer = await metadata(page, outputID);
      expect(!!newer.accessRevision && newer.accessRevision !== opened.accessRevision,
        "Independent action creates a new access revision").toBe(true);
      const newerPath = await accessPath(page, outputID);
      const newerFeed = await feedStatus(newerPath);
      expect(newerFeed, "Newer link retrieves before stale confirmation").toBe(200);
      const actionPath = `/api/me/outputs/${outputID}/${operation}`;
      const [stale, refreshed] = await Promise.all([
        page.waitForResponse((response) =>
          new URL(response.url()).pathname === actionPath && response.request().method() === "POST"),
        page.waitForResponse((response) =>
          new URL(response.url()).pathname === "/api/me/outputs" && response.request().method() === "GET"),
        decision.getByRole("button", {
          name: operation === "rotate" ? "更换链接" : "撤销订阅", exact: true,
        }).click(),
      ]);
      expect(stale.request().headers()["if-match"] === opened.accessRevision,
        "UI sends the revision captured by the old confirmation").toBe(true);
      expect(stale.status()).toBe(409);
      const conflict: { code?: string } = await stale.json();
      expect(conflict.code === "OUTPUT_ACCESS_CHANGED", "Stale operation is explicitly rejected").toBe(true);
      await refreshed.finished();
      await expect(decision).not.toBeVisible();
      await expect(page.getByText(/订阅访问方式已变化/)).toBeVisible();
      await expect(page.getByText(/链接更换结果尚未确认/)).toHaveCount(0);
      const preserved = await feedStatus(newerPath);
      expect(preserved, "Stale confirmation does not invalidate the newer link").toBe(200);
      const afterConflict = await metadata(page, outputID);
      expect(afterConflict.accessRevision === newer.accessRevision,
        "Rejected confirmation does not change access metadata").toBe(true);

      // Recovery requires a new explicit decision, which sends the fresh
      // revision. A known conflict must not leave the unknown-rotation guard.
      // A network response alone does not prove React applied the query. Open
      // the current subscription and wait for its rendered status result before
      // making the new decision. This keeps the same account/query lifetime,
      // so an incorrectly retained uncertainty guard would still block rotation.
      await page.getByRole("button", { name: `查看订阅 ${name}`, exact: true }).click();
      const detail = page.getByRole("dialog", { name: `${name} 的订阅详情`, exact: true });
      await expect(detail.getByText("与已保存草稿一致", { exact: true })).toBeVisible();
      await detail.getByRole("button", { name: "更多操作", exact: true }).click();
      await page.getByRole("menuitem", {
        name: operation === "rotate" ? "更换订阅链接" : "撤销订阅", exact: true,
      }).click();
      const freshDecision = page.getByRole("alertdialog", {
        name: operation === "rotate" ? `更换「${name}」的订阅链接？` : `撤销「${name}」？`,
        exact: true,
      });
      await expect(freshDecision).toBeVisible();
      const [fresh] = await Promise.all([
        page.waitForResponse((response) =>
          new URL(response.url()).pathname === actionPath && response.request().method() === "POST"),
        freshDecision.getByRole("button", {
          name: operation === "rotate" ? "更换链接" : "撤销订阅", exact: true,
        }).click(),
      ]);
      expect(fresh.request().headers()["if-match"] === newer.accessRevision,
        "New explicit confirmation uses current access metadata").toBe(true);
      expect(fresh.ok(), "Deliberately reopened action succeeds").toBe(true);
      await expect(freshDecision).not.toBeVisible();
      const invalidated = await feedStatus(newerPath);
      expect(invalidated, "Only the new explicit decision invalidates that link").toBe(404);
    } catch (error) {
      primaryFailure = true;
      throw error;
    } finally {
      // A timed-out test may already have lost its context. Preserve its real
      // failing step rather than replacing it with a teardown navigation error.
      if (!page.isClosed()) {
        try {
          await page.goto("about:blank");
          if (outputCreated) {
            const revoked = await page.request.post(`/api/me/outputs/${outputID}/revoke`, { headers, data: {} });
            expect(revoked.ok(), "Revoke owned synthetic publication during cleanup").toBe(true);
          }
          if (profileCreated) {
            const removed = await page.request.delete(`/api/me/profiles/${profileID}`, { headers });
            expect(removed.ok(), "Remove owned synthetic routing configuration").toBe(true);
          }
        } catch {
          if (!primaryFailure) throw new Error("Synthetic publication cleanup failed.");
        }
      }
    }
  });
}
