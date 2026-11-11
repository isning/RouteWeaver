import type { Locator, Page, Route, TestInfo } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { settledTask } from "./ui-settled-task";

// Built App, intercepted synthetic HTTP only. No settings/domain write reaches
// the backend. Discovery/typechecking is not native execution or pixel review.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
});
const submitted = "合成提交的平台名称";
const newer = "核对期间继续编辑的平台名称";
const domainDraft = "https://independent-draft.example";
const settings = (name: string) => ({
  name,
  timezone: "UTC+8",
  registration: "invite",
});
type Outcome = "malformed" | "lost" | "server-error";

async function fixture(
  page: Page,
  baseURL: string | undefined,
  outcome: Outcome,
) {
  if (
    !baseURL ||
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Synthetic settings recovery requires loopback");
  const origin = new URL(baseURL).origin;
  let phase = "initial";
  const ledger = {
    readEvents: [] as { phase: string; path: string }[],
    writes: 0,
    settingsReads: 0,
    rejected: [] as string[],
    pageErrors: 0,
  };
  page.on("pageerror", () => ledger.pageErrors++);
  const reads: Record<string, unknown> = {
    "/api/auth/me": {
      user: { id: "synthetic-admin", name: "合成管理员", role: "admin" },
      csrfToken: "synthetic-settings",
    },
    "/api/state": {
      nodes: [],
      users: [],
      routes: [],
      revisions: [],
      capabilities: [],
      deploymentAvailable: false,
    },
    "/api/services": [],
    "/api/published-routes": [],
    "/api/admin/subscription-origin": {
      revision: 1,
      configuredRevision: 1,
      draftOrigin: "",
      effectiveRevision: 1,
      effectiveOrigin: "",
      defaultOrigin: "",
      currentLinkExample: "/feed/{existing-token}",
      proposedLinkExample: "/feed/{existing-token}",
      verificationStatus: "not-required",
      tokensUnchanged: true,
    },
  };
  let readMode: "initial" | "invalid" | "held" | "current" = "initial";
  let pending: Route | undefined;
  await page.context().route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const reject = () => {
      // Never dump bodies, query values, headers, external URLs or credentials.
      ledger.rejected.push(
        `${request.method()} ${url.origin === origin ? url.pathname : "external-origin"}${url.search ? "?redacted" : ""}${url.hash ? "#redacted" : ""}`,
      );
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin || url.search || url.hash) return reject();
    if (!url.pathname.startsWith("/api/")) {
      if (
        request.method() === "GET" &&
        (url.pathname === "/" ||
          /^\/assets\/[^/]+\.(?:js|css|woff2)$/.test(url.pathname))
      )
        return route.continue();
      return reject();
    }
    if (request.method() === "GET" && url.pathname === "/api/settings") {
      ledger.settingsReads++;
      ledger.readEvents.push({ phase, path: url.pathname });
      if (readMode === "held") {
        pending = route;
        return;
      }
      return route.fulfill({
        json:
          readMode === "invalid"
            ? {}
            : settings(readMode === "initial" ? "RouteWeaver" : submitted),
      });
    }
    if (request.method() === "GET" && Object.hasOwn(reads, url.pathname)) {
      ledger.readEvents.push({ phase, path: url.pathname });
      return route.fulfill({ json: reads[url.pathname] });
    }
    if (request.method() === "PUT" && url.pathname === "/api/settings") {
      let body: unknown;
      try {
        body = request.postDataJSON();
      } catch {
        return reject();
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        JSON.stringify(Object.keys(body).sort()) !==
          JSON.stringify(["name", "registration", "timezone"]) ||
        Object.entries(settings(submitted)).some(
          ([key, value]) => (body as Record<string, unknown>)[key] !== value,
        ) ||
        ledger.writes !== 0
      )
        return reject();
      ledger.writes++;
      if (outcome === "lost") return route.abort("failed");
      if (outcome === "server-error")
        return route.fulfill({
          status: 503,
          json: { message: "合成服务暂时不可用" },
        });
      return route.fulfill({ json: { name: submitted, timezone: "UTC+8" } });
    }
    return reject();
  });
  return {
    ledger,
    phase(value: string) {
      phase = value;
    },
    mode(value: typeof readMode) {
      readMode = value;
    },
    async release() {
      if (!pending) throw new Error("No synthetic reconciliation pending");
      const route = pending;
      pending = undefined;
      await route.fulfill({ json: settings(submitted) });
    },
  };
}

