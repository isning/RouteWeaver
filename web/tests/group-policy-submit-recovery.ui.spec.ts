import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { requireLoopback } from "./account-security-backend";
import { Inventory } from "./uiux-inventory-helper";

test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});

// Native Tab only, choosing direction by the actual current DOM order. Never
// wrap across the last dialog control into browser chrome to reach the footer.
async function tabTo(page: Page, dialog: Locator, target: Locator) {
  for (let step = 0; step < 30; step++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    const backwards = await target.evaluate(
      (el) =>
        !!(
          document.activeElement?.compareDocumentPosition(el)! &
          Node.DOCUMENT_POSITION_PRECEDING
        ),
    );
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await expect(target).toBeFocused();
}

for (const width of [1440, 390])
  test(`group invalid Preview preserves members and priority at ${width}px`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 560 });
    requireLoopback(baseURL);
    const origin = new URL(baseURL!).origin;
    const fixtures: Record<string, unknown> = {
      "/api/auth/me": {
        user: { id: "admin", name: "Admin", role: "admin" },
        csrfToken: "synthetic-group-csrf",
      },
      "/api/state": {
        nodes: [],
        users: [
          {
            id: "u1",
            name: "Alice",
            enabled: true,
            quotaBytes: 0,
            usedBytes: 0,
          },
        ],
        routes: [],
        revisions: [],
        capabilities: [],
      },
      "/api/settings": { name: "Policy fixture", registration: "invite" },
      "/api/services": [
        {
          id: "plan-a",
          name: "Team plan",
          quotaBytes: 0,
          routeIds: [],
          cycle: {
            mode: "none",
            anchor: "0001-01-01T00:00:00Z",
            timezone: "UTC+8",
          },
        },
      ],
      "/api/published-routes": [],
      "/api/user-groups": [],
      "/api/invites": [],
      "/api/rates": [],
    };
    const reads: string[] = [],
      blocked: string[] = [],
      evidenceErrors: string[] = [];
    await page.context().route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const refuse = () => {
        blocked.push(
          `${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}`,
        );
        return route.abort("blockedbyclient");
      };
      if (url.origin !== origin || request.method() !== "GET" || url.search)
        return refuse();
      if (/^\/api(?:\/|$)/.test(url.pathname)) {
        const match = url.pathname.match(
          /^\/api\/access-policy\/edit-context\/group\/([^/]+)$/,
        );
        if (match) {
          reads.push(url.pathname);
          return route.fulfill({
            json: {
              target: { kind: "group", id: decodeURIComponent(match[1]) },
              record: null,
              precondition: { exists: false, revision: "absent-group" },
            },
          });
        }
        if (!Object.hasOwn(fixtures, url.pathname)) return refuse();
        reads.push(url.pathname);
        return route.fulfill({ json: fixtures[url.pathname] });
      }
      if (!(
        url.pathname === "/" ||
        url.pathname.startsWith("/assets/") ||
        url.pathname === "/favicon.ico"
      ))
        return refuse();
      return route.continue();
    });
    const inventory = new Inventory(page, info, "admin", "users");
    let primary: unknown;
    const screenshot = async (stage: string) => {
      if (!process.env.CI) return;
      try {
        await info.attach(`group-${width}-${stage}.png`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      } catch {
        evidenceErrors.push(`Screenshot failed: ${stage}`);
      }
    };
    try {
      await page.goto("/#users");
      const opener = page.getByRole("button", {
        name: "新建用户组",
        exact: true,
      });
      await expect(opener).toBeVisible();
      for (let opening = 0; opening < 2; opening++) {
        await opener.click();
        const dialog = page.getByRole("dialog", {
          name: "新建用户组",
          exact: true,
        });
        await inventory.stable(dialog);
        const name = dialog.getByRole("textbox", {
          name: "用户组名称",
          exact: true,
        });
        const priority = dialog.getByRole("spinbutton", {
          name: "用户组优先级",
          exact: true,
        });
        const members = dialog.getByRole("combobox", {
          name: "组成员",
          exact: true,
        });
        const service = dialog.getByRole("combobox", {
          name: "组服务方案",
          exact: true,
        });
        const preview = dialog.getByRole("button", {
          name: "预览影响",
          exact: true,
        });
        await expect(name).toHaveValue("");
        await expect(priority).toHaveValue("0");
        await expect(members).not.toContainText("已选择 1 项");
        await priority.fill("42");
        await members.click();
        await page.getByRole("option", { name: "Alice", exact: true }).click();
        await page.keyboard.press("Escape");
        for (const field of [name, service]) {
          await tabTo(page, dialog, preview);
          expect(
            await preview.evaluate((el) =>
              (el as HTMLButtonElement).form?.checkValidity(),
            ),
          ).toBe(true);
          await page.keyboard.press("Enter");
          await expect(field).toBeFocused();
          await expect(field).toHaveAttribute("aria-invalid", "true");
          await inventory.stable(dialog);
          await expect(field).toBeFocused();
          await inventory.inView(field);
          const error = dialog
            .getByRole("alert")
            .filter({
              hasText: field === name ? "请输入用户组名称" : "请选择服务方案",
            });
          await inventory.inView(error);
          expect(
            (await field.getAttribute("aria-describedby"))?.split(/\s+/),
          ).toContain(await error.getAttribute("id"));
          await expect(priority).toHaveValue("42");
          await expect(members).toContainText("已选择 1 项");
          await expect(
            page.getByRole("dialog", { name: "确认授权变更", exact: true }),
          ).toHaveCount(0);
          await screenshot(`${opening}-${field === name ? "name" : "service"}`);
          if (field === name) await name.fill("Team");
        }
        await tabTo(
          page,
          dialog,
          dialog.getByRole("button", { name: "取消", exact: true }),
        );
        await page.keyboard.press("Enter");
        const discard = page.getByRole("alertdialog", {
          name: "放弃尚未保存的授权修改？",
          exact: true,
        });
        await inventory.stable(discard);
        await tabTo(
          page,
          discard,
          discard.getByRole("button", { name: "放弃修改", exact: true }),
        );
        await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
        await inventory.stable();
        await expect(opener).toBeFocused();
      }
      expect(reads).toContain("/api/auth/me");
      expect(
        reads.some((path) =>
          path.startsWith("/api/access-policy/edit-context/group/"),
        ),
      ).toBe(true);
      expect(blocked).toEqual([]);
      inventory.finish();
    } catch (error) {
      primary = error;
      await screenshot("failure");
    }
    // Diagnostic attachment failures never replace the original assertion or ledger.
    try {
      await info.attach("group-submit-ledger", {
        contentType: "application/json",
        body: JSON.stringify({
          viewport: page.viewportSize(),
          reads,
          blocked,
          evidenceErrors,
          scope:
            "Synthetic App reads; keyboard invalid Preview, retained members/priority, discard/reopen. No writes or backend acceptance.",
        }),
      });
    } catch {
      evidenceErrors.push("Ledger attachment failed");
    }
    if (primary) {
      console.error(JSON.stringify({ blocked, evidenceErrors }));
      throw primary;
    }
    expect(blocked).toEqual([]);
    expect(evidenceErrors).toEqual([]);
  });
