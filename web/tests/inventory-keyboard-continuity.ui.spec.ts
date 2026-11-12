import { writeFile } from "node:fs/promises";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";
import { settledTask } from "./ui-settled-task";
import { navigateWorkspace } from "./ui-session";

// Two representative real-App journeys, not a four-inventory/theme matrix.
// Native execution is required; DOM tests and discovery cannot accept pixels.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});
type Theme = "light" | "dark";
type Observer = {
  __inventoryRefreshes: { time: number; trusted: boolean; keyboard: boolean }[];
};
type Gate = {
  ready: (error?: Error) => void;
  release: Promise<void>;
  request?: Request;
  activationStart: number | null;
  requestStart: number | null;
};

async function fixture(page: Page, baseURL: string | undefined) {
  if (
    !baseURL ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Inventory keyboard sampler requires loopback");
  const origin = new URL(baseURL).origin;
  const services = Array.from({ length: 25 }, (_, index) => ({
    id: `synthetic-plan-${index}`,
    name: `Plan ${String(index).padStart(2, "0")}`,
    quotaBytes: 0,
    routeIds: [],
    onlineIpLimit: 0,
    connectionLimit: 0,
    entryRateBps: 0,
    cycle: { mode: "none", timezone: "UTC+8", anchor: "2026-01-01T00:00:00Z" },
  }));
  const users = services.map((service) => ({
    id: service.id,
    name: service.name,
    enabled: true,
    quotaBytes: 0,
    usedBytes: 0,
  }));
  const reads: Record<string, unknown> = {
    "/api/auth/me": {
      user: { id: "synthetic-admin", name: "Synthetic admin", role: "admin" },
      csrfToken: "synthetic-inventory-only",
    },
    "/api/state": {
      users,
      nodes: [],
      routes: [],
      revisions: [],
      capabilities: [],
    },
    "/api/published-routes": [],
    "/api/user-groups": [],
    "/api/rates": [],
    "/api/me/notifications": [],
    "/api/access-policy/edit-context/service/synthetic-plan-10": {
      target: { kind: "service", id: services[10].id },
      record: { service: services[10] },
      precondition: { exists: true, revision: "synthetic-opening" },
    },
  };
  // Numeric/boolean/category-only ledger: no URLs, IDs, bodies, headers, storage,
  // credential-like strings, transport errors or arbitrary DOM text are saved.
  const ledger = {
    serviceReads: 0,
    serviceReadsInFlight: 0,
    authReads: 0,
    editReads: 0,
    openingReads: [0, 0],
    openingsReady: [false, false],
    rejectedOpeningReads: 0,
    heldReads: 0,
    deliveredHeldReads: 0,
    rejectedGates: 0,
    rejectedRequests: 0,
    rejectedWrites: 0,
    pageErrors: 0,
    activationStart: null as number | null,
    requestStart: null as number | null,
    refreshActivations: 0,
    trustedKeyboardActivation: false,
    sameIdentityOutsideFilter: false,
    queryPreserved: false,
    pagePreserved: false,
    openingValuePreserved: false,
    newerFocusPreserved: false,
    connectedOpenerReturned: false,
    missingOpenerSearchReturned: false,
  };
  let held: Gate | undefined,
    refreshClaimed = false,
    renamed = false;
  const releases: (() => void)[] = [];
  let opening: 0 | 1 | 2 = 0,
    openingsArmed = 0;
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    const reject = () => {
      ledger.rejectedRequests++;
      if (method !== "GET") ledger.rejectedWrites++;
      return route.abort("blockedbyclient");
    };
    if (url.origin !== origin || url.username || url.password || url.hash)
      return reject();
    if (!url.pathname.startsWith("/api/")) {
      const staticPath =
        ["/", "/favicon.ico", "/@vite/client", "/@react-refresh"].includes(
          url.pathname,
        ) ||
        /^\/(?:src|node_modules|assets)\/[^?#]+\.(?:[cm]?[jt]sx?|css|woff2?|ttf|svg)$/.test(
          url.pathname,
        );
      const staticQuery = [...url.searchParams].every(
        ([key, value]) =>
          (key === "v" && /^[a-zA-Z0-9_-]+$/.test(value)) ||
          (key === "t" && /^\d+$/.test(value)) ||
          (key === "import" && value === ""),
      );
      return method === "GET" && staticPath && staticQuery
        ? route.continue()
        : reject();
    }
    if (method !== "GET" || url.search) return reject();
    if (url.pathname === "/api/services") {
      ledger.serviceReads++;
      ledger.serviceReadsInFlight++;
      const gate = held;
      held = undefined; // Only this exact Request may claim the armed gate.
      // Claim before any awaited DOM observation: a concurrent service GET
      // must already be rejected while activation evidence is being read.
      if (gate) refreshClaimed = true;
      try {
        if (gate) {
          gate.request = request;
          const activations = await page.evaluate(
            () => (window as unknown as Observer).__inventoryRefreshes,
          );
          ledger.refreshActivations = activations.length;
          ledger.trustedKeyboardActivation =
            activations.length === 1 &&
            activations[0].trusted &&
            activations[0].keyboard;
          gate.activationStart = ledger.activationStart =
            activations[0]?.time ?? null;
          if (
            !ledger.trustedKeyboardActivation ||
            gate.activationStart === null
          ) {
            ledger.rejectedGates++;
            gate.ready(
              new Error(
                "Held service read did not follow the one intended keyboard Refresh",
              ),
            );
            return await reject();
          }
          ledger.heldReads++;
          gate.ready();
          await gate.release;
          renamed = true;
          const refreshed = services.map((service) =>
            service.id === services[10].id
              ? { ...service, name: "Renamed offering" }
              : service,
          );
          ledger.sameIdentityOutsideFilter =
            refreshed[10].id === services[10].id &&
            !refreshed[10].name.includes("Plan");
          await route.fulfill({ json: refreshed });
          ledger.deliveredHeldReads++;
          return;
        }
        // An unexpected background refresh must not silently get the old record.
        if (renamed || refreshClaimed) return await reject();
        return await route.fulfill({ json: services });
      } finally {
        ledger.serviceReadsInFlight--;
      }
    }
    if (!Object.hasOwn(reads, url.pathname)) return reject();
    if (url.pathname === "/api/auth/me") ledger.authReads++;
    if (
      url.pathname ===
      "/api/access-policy/edit-context/service/synthetic-plan-10"
    ) {
      // The only allowed context belongs to the two explicit Plan 10 openings.
      // One effect plus at most its one StrictMode replay, never retries or
      // reads after the editor has become ready. Wrong targets were rejected above.
      if (!opening || ledger.openingReads[opening - 1] >= 2) {
        ledger.rejectedOpeningReads++;
        return reject();
      }
      ledger.openingReads[opening - 1]++;
      ledger.editReads++;
    }
    return route.fulfill({ json: reads[url.pathname] });
  });
  return {
    ledger,
    beginOpening: () => {
      if (opening || openingsArmed >= 2)
        throw new Error("Unexpected editor opening epoch");
      opening = ++openingsArmed as 1 | 2;
    },
    openingReady: () => {
      if (
        !opening ||
        ledger.openingReads[opening - 1] < 1 ||
        ledger.openingReads[opening - 1] > 2
      )
        throw new Error("Editor readiness lacks its bounded owned read");
      ledger.openingsReady[opening - 1] = true;
      opening = 0;
      return ledger.editReads;
    },
    releaseAll: () => releases.forEach((release) => release()),
    holdRefresh: () => {
      if (held || ledger.serviceReadsInFlight || refreshClaimed)
        throw new Error("Refresh gate needs an idle, unused boundary");
      let release!: () => void;
      const gate: Gate = {
        ready: () => {},
        release: new Promise((resolve) => {
          release = resolve;
        }),
        activationStart: null,
        requestStart: null,
      };
      const requested = new Promise<void>((resolve, reject) => {
        gate.ready = (error) => (error ? reject(error) : resolve());
      });
      held = gate;
      releases.push(release);
      return {
        requested,
        async complete() {
          if (!gate.request) throw new Error("No owned service Request");
          const response = page.waitForResponse(
            (response) => response.request() === gate.request,
          );
          release();
          const completed = await response;
          expect(await completed.finished()).toBeNull();
          gate.requestStart = ledger.requestStart = completed
            .request()
            .timing().startTime;
          // Native Request timing is valid after completion. URL equality alone is
          // insufficient: the gate and timing above share the exact Request object.
          // Both clocks are epoch milliseconds in this native Chromium context.
          // No rounding tolerance or clock mocking conceals uncertain ordering.
          expect(gate.requestStart).toBeGreaterThan(0);
          expect(gate.requestStart).toBeGreaterThanOrEqual(
            gate.activationStart!,
          );
        },
      };
    },
  };
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let count = 0; count < 80; count++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    const backwards = await target.evaluate((node) => {
      const active = document.activeElement;
      return !!(
        active &&
        active !== document.body &&
        active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING
      );
    });
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
  }
  throw new Error(
    "Inventory action unreachable by ordinary keyboard traversal",
  );
}

