import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { settledTask } from "./ui-settled-task";

// Agreed seam: built App user task + intercepted HTTP. No real invitation,
// account mutation, redemption, idempotency or backend authorization proof.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  serviceWorkers: "block",
});

async function activate(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let step = 0; step < 80; step++) {
    // Do not Tab away from the action if restoration already focused it.
    if (await target.evaluate((node) => node === document.activeElement)) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Invitation action was not keyboard reachable");
}

for (const width of [390, 1440]) {
  for (const outcome of ["empty receipt", "lost response"] as const) {
    test(`Invitation ${outcome} requires a new decision at ${width}px`, async ({
      page,
      context,
      baseURL,
    }, info) => {
      if (
        !baseURL ||
        !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
      )
        throw new Error("Synthetic invitation coverage requires loopback");
      const origin = new URL(baseURL).origin;
      const fixtures: Record<string, unknown> = {
        "/api/auth/me": {
          user: {
            id: "synthetic-admin",
            name: "Synthetic admin",
            role: "admin",
            mfaEnabled: false,
          },
          csrfToken: "synthetic-csrf",
        },
        "/api/auth/sessions": [],
        "/api/admin/accounts": [],
        // AdminPage mounts the user-group list alongside the invitation task.
        "/api/user-groups": [],
        "/api/me/sources": [],
        "/api/me/notifications": [],
        "/api/settings": {},
        "/api/admin/subscription-origin": {
          revision: 0,
          configuredRevision: 0,
          draftOrigin: "",
          effectiveRevision: 0,
          effectiveOrigin: "",
          defaultOrigin: "https://synthetic.example.invalid",
          verificationStatus: "not-required",
          currentLinkExample:
            "https://synthetic.example.invalid/feed/{existing-token}",
          proposedLinkExample:
            "https://synthetic.example.invalid/feed/{existing-token}",
          tokensUnchanged: true,
        },
        "/api/services": [],
        "/api/published-routes": [],
        "/api/state": {
          users: [],
          nodes: [],
          routes: [],
          revisions: [],
          capabilities: [],
        },
      };
      const writes: string[] = [],
        unexpected: string[] = [],
        payloadMatches: boolean[] = [];
      const captures: Array<{ name: string; body: Buffer }> = [];
      const geometry: Array<Record<string, unknown>> = [];
      let failed = false,
        phase = "initial",
        pageErrors = 0;
      // Synthetic receipt material is never attached, logged or sent to a server.
      const token = "synthetic-invitation-bearer-for-local-display";
      const secretMask = page.getByLabel("邀请链接", { exact: true });
      page.on("pageerror", () => {
        pageErrors++;
      });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          method = request.method();
        if (url.origin !== origin || url.search || url.hash) {
          unexpected.push("external or metadata-bearing request rejected");
          return route.abort();
        }
        if (method !== "GET")
          writes.push(
            method === "POST" && url.pathname === "/api/invites"
              ? "POST /api/invites"
              : "unexpected write",
          );
        if (
          method === "POST" &&
          url.pathname === "/api/invites" &&
          writes.length <= 2
        ) {
          let matches = false;
          try {
            const body: unknown = request.postDataJSON();
            const expectedName =
              writes.length === 1 ? "Synthetic Alice" : "Synthetic Bob";
            matches = Boolean(
              body &&
              typeof body === "object" &&
              !Array.isArray(body) &&
              Object.keys(body).sort().join(",") ===
                "expiresInHours,name,role" &&
              (body as Record<string, unknown>).name === expectedName &&
              (body as Record<string, unknown>).role === "admin" &&
              (body as Record<string, unknown>).expiresInHours === 48,
            );
          } catch {
            /* Only retain a safe boolean, never the body. */
          }
          payloadMatches.push(matches);
          if (!matches) {
            unexpected.push("invitation payload mismatch");
            return route.abort();
          }
          if (writes.length === 1)
            return outcome === "empty receipt"
              ? route.fulfill({ status: 201, json: null })
              : route.abort("failed");
          return route.fulfill({
            status: 201,
            json: {
              id: "synthetic-invitation-id",
              token,
              name: "Synthetic Bob",
              role: "admin",
              expiresAt: "2027-01-01T00:00:00Z",
            },
          });
        }
        if (method === "GET" && Object.hasOwn(fixtures, url.pathname))
          return route.fulfill({ json: fixtures[url.pathname] });
        if (
          method === "GET" &&
          (url.pathname === "/" ||
            url.pathname === "/favicon.ico" ||
            /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?)$/.test(url.pathname))
        )
          return route.continue();
        // Retain only fixed categories: unknown paths can themselves contain
        // credentials, so do not serialize their URL or arbitrary path segments.
        const category = url.pathname.startsWith("/api/")
          ? "API"
          : url.pathname.startsWith("/assets/")
            ? "asset"
            : "other";
        unexpected.push(
          `unlisted ${method === "GET" ? "read" : "write"} ${category} request rejected`,
        );
        return route.abort();
      });
      const capture = async (surface: Locator, label: string) => {
        phase = label;
        await settledTask(surface);
        // Capture original viewport before any diagnostic geometry work. No
        // scrollIntoView, locator screenshot or programmatic focus to hide defects.
        captures.push({
          name: `invitation-${label}-${width}`,
          body: await page.screenshot({ mask: [secretMask] }),
        });
        const dimensions = await surface.evaluate((node) => {
          const r = node.getBoundingClientRect(),
            w = document.documentElement.clientWidth;
          const actions = Array.from(node.querySelectorAll("button")).filter(
            (el) => el.getClientRects().length,
          );
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            surfaceFits:
              r.left >= 0 &&
              r.right <= w + 1 &&
              node.scrollWidth <= node.clientWidth + 1,
            documentFits: document.documentElement.scrollWidth <= w + 1,
            actionsFit: actions.every((el) => {
              const b = el.getBoundingClientRect();
              return (
                b.left >= r.left &&
                b.right <= r.right + 1 &&
                el.scrollWidth <= el.clientWidth + 1
              );
            }),
            activeElementVisible: (() => {
              const b = document.activeElement?.getBoundingClientRect();
              return (
                !!b &&
                b.top >= 0 &&
                b.bottom <= innerHeight &&
                b.left >= 0 &&
                b.right <= w
              );
            })(),
          };
        });
        geometry.push({ phase: label, ...dimensions });
        expect(dimensions.surfaceFits).toBe(true);
        expect(dimensions.documentFits).toBe(true);
        expect(dimensions.actionsFit).toBe(true);
      };
      const dialog = page.getByRole("dialog", {
        name: "邀请用户",
        exact: true,
      });
      const open = async () => {
        await page
          .getByRole("button", { name: "邀请用户", exact: true })
          .first()
          .click();
        // Wait for the actual editable task, not the lazy-loading dialog shell.
        await expect(
          dialog.getByLabel("受邀人名称", { exact: true }),
        ).toBeEditable();
        await settledTask(dialog);
      };
      const fill = async (name: string) => {
        await dialog.getByLabel("受邀人名称", { exact: true }).fill(name);
        await dialog
          .getByRole("combobox", { name: "角色", exact: true })
          .click();
        await page.getByRole("option", { name: "管理员", exact: true }).click();
        await dialog.getByLabel("有效时长（小时）", { exact: true }).fill("48");
      };
      const assertFrozen = async () => {
        await expect(
          dialog.getByLabel("受邀人名称", { exact: true }),
        ).toHaveValue("Synthetic Alice");
        await expect(
          dialog.getByLabel("受邀人名称", { exact: true }),
        ).toBeDisabled();
        await expect(
          dialog.getByRole("combobox", { name: "角色", exact: true }),
        ).toContainText("管理员");
        await expect(
          dialog.getByRole("combobox", { name: "角色", exact: true }),
        ).toBeDisabled();
        await expect(
          dialog.getByLabel("有效时长（小时）", { exact: true }),
        ).toHaveValue("48");
        await expect(
          dialog.getByLabel("有效时长（小时）", { exact: true }),
        ).toBeDisabled();
        await expect(
          dialog.getByText("邀请已创建", { exact: true }),
        ).toHaveCount(0);
        await expect(secretMask).toHaveCount(0);
        expect(writes).toEqual(["POST /api/invites"]);
      };
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/#users");
        await open();
        await fill("Synthetic Alice");
        await activate(
          page,
          dialog.getByRole("button", { name: "生成邀请", exact: true }),
        );
        await expect(
          dialog.getByText("邀请创建结果尚未确认", { exact: true }),
        ).toBeVisible();
        await assertFrozen();
        await capture(dialog, "unknown");
        await activate(
          page,
          dialog.getByRole("button", { name: "取消", exact: true }),
        );
        let decision = page.getByRole("alertdialog");
        await expect(decision).toContainText("离开不会撤销邀请");
        await expect(decision).not.toContainText("尚未提交");
        await capture(decision, "departure-review");
        await activate(
          page,
          decision.getByRole("button", { name: "保留当前结果", exact: true }),
        );
        await expect(decision).toHaveCount(0);
        await assertFrozen();
        if (outcome === "lost response") {
          await activate(
            page,
            dialog.getByRole("button", { name: "取消", exact: true }),
          );
          decision = page.getByRole("alertdialog");
          await activate(
            page,
            decision.getByRole("button", { name: "离开邀请", exact: true }),
          );
          await expect(dialog).toHaveCount(0);
          expect(writes).toEqual(["POST /api/invites"]);
          await open();
          await expect(
            dialog.getByLabel("受邀人名称", { exact: true }),
          ).toHaveValue("");
        } else {
          await activate(
            page,
            dialog.getByRole("button", { name: "准备另一份邀请", exact: true }),
          );
          decision = page.getByRole("alertdialog");
          await expect(decision).toContainText("不会撤销上一次邀请");
          await capture(decision, "new-intent-review");
          await activate(
            page,
            decision.getByRole("button", { name: "保留当前结果", exact: true }),
          );
          await expect(decision).toHaveCount(0);
          await assertFrozen();
          await activate(
            page,
            dialog.getByRole("button", { name: "准备另一份邀请", exact: true }),
          );
          decision = page.getByRole("alertdialog");
          await activate(
            page,
            decision.getByRole("button", {
              name: "准备另一份邀请",
              exact: true,
            }),
          );
          await expect(decision).toHaveCount(0);
          await expect(
            dialog.getByLabel("受邀人名称", { exact: true }),
          ).toBeEditable();
          await expect(
            dialog.getByLabel("受邀人名称", { exact: true }),
          ).toHaveValue("Synthetic Alice");
        }
        expect(writes).toEqual(["POST /api/invites"]);
        await fill("Synthetic Bob");
        await capture(dialog, "new-draft");
        await activate(
          page,
          dialog.getByRole("button", { name: "生成邀请", exact: true }),
        );
        await expect(
          dialog.getByText("邀请已创建", { exact: true }),
        ).toBeVisible();
        await expect(
          dialog.getByText("Synthetic Bob", { exact: true }),
        ).toBeVisible();
        await expect(dialog.getByText("管理员", { exact: true })).toBeVisible();
        // Boolean assertion avoids leaking the bearer in Playwright diagnostics.
        expect(
          (await secretMask.inputValue()) === `${origin}/?invite=${token}`,
        ).toBe(true);
        await expect(secretMask).toHaveAttribute("readonly", "");
        await capture(dialog, "success");
        await activate(
          page,
          dialog.getByRole("button", { name: "关闭", exact: true }),
        );
        await expect(dialog).toHaveCount(0);
        await open();
        await expect(
          dialog.getByLabel("受邀人名称", { exact: true }),
        ).toHaveValue("");
        await expect(secretMask).toHaveCount(0);
        expect(writes).toEqual(["POST /api/invites", "POST /api/invites"]);
        expect(payloadMatches).toEqual([true, true]);
        expect(unexpected).toEqual([]);
        expect(pageErrors).toBe(0);
        phase = "completed";
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          try {
            if (failed && !page.isClosed())
              captures.push({
                name: `invitation-failure-${phase}-${width}`,
                body: await page.screenshot({ mask: [secretMask] }),
              });
          } finally {
            try {
              for (const item of captures)
                await info.attach(item.name, {
                  contentType: "image/png",
                  body: item.body,
                });
            } finally {
              await info.attach("invitation-recovery-scope", {
                contentType: "application/json",
                body: JSON.stringify({
                  width,
                  outcome,
                  phase,
                  failed,
                  writes,
                  payloadMatches,
                  unexpected,
                  pageErrors,
                  geometry,
                  scope:
                    "Built App with intercepted synthetic HTTP only; no backend invitation mutation or redemption; pixels require review",
                }),
              });
            }
          }
        } catch (diagnosticError) {
          // Preserve the original assertion failure, even if evidence capture fails.
          if (!failed) throw diagnosticError;
        } finally {
          // Preserve masked evidence first, then remove the page before Playwright's
          // automatic failure accessibility snapshot can serialize the bearer input.
          try {
            if (!page.isClosed()) await page.close();
          } catch (cleanupError) {
            if (!failed) throw cleanupError;
          }
        }
      }
    });
  }
}