async function tabTo(
  page: Page,
  target: Locator,
  direction?: "Tab" | "Shift+Tab",
  observe?: () => Promise<void>,
) {
  await expect(target).toBeVisible();
  // Follow document order in the appropriate direction. In particular, the
  // domain draft is below the name form: forward-only traversal would wrap
  // through browser chrome and can trigger unrelated window-focus reads.
  const key =
    direction ??
    (await target.evaluate((node) => {
      const active = document.activeElement;
      return active &&
        active !== document.body &&
        active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING
        ? "Shift+Tab"
        : "Tab";
    }));
  for (let index = 0; index < 80; index++) {
    await observe?.();
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}
async function activate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}

// Preserve the original viewport and safe geometry even when readiness or a
// subsequent visibility/focus assertion fails. Never programmatically scroll,
// focus, dismiss a toast, edit the DOM, or print form values to stage evidence.
async function evidence(
  page: Page,
  info: TestInfo,
  stage: string,
  surface: Locator,
  controls: Locator[],
) {
  let failure: unknown;
  try {
    await settledTask(surface);
  } catch (error) {
    failure = error;
  }
  const geometry = [];
  for (const control of controls) {
    const count = await control.count();
    geometry.push({
      target: control.toString(),
      count,
      box:
        count === 1
          ? await control.evaluate((node) => {
              const r = node.getBoundingClientRect();
              const hit = document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              );
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                focused: node === document.activeElement,
                inViewport:
                  r.x >= 0 &&
                  r.y >= 0 &&
                  r.right <= innerWidth &&
                  r.bottom <= innerHeight,
                hit: hit === node || node.contains(hit),
              };
            })
          : null,
    });
  }
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  await info.attach(`${stage}-pixels`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });
  await info.attach(`${stage}-geometry`, {
    body: JSON.stringify(
      { viewport, geometry, settlingFailed: !!failure },
      null,
      2,
    ),
    contentType: "application/json",
  });
  if (failure) throw failure;
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
}