async function capture(
  page: Page,
  info: TestInfo,
  stage: string,
  theme: Theme,
  surface: Locator,
  action?: Locator,
  settle = true,
) {
  const failures: unknown[] = [];
  try {
    if (settle) await settledTask(surface);
  } catch (error) {
    failures.push(error);
  }
  // Keep original-position pixels before geometry or assertions; never focus,
  // scroll, dismiss an overlay, change animation or reconstruct pixels here.
  try {
    const pixels = await page.screenshot({
      path: info.outputPath(`inventory-keyboard-${stage}.png`),
      fullPage: false,
      mask: [
        page.locator(
          'input[type="password"], textarea, [autocomplete="current-password"], [autocomplete="new-password"], [aria-label*="密码"], [aria-label*="密钥"], [aria-label*="令牌"]',
        ),
      ],
    });
    await info.attach(`${stage}-pixels`, {
      body: pixels,
      contentType: "image/png",
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    const geometry =
      action && (await action.count()) === 1
        ? await action.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            // SearchField paints its focus ring on the official InputGroup wrapper,
            // not the borderless input. Measure that actual ring carrier separately.
            const carrier = node.matches('[data-slot="input-group-control"]')
              ? node.closest('[data-slot="input-group"]')!
              : node;
            const ring = carrier.getBoundingClientRect();
            let left = 0,
              top = 0,
              right = innerWidth,
              bottom = innerHeight;
            for (
              let parent = carrier.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent),
                box = parent.getBoundingClientRect();
              if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
                left = Math.max(left, box.left + parent.clientLeft);
                right = Math.min(
                  right,
                  box.left + parent.clientLeft + parent.clientWidth,
                );
              }
              if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
                top = Math.max(top, box.top + parent.clientTop);
                bottom = Math.min(
                  bottom,
                  box.top + parent.clientTop + parent.clientHeight,
                );
              }
            }
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            );
            return {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              ringX: ring.x,
              ringY: ring.y,
              ringWidth: ring.width,
              ringHeight: ring.height,
              clipLeft: left,
              clipTop: top,
              clipRight: right,
              clipBottom: bottom,
              groupRing: carrier !== node,
              ring3px: /(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/.test(
                getComputedStyle(carrier).boxShadow,
              ),
              ringInsideClips:
                ring.left - 3 >= left - 0.5 &&
                ring.right + 3 <= right + 0.5 &&
                ring.top - 3 >= top - 0.5 &&
                ring.bottom + 3 <= bottom + 0.5,
              inViewport:
                rect.width > 0 &&
                rect.height > 0 &&
                rect.x >= 0 &&
                rect.y >= 0 &&
                rect.right <= innerWidth &&
                rect.bottom <= innerHeight,
              focused: node === document.activeElement,
              focusVisible: node.matches(":focus-visible"),
              hit: hit === node || node.contains(hit),
            };
          })
        : null;
    const viewport = await page.evaluate(
      (expected) => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        storedThemeMatches:
          localStorage.getItem("routeweaver-theme") === expected,
        themeClassMatches:
          document.documentElement.classList.contains(expected) &&
          !document.documentElement.classList.contains(
            expected === "light" ? "dark" : "light",
          ),
        paintedThemeMatches:
          getComputedStyle(document.documentElement).colorScheme === expected,
      }),
      theme,
    );
    const body = JSON.stringify(
      { viewport, geometry, settlingFailed: failures.length > 0 },
      null,
      2,
    );
    await writeFile(info.outputPath(`inventory-keyboard-${stage}.json`), body);
    await info.attach(`${stage}-geometry`, {
      body,
      contentType: "application/json",
    });
    expect(viewport).toMatchObject({
      storedThemeMatches: true,
      themeClassMatches: true,
      paintedThemeMatches: true,
    });
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
    if (action)
      expect(geometry).toMatchObject({
        focused: true,
        focusVisible: true,
        inViewport: true,
        hit: true,
        ring3px: true,
        ringInsideClips: true,
      });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Inventory original capture or geometry failed",
    );
}