for (const width of [390, 1440]) {
  for (const outcome of ["malformed", "lost", "server-error"] as const) {
    test(`settings ${outcome} receipt preserves drafts and reconciles explicitly at ${width}px`, async ({
      page,
      baseURL,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const http = await fixture(page, baseURL, outcome);
      const form = page.getByRole("form", {
        name: "平台基本设置",
        exact: true,
      });
      const name = form.getByRole("textbox", { name: "平台名称", exact: true });
      const domain = page.getByRole("textbox", {
        name: "订阅域名草稿",
        exact: true,
      });
      const save = form.getByRole("button", { name: "保存设置", exact: true });
      const cancel = form.getByRole("button", {
        name: "取消名称修改",
        exact: true,
      });
      const check = form.getByRole("button", {
        name: "核对当前设置",
        exact: true,
      });
      const focusSamples: unknown[] = [];
      const sampleFocus = async (phase: string) => {
        http.phase(phase);
        focusSamples.push({
          phase,
          settingsReads: http.ledger.settingsReads,
          reads: http.ledger.readEvents.length,
          ...(await name.evaluate((node) => ({
            activeTag: document.activeElement?.tagName ?? null,
            nameFocused: document.activeElement === node,
            documentFocused: document.hasFocus(),
            visibility: document.visibilityState,
            workspaceBusy: document
              .querySelector("[data-session-workspace]")
              ?.getAttribute("aria-busy"),
          }))),
        });
      };
      const failures: unknown[] = [];
      try {
        await page.goto("/#settings");
        await activate(
          page,
          form.getByRole("button", { name: "编辑平台名称", exact: true }),
        );
        await expect(name).toBeFocused();
        await name.fill(submitted);
        await domain.fill(domainDraft);
        await activate(page, save);
        await expect.poll(() => http.ledger.writes).toBe(1);
        await evidence(page, info, "unknown-receipt", form, [
          name,
          save,
          cancel,
          check,
        ]);
        await expect(form.getByRole("alert")).toContainText("保存结果尚未确认");
        await expect(name).toHaveValue(submitted);
        await expect(domain).toHaveValue(domainDraft);
        await expect(save).toBeDisabled();
        await expect(cancel).toBeDisabled();
        await expect(form.getByRole("status")).toHaveCount(0);
        const initialReads = http.ledger.settingsReads;
        // Save has just become disabled. BODY is not a reliable indication of
        // Chromium's sequential-focus starting point, so use the known local
        // reverse direction rather than guessing forward and wrapping chrome.
        await tabTo(page, name, "Shift+Tab", () =>
          sampleFocus("return-to-name"),
        );
        await sampleFocus("before-replay-enter");
        await page.keyboard.press("Enter");
        await sampleFocus("after-replay-enter");
        expect(http.ledger.writes).toBe(1);
        expect(http.ledger.settingsReads).toBe(initialReads);

        http.phase("departure-warning");
        if (width === 390)
          await activate(
            page,
            page.getByRole("button", { name: "打开导航", exact: true }),
          );
        const navigation = page.getByRole("navigation", {
          name: "工作空间导航",
          exact: true,
        });
        const materials = navigation.getByRole("button", {
          name: "订阅素材",
          exact: true,
        });
        if ((await materials.getAttribute("aria-expanded")) !== "true")
          await activate(page, materials);
        await activate(
          page,
          navigation.getByRole("button", { name: "规则资源", exact: true }),
        );
        const leave = page.getByRole("alertdialog");
        const stay = leave.getByRole("button", {
          name: "留在当前页面",
          exact: true,
        });
        await evidence(page, info, "departure-warning", leave, [stay]);
        await expect(leave).toContainText("保存可能已完成");
        await expect(leave).toContainText("离开不会撤销保存");
        // The name write is uncertain, while the independent domain input is
        // still an unsaved draft. Navigation must preserve both consequences.
        await expect(leave).toContainText(
          "当前编辑尚未保存。离开会放弃尚未保存的内容。",
        );
        await expect(stay).toBeInViewport({ ratio: 1 });
        await activate(page, stay);
        await expect(leave).toHaveCount(0);

        http.phase("explicit-invalid-read");
        http.mode("invalid");
        await tabTo(page, check);
        await evidence(page, info, "explicit-read-decision", form, [check]);
        await expect(check).toBeInViewport({ ratio: 1 });
        await expect(check).toBeFocused();
        expect(
          await check.evaluate((node) => {
            const r = node.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.x + r.width / 2,
              r.y + r.height / 2,
            );
            return hit === node || node.contains(hit);
          }),
          "Recovery has a clear native decision target",
        ).toBe(true);
        await page.keyboard.press("Enter");
        await expect
          .poll(() => http.ledger.settingsReads)
          .toBe(initialReads + 1);
        await evidence(page, info, "failed-reconciliation", form, [
          check,
          name,
        ]);
        await expect(form).toContainText(
          "无法核对当前平台设置。当前输入已保留，请重试核对。",
        );
        await expect(name).toHaveValue(submitted);
        await expect(domain).toHaveValue(domainDraft);
        await expect(save).toBeDisabled();
        await expect(cancel).toBeDisabled();

        http.phase("explicit-held-read");
        http.mode("held");
        // The previous pending check also disabled its focused button. Step to
        // the next name input, then back to the re-enabled check without a wrap.
        await tabTo(page, name, "Tab", () => sampleFocus("retry-next-name"));
        await tabTo(page, check, "Shift+Tab", () => sampleFocus("retry-check"));
        await page.keyboard.press("Enter");
        await expect
          .poll(() => http.ledger.settingsReads)
          .toBe(initialReads + 2);
        await expect(check).toBeDisabled();
        await expect(save).toBeDisabled();
        // Lost/5xx case keeps the submitted name; malformed case edits while the
        // explicit GET is pending, so that response cannot own the newer draft.
        if (outcome === "malformed") {
          await tabTo(page, name);
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.insertText(newer);
        }
        await http.release();
        await evidence(page, info, "current-settings-read", form, [
          outcome === "malformed"
            ? name
            : form.getByRole("button", { name: "编辑平台名称", exact: true }),
        ]);
        await expect(form.getByRole("status")).toHaveText(
          outcome === "malformed"
            ? "已核对当前平台设置，当前修改尚未保存"
            : "已核对当前平台设置",
        );
        await expect(
          page.getByText("平台设置已保存", { exact: true }),
        ).toHaveCount(0);
        await expect(domain).toHaveValue(domainDraft);
        if (outcome === "malformed") {
          await expect(name).toHaveValue(newer);
          await expect(save).toBeEnabled();
          await activate(page, cancel);
        } else {
          await expect(name).toBeHidden();
        }
        await expect(form.getByText(submitted, { exact: true })).toBeVisible();
        await expect(domain).toHaveValue(domainDraft);
        expect(http.ledger.writes).toBe(1);
        expect(http.ledger.rejected).toEqual([]);
        expect(http.ledger.pageErrors).toBe(0);
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          await evidence(page, info, "final-state", page.locator("body"), [
            name,
            domain,
            check,
          ]);
        } catch (error) {
          failures.push(error);
        } finally {
          // Request counts survive failed geometry/settling evidence. Preserve
          // the original task failure too, rather than replacing it at cleanup.
          try {
            await info.attach("synthetic-settings-request-counts", {
              body: JSON.stringify({ ...http.ledger, focusSamples }, null, 2),
              contentType: "application/json",
            });
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Settings recovery assertions and evidence failed",
        );
    });
  }
}