const journeys = [
  {
    width: 390,
    height: 560,
    theme: "light",
    empty: "services",
    label: "服务方案",
  },
  { width: 1440, height: 900, theme: "dark", empty: "users", label: "用户" },
] as const;
for (const journey of journeys)
  test(`Inventory keyboard ${journey.empty} at ${journey.width}px ${journey.theme}`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({
      width: journey.width,
      height: journey.height,
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript((theme) => {
      localStorage.setItem("routeweaver-theme", theme);
      const observer = window as unknown as Observer;
      observer.__inventoryRefreshes = [];
      // Passive public DOM observation, never an application test hook.
      document.addEventListener(
        "click",
        (event) => {
          const button =
            event.target instanceof Element
              ? event.target.closest("button")
              : null;
          if (
            (button?.getAttribute("aria-label") ??
              button?.textContent?.trim()) === "刷新服务方案"
          )
            observer.__inventoryRefreshes.push({
              time: performance.timeOrigin + performance.now(),
              trusted: event.isTrusted,
              keyboard: event.detail === 0,
            });
        },
        true,
      );
    }, journey.theme);
    const http = await fixture(page, baseURL),
      failures: unknown[] = [];
    const main = page.locator("main");
    const search = page.getByRole("textbox", {
      name: "搜索服务方案",
      exact: true,
    });
    const opener = main
      .getByRole("group", { name: "Plan 10 的操作", exact: true })
      .getByRole("button", { name: "编辑", exact: true });
    const dialog = page.getByRole("dialog", {
      name: "编辑 Plan 10",
      exact: true,
    });
    const mountedDialog = page.getByRole("dialog", {
      name: "编辑 Plan 10",
      exact: true,
      includeHidden: true,
    });
    const field = dialog.getByRole("textbox", {
      name: "服务方案名称",
      exact: true,
    });
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const refresh = main.getByRole("button", {
      name: "刷新服务方案",
      exact: true,
    });
    const activate = async (target: Locator) => {
      await tabTo(page, target);
      await page.keyboard.press("Enter");
    };
    const snap = (
      stage: string,
      target?: Locator,
      surface = main,
      settle = true,
    ) => capture(page, info, stage, journey.theme, surface, target, settle);
    try {
      await page.goto(`/#${journey.empty}`);
      const emptySearch = page.getByRole("textbox", {
        name: `搜索${journey.label}`,
        exact: true,
      });
      await expect(
        main.getByRole("cell", { name: "Plan 00", exact: true }),
      ).toBeVisible();
      await tabTo(page, emptySearch);
      await page.keyboard.type("No matching inventory");
      await expect(
        main.getByText(`没有匹配的${journey.label}`, { exact: true }),
      ).toBeVisible();
      const clear = main.getByRole("button", { name: "清除搜索", exact: true });
      await tabTo(page, clear);
      await snap("empty-clear-keyboard", clear);
      await page.keyboard.press("Enter");
      await snap("empty-search-return", emptySearch);
      await expect(emptySearch).toHaveValue("");
      await expect(
        main.getByRole("cell", { name: "Plan 00", exact: true }),
      ).toBeVisible();
      await expect(
        main.getByText("第 1 / 3 页", { exact: true }),
      ).toBeVisible();
      if (journey.empty === "users") await navigateWorkspace(page, "服务方案");
      await tabTo(page, search);
      await page.keyboard.type("Plan");
      await activate(main.getByRole("button", { name: "下一页", exact: true }));
      await expect(
        main.getByRole("cell", { name: "Plan 10", exact: true }),
      ).toBeVisible();

      // Connected opener comparison before any refresh: it must beat the fallback.
      http.beginOpening();
      await activate(opener);
      await expect(field).toHaveValue("Plan 10");
      const firstOpeningReads = http.openingReady();
      expect(firstOpeningReads).toBeGreaterThan(0);
      await settledTask(dialog);
      await activate(cancel);
      await expect(mountedDialog).toHaveCount(0);
      await snap("connected-opener-return", opener);
      http.ledger.connectedOpenerReturned = await opener.evaluate(
        (node) => node === document.activeElement,
      );

      await tabTo(page, refresh);
      await snap("refresh-keyboard", refresh);
      await expect.poll(() => http.ledger.serviceReadsInFlight).toBe(0);
      const readsBefore = http.ledger.serviceReads,
        authBefore = http.ledger.authReads;
      const gate = http.holdRefresh();
      await page.keyboard.press("Enter");
      await gate.requested;
      await expect(
        main.getByText("正在刷新服务方案…", { exact: true }),
      ).toBeVisible();
      await expect(refresh).toHaveAttribute("aria-disabled", "true");
      expect(http.ledger.serviceReads).toBe(readsBefore + 1);
      await snap("refresh-pending", refresh, main, false);
      http.beginOpening();
      await activate(opener);
      await expect(field).toHaveValue("Plan 10");
      await settledTask(dialog);
      await tabTo(page, field);
      // Real App StrictMode permits at most one replay for this explicit
      // opening. Readiness closes that epoch; reconciliation cannot reopen it.
      const openingReadsAtReady = http.openingReady();
      expect(openingReadsAtReady).toBeGreaterThan(firstOpeningReads);
      expect(http.ledger.deliveredHeldReads).toBe(0);
      await gate.complete();
      await expect(
        main.getByText("正在刷新服务方案…", { exact: true }),
      ).toHaveCount(0);
      await expect(
        main.getByRole("group", {
          name: "Plan 10 的操作",
          exact: true,
          includeHidden: true,
        }),
      ).toHaveCount(0);
      await snap("refreshed-draft-owned", field, dialog);
      await expect(field).toHaveValue("Plan 10");
      http.ledger.openingValuePreserved =
        (await field.inputValue()) === "Plan 10";
      http.ledger.newerFocusPreserved = await field.evaluate(
        (node) => node === document.activeElement,
      );
      await activate(cancel);
      await expect(mountedDialog).toHaveCount(0);
      await snap("missing-opener-search-return", search);
      await expect(search).toHaveValue("Plan");
      await expect(
        main.getByText("第 2 / 3 页", { exact: true }),
      ).toBeVisible();
      await expect(
        main.getByRole("cell", { name: "Plan 11", exact: true }),
      ).toBeVisible();
      await expect(
        main.getByRole("cell", { name: "Plan 00", exact: true }),
      ).toHaveCount(0);
      http.ledger.queryPreserved = (await search.inputValue()) === "Plan";
      http.ledger.pagePreserved = await main
        .getByText("第 2 / 3 页", { exact: true })
        .isVisible();
      http.ledger.missingOpenerSearchReturned = await search.evaluate(
        (node) => node === document.activeElement,
      );
      expect(http.ledger.serviceReads).toBe(readsBefore + 1);
      expect(http.ledger.authReads).toBe(authBefore);
      expect(http.ledger.editReads).toBe(openingReadsAtReady);
      expect(http.ledger).toMatchObject({
        heldReads: 1,
        deliveredHeldReads: 1,
        rejectedGates: 0,
        rejectedOpeningReads: 0,
        openingsReady: [true, true],
        refreshActivations: 1,
        trustedKeyboardActivation: true,
        sameIdentityOutsideFilter: true,
        connectedOpenerReturned: true,
        missingOpenerSearchReturned: true,
        queryPreserved: true,
        pagePreserved: true,
        openingValuePreserved: true,
        newerFocusPreserved: true,
      });
    } catch (error) {
      failures.push(error);
    } finally {
      // Preserve an original even on failure, without settling a held spinner or
      // releasing the held response first and thereby hiding the failure state.
      try {
        await snap("final-original", undefined, page.locator("body"), false);
      } catch (error) {
        failures.push(error);
      }
      try {
        const body = JSON.stringify(
          {
            width: journey.width,
            theme: journey.theme,
            emptyInventory: journey.empty,
            ...http.ledger,
          },
          null,
          2,
        );
        await writeFile(
          info.outputPath("inventory-keyboard-request-ledger.json"),
          body,
        );
        await info.attach("inventory-keyboard-ledger", {
          body,
          contentType: "application/json",
        });
        expect(http.ledger).toMatchObject({
          rejectedRequests: 0,
          rejectedWrites: 0,
          pageErrors: 0,
        });
      } catch (error) {
        failures.push(error);
      }
      http.releaseAll();
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Inventory keyboard native sampler failed",
      );
  });
