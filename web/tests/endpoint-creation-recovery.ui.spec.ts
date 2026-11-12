import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
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

// Native real-App task with local HTTP interception only, not Go/store proof.
// No target is connected: every address is synthetic and reserved .invalid.
test.use({
  serviceWorkers: "block",
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});
const name = "Synthetic receipt recovery endpoint";
const submitted = {
  name,
  host: "endpoint-recovery.invalid",
  port: 1080,
  protocol: "socks",
  status: "unregistered",
};
const different = {
  ...submitted,
  name: "Synthetic later endpoint",
  host: "endpoint-later.invalid",
  port: 2080,
  region: "ZZ",
  tags: ["synthetic-kept"],
  coreId: "synthetic-core",
  coreVersion: "1.0.0",
};
const uncertainCopy =
  "已保留本次提交，确认结果前暂不能修改。请检查创建结果；关闭不会撤销可能已完成的创建。";
const absentCopy =
  "之前的请求仍可能完成。重试只会继续本次创建，不会覆盖已有端点。";
const closeCopy =
  "端点可能已经创建，关闭不会撤销创建。再次添加会开始新的创建。";
const differentCopy = "未覆盖现有资料。请在端点列表中核对，再决定是否编辑。";
type RecordValue = typeof submitted & { id: string };
type Gate = {
  ready: (error?: Error) => void;
  release: Promise<void>;
  expectedClick: number;
  captureRequest: (request: Request) => void;
};
type CheckObserver = { __endpointCheckTimes: number[] };

async function fixture(
  page: Page,
  baseURL: string | undefined,
  scenario: "ownership" | "conflict",
) {
  if (
    !baseURL ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
  )
    throw new Error("Synthetic endpoint sampler requires loopback");
  const origin = new URL(baseURL).origin;
  let first: RecordValue | undefined,
    stored: RecordValue | undefined,
    occupiedSnapshot: RecordValue | undefined;
  let firstWireBody: string | null = null;
  let held: Gate | undefined;
  const releases: (() => void)[] = [];
  // No request URLs, IDs, body values, headers, errors or credential-like strings
  // enter this ledger. Rejection categories are counted rather than recorded.
  const ledger = {
    postAttempts: 0,
    validatedCommands: 0,
    syntheticCommits: 0,
    conflictReplies: 0,
    stateReads: 0,
    authReads: 0,
    heldReads: 0,
    deliveredHeldReads: 0,
    stateReadsInFlight: 0,
    stateReadTiming: [] as {
      read: number;
      explicitClicks: number;
      held: boolean;
      requestStart: number | null;
      activationStart: number | null;
    }[],
    commandIDsMatch: true,
    commandBodiesMatch: true,
    commandWireBodiesMatch: true,
    guardedHeadersMatch: true,
    occupiedRecordUnchanged: true,
    unexpectedRequests: 0,
    unexpectedWrites: 0,
    malformedCommands: 0,
    rejectedReadGates: 0,
    pageErrors: 0,
  };
  const state = () => ({
    users: [],
    nodes: stored ? [stored] : [],
    routes: [],
    revisions: [],
    capabilities: [],
  });
  const reads: Record<string, unknown> = {
    "/api/auth/me": {
      user: {
        id: "synthetic-endpoint-admin",
        name: "Synthetic admin",
        role: "admin",
      },
      csrfToken: "synthetic-endpoint-only",
    },
    "/api/services": [],
    "/api/published-routes": [],
    "/api/rates": [],
    "/api/user-groups": [],
    "/api/settings": {},
  };
  page.on("pageerror", () => ledger.pageErrors++);
  await page.context().route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    const reject = () => {
      ledger.unexpectedRequests++;
      if (method !== "GET") ledger.unexpectedWrites++;
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
    if (url.search) return reject();
    if (url.pathname === "/api/nodes" && method === "POST") {
      ledger.postAttempts++;
      let body: RecordValue;
      try {
        body = request.postDataJSON();
      } catch {
        ledger.malformedCommands++;
        return reject();
      }
      const headers = await request.allHeaders();
      ledger.guardedHeadersMatch &&=
        headers["if-none-match"] === "*" &&
        headers["x-csrf-token"] === "synthetic-endpoint-only" &&
        headers["content-type"] === "application/json";
      if (!ledger.guardedHeadersMatch) return reject();
      if (
        !body ||
        typeof body.id !== "string" ||
        !/^node_[a-f0-9]{16}$/.test(body.id) ||
        !isDeepStrictEqual(body, { id: body.id, ...submitted })
      ) {
        ledger.malformedCommands++;
        return reject();
      }
      if (!first) {
        first = structuredClone(body);
        firstWireBody = request.postData();
        ledger.validatedCommands++;
        if (scenario === "ownership") {
          stored = structuredClone(body);
          ledger.syntheticCommits++;
        }
        return route.abort("failed"); // Lost receipt is deliberately not a known rejection.
      }
      ledger.commandIDsMatch &&= body.id === first.id;
      ledger.commandBodiesMatch &&= isDeepStrictEqual(body, first);
      ledger.commandWireBodiesMatch &&= request.postData() === firstWireBody;
      if (
        scenario !== "conflict" ||
        ledger.postAttempts !== 2 ||
        !occupiedSnapshot ||
        !ledger.commandIDsMatch ||
        !ledger.commandBodiesMatch ||
        !ledger.commandWireBodiesMatch
      )
        return reject();
      ledger.validatedCommands++;
      // Model only the declared conflict seam. The test never implements an
      // upsert, nor treats an earlier absent GET as permission to overwrite.
      ledger.conflictReplies++;
      ledger.occupiedRecordUnchanged &&= isDeepStrictEqual(
        stored,
        occupiedSnapshot,
      );
      return route.fulfill({
        status: 412,
        json: {
          code: "NODE_CREATION_CONFLICT",
          detail: "Synthetic target already exists",
        },
      });
    }
    if (method !== "GET") return reject();
    if (url.pathname === "/api/state") {
      const read = ++ledger.stateReads;
      ledger.stateReadsInFlight++; // Count before any awaited observer can yield.
      const gate = held;
      held = undefined; // Exactly one request can claim an armed gate.
      gate?.captureRequest(request);
      try {
        const activations = await page.evaluate(
          () => (window as unknown as CheckObserver).__endpointCheckTimes ?? [],
        );
        const clicks = activations.length,
          activationStart = gate
            ? (activations[gate.expectedClick - 1] ?? null)
            : null;
        ledger.stateReadTiming.push({
          read,
          explicitClicks: clicks,
          held: !!gate,
          requestStart: null,
          activationStart,
        });
        if (
          gate &&
          (clicks !== gate.expectedClick || activationStart === null)
        ) {
          ledger.rejectedReadGates++;
          gate.ready(
            new Error("State read preceded the intended Check activation"),
          );
          return await reject();
        }
        if (gate) {
          ledger.heldReads++;
          gate.ready();
          await gate.release;
          await route.fulfill({ json: state() });
          ledger.deliveredHeldReads++;
          return;
        }
        return await route.fulfill({ json: state() });
      } finally {
        ledger.stateReadsInFlight--;
      }
    }
    if (!Object.hasOwn(reads, url.pathname)) return reject();
    if (url.pathname === "/api/auth/me") ledger.authReads++;
    return route.fulfill({ json: reads[url.pathname] });
  });
  return {
    ledger,
    recordMatches: (expected: typeof submitted) =>
      !!first && isDeepStrictEqual(stored, { id: first.id, ...expected }),
    occupy: () => {
      if (
        !first ||
        stored ||
        scenario !== "conflict" ||
        ledger.postAttempts !== 1
      )
        throw new Error("Unexpected synthetic occupancy setup");
      stored = { id: first.id, ...different };
      occupiedSnapshot = structuredClone(stored);
      ledger.syntheticCommits++;
    },
    releaseAll: () => releases.forEach((release) => release()),
    holdRead: (expectedClick: number) => {
      if (held || ledger.stateReadsInFlight !== 0)
        throw new Error("Read gate needs an idle state boundary");
      let release!: () => void, ready!: (error?: Error) => void;
      const requested = new Promise<void>((resolve, reject) => {
        ready = (error) => (error ? reject(error) : resolve());
      });
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      let request: Request | undefined;
      releases.push(release);
      held = {
        ready,
        release: promise,
        expectedClick,
        captureRequest: (value) => {
          request = value;
        },
      };
      return { requested, release, expectedClick, request: () => request };
    },
  };
}
async function tabTo(page: Page, scope: Locator, target: Locator) {
  await expect(target).toBeVisible();
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    const backwards = await target.evaluate(
      (node) =>
        !!(
          document.activeElement?.compareDocumentPosition(node)! &
          Node.DOCUMENT_POSITION_PRECEDING
        ),
    );
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    expect(
      await scope.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  throw new Error("Endpoint action unreachable by ordinary keyboard");
}
async function capture(
  page: Page,
  info: TestInfo,
  stage: string,
  surface: Locator,
  action?: Locator,
  copy?: Locator,
  settle = true,
) {
  const errors: unknown[] = [];
  try {
    if (settle) await settledTask(surface);
  } catch (error) {
    errors.push(error);
  }
  try {
    const pixels = await page.screenshot({
      path: info.outputPath(`endpoint-creation-${stage}.png`),
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
    errors.push(error);
  }
  try {
    const geometry = async (target: Locator) =>
      target.evaluate((node) => {
        const r = node.getBoundingClientRect();
        let left = 0,
          top = 0,
          right = innerWidth,
          bottom = innerHeight;
        for (
          let parent = node.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent),
            p = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            left = Math.max(left, p.left + parent.clientLeft);
            right = Math.min(
              right,
              p.left + parent.clientLeft + parent.clientWidth,
            );
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            top = Math.max(top, p.top + parent.clientTop);
            bottom = Math.min(
              bottom,
              p.top + parent.clientTop + parent.clientHeight,
            );
          }
        }
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          contained:
            r.width > 0 &&
            r.height > 0 &&
            r.left >= left &&
            r.right <= right &&
            r.top >= top &&
            r.bottom <= bottom,
          ring3px: /(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/.test(
            getComputedStyle(node).boxShadow,
          ),
          ringContained:
            r.left - 3 >= left - 0.5 &&
            r.right + 3 <= right + 0.5 &&
            r.top - 3 >= top - 0.5 &&
            r.bottom + 3 <= bottom + 0.5,
          focused: node === document.activeElement,
          focusVisible: node.matches(":focus-visible"),
          hit: hit === node || node.contains(hit),
        };
      });
    const result = {
      action: action ? await geometry(action) : null,
      copy: copy ? await geometry(copy) : null,
      viewport: await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        persistedDark: localStorage.getItem("routeweaver-theme") === "dark",
        paintedDark:
          getComputedStyle(document.documentElement).colorScheme === "dark",
      })),
    };
    const body = JSON.stringify(result, null, 2);
    await writeFile(info.outputPath(`endpoint-creation-${stage}.json`), body);
    await info.attach(`${stage}-geometry`, {
      body,
      contentType: "application/json",
    });
    expect(result.viewport.scrollWidth).toBeLessThanOrEqual(
      result.viewport.width + 1,
    );
    if (result.action)
      expect(result.action).toMatchObject({
        contained: true,
        focused: true,
        focusVisible: true,
        hit: true,
        ring3px: true,
        ringContained: true,
      });
    if (result.copy) expect(result.copy.contained).toBe(true);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Endpoint original evidence or geometry failed",
    );
}

for (const journey of [
  { scenario: "ownership", width: 390, theme: "light" },
  { scenario: "conflict", width: 1440, theme: "dark" },
] as const) {
  test(`endpoint creation ${journey.scenario} at ${journey.width}px ${journey.theme}`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({
      width: journey.width,
      height: journey.width === 390 ? 560 : 900,
    });
    // Dark is a persisted user choice while the operating-system preference is light.
    await page.emulateMedia({ colorScheme: "light" });
    await page.addInitScript(
      (theme) => localStorage.setItem("routeweaver-theme", theme),
      journey.theme,
    );
    await page.addInitScript(() => {
      const state = window as unknown as CheckObserver;
      state.__endpointCheckTimes = [];
      document.addEventListener(
        "click",
        (event) => {
          const button =
            event.target instanceof Element
              ? event.target.closest("button")
              : null;
          if (
            (button?.getAttribute("aria-label") ??
              button?.textContent?.trim()) === "检查创建结果"
          )
            state.__endpointCheckTimes.push(
              performance.timeOrigin + performance.now(),
            );
        },
        true,
      );
    });
    const http = await fixture(page, baseURL, journey.scenario),
      failures: unknown[] = [];
    const editor = page.getByRole("dialog", { name: "添加端点", exact: true });
    const mountedEditor = page.getByRole("dialog", {
      name: "添加端点",
      exact: true,
      includeHidden: true,
    });
    const field = editor.getByRole("textbox", {
      name: "端点名称",
      exact: true,
    });
    const host = editor.getByRole("textbox", { name: "连接地址", exact: true });
    const port = editor.getByRole("spinbutton", { name: "端口", exact: true });
    const check = editor.getByRole("button", {
      name: "检查创建结果",
      exact: true,
    });
    const cancel = editor.getByRole("button", { name: "取消", exact: true });
    const activate = async (target: Locator, scope = editor) => {
      await tabTo(page, scope, target);
      await page.keyboard.press("Enter");
    };
    let explicitChecks = 0,
      initialReads = 0,
      readsBeforeClose = 0,
      closeRefreshed = false;
    const assertFrozen = async () => {
      await expect(field).toBeDisabled();
      await expect(field).toHaveValue(name);
      await expect(host).toBeDisabled();
      await expect(host).toHaveValue(submitted.host);
      await expect(port).toBeDisabled();
      await expect(port).toHaveValue("01080");
      await expect(
        editor.getByRole("combobox", { name: "协议", exact: true }),
      ).toBeDisabled();
      await expect(
        editor.getByRole("textbox", { name: "用户名", exact: true }),
      ).toHaveValue("");
      await expect(editor.getByLabel("密码", { exact: true })).toHaveValue("");
      await expect(
        editor.getByRole("button", { name: "保存", exact: true }),
      ).toHaveCount(0);
    };
    const releaseRead = async (
      gate: {
        release: () => void;
        expectedClick: number;
        request: () => Request | undefined;
      },
      decision: Locator,
    ) => {
      const response = page.waitForResponse(
        (r) => r.request() === gate.request(),
      );
      gate.release();
      const completed = await response;
      expect(await completed.finished()).toBeNull();
      // Native timing is populated after response completion; bind it to this
      // exact Request, not another background GET of the same URL.
      const timing = http.ledger.stateReadTiming.find(
        (entry) => entry.held && entry.explicitClicks === gate.expectedClick,
      )!;
      expect(timing).toBeDefined();
      timing.requestStart = completed.request().timing().startTime;
      expect(timing.requestStart).toBeGreaterThan(0);
      expect(timing.requestStart).toBeGreaterThanOrEqual(
        timing.activationStart!,
      );
      await settledTask(decision);
      await expect(decision).toBeVisible();
      await expect(mountedEditor).toHaveCount(1);
      expect(http.ledger.postAttempts).toBe(1);
    };
    const truthfulClose = async () => {
      await activate(cancel);
      const decision = page.getByRole("alertdialog", {
        name: "关闭创建窗口？",
        exact: true,
      });
      const close = decision.getByRole("button", {
        name: "关闭窗口",
        exact: true,
      });
      await expect(decision).toBeVisible();
      await expect(decision).not.toContainText("尚未保存");
      await tabTo(page, decision, close);
      await capture(
        page,
        info,
        "close-review",
        decision,
        close,
        decision.getByText(closeCopy, { exact: true }),
      );
      await expect.poll(() => http.ledger.stateReadsInFlight).toBe(0);
      readsBeforeClose = http.ledger.stateReads;
      await activate(close, decision);
      await expect(editor).toHaveCount(0);
      await expect(decision).toHaveCount(0);
      await expect
        .poll(() => http.ledger.stateReads)
        .toBeGreaterThan(readsBeforeClose);
      await expect.poll(() => http.ledger.stateReadsInFlight).toBe(0);
      closeRefreshed = true;
    };
    try {
      // Real predecessor plus browser Back exercises App ownership while the
      // editor traps in-page focus. No hash injection or trap bypass is used.
      await page.goto("/#services");
      await expect(
        page.getByRole("heading", { name: "服务方案", exact: true }),
      ).toBeVisible();
      await navigateWorkspace(page, "连接端点");
      await expect(
        page.getByRole("heading", { name: "连接端点", exact: true }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveClass(
        new RegExp(`(?:^|\\s)${journey.theme}(?:\\s|$)`),
      );
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).colorScheme,
        ),
      ).toBe(journey.theme);
      expect(
        await page.evaluate(() => localStorage.getItem("routeweaver-theme")),
      ).toBe(journey.theme);
      await expect(
        page.getByRole("heading", { name: "暂无连接端点", exact: true }),
      ).toBeVisible();
      initialReads = http.ledger.stateReads;
      // Admin renders the same add handler in PageHeader and the empty state.
      // Choose the actual heading's header, not a race-dependent global match.
      const endpointHeader = page
        .getByRole("main")
        .locator("header")
        .filter({
          has: page.getByRole("heading", { name: "连接端点", exact: true }),
        });
      await expect(endpointHeader).toHaveCount(1);
      const add = endpointHeader.getByRole("button", {
        name: "添加端点",
        exact: true,
      });
      await expect(add).toHaveCount(1);
      await add.click();
      await expect(editor).toBeVisible();
      await tabTo(page, editor, field);
      await page.keyboard.type(name);
      await tabTo(page, editor, host);
      await page.keyboard.type(submitted.host);
      await tabTo(page, editor, port);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("01080");
      await expect(port).toHaveValue("01080");
      await activate(editor.getByRole("button", { name: "保存", exact: true }));
      await expect(
        editor.getByText("尚未确认端点是否创建", { exact: true }).first(),
      ).toBeVisible();
      await assertFrozen();
      expect(http.ledger.postAttempts).toBe(1);
      expect(http.ledger.validatedCommands).toBe(1);
      await tabTo(page, editor, check);
      await capture(
        page,
        info,
        "uncertain",
        editor,
        check,
        editor.getByText(uncertainCopy, { exact: true }),
      );
      if (journey.scenario === "ownership") {
        await tabTo(page, editor, check);
        await expect.poll(() => http.ledger.stateReadsInFlight).toBe(0);
        const firstReadBaseline = http.ledger.stateReads,
          first = http.holdRead(++explicitChecks);
        await page.keyboard.press("Enter");
        await first.requested;
        expect(http.ledger.stateReads).toBe(firstReadBaseline + 1);
        await expect(check).toHaveAttribute("aria-busy", "true");
        await capture(page, info, "checking", editor, check, undefined, false);
        await activate(cancel);
        const closeDecision = page.getByRole("alertdialog", {
          name: "关闭创建窗口？",
          exact: true,
        });
        const keepChecking = closeDecision.getByRole("button", {
          name: "继续核对",
          exact: true,
        });
        await expect(closeDecision).toBeVisible();
        await tabTo(page, closeDecision, keepChecking);
        await expect(closeDecision).not.toContainText("尚未保存");
        await capture(
          page,
          info,
          "close-decision",
          closeDecision,
          keepChecking,
          closeDecision.getByText(closeCopy, { exact: true }),
        );
        await releaseRead(first, closeDecision);
        await capture(
          page,
          info,
          "late-close-result",
          closeDecision,
          keepChecking,
          closeDecision.getByText(closeCopy, { exact: true }),
        );
        await activate(keepChecking, closeDecision);
        await expect(closeDecision).toHaveCount(0);
        await assertFrozen();
        await tabTo(page, editor, check);
        await expect.poll(() => http.ledger.stateReadsInFlight).toBe(0);
        const secondReadBaseline = http.ledger.stateReads,
          second = http.holdRead(++explicitChecks);
        await page.keyboard.press("Enter");
        await second.requested;
        expect(http.ledger.stateReads).toBe(secondReadBaseline + 1);
        await page.goBack();
        const routeDecision = page.getByRole("alertdialog", {
          name: "离开当前页面？",
          exact: true,
        });
        const stay = routeDecision.getByRole("button", {
          name: "留在当前页面",
          exact: true,
        });
        await expect(routeDecision).toBeVisible();
        await tabTo(page, routeDecision, stay);
        await expect(routeDecision).toContainText(closeCopy);
        await expect(routeDecision).not.toContainText("尚未保存");
        await capture(
          page,
          info,
          "route-decision",
          routeDecision,
          stay,
          routeDecision.locator("[data-workspace-navigation-review]"),
        );
        await releaseRead(second, routeDecision);
        await capture(
          page,
          info,
          "late-route-result",
          routeDecision,
          stay,
          routeDecision.locator("[data-workspace-navigation-review]"),
        );
        await activate(stay, routeDecision);
        await expect(routeDecision).toHaveCount(0);
        await expect(editor).toBeVisible();
        await assertFrozen();
        await expect(page).toHaveURL(/#nodes$/);
        // Cancel is a dismissal, not rollback or a new creation decision.
        await truthfulClose();
        expect(http.ledger.postAttempts).toBe(1);
        expect(http.ledger.validatedCommands).toBe(1);
        expect(http.ledger.heldReads).toBe(2);
        expect(http.ledger.deliveredHeldReads).toBe(2);
        expect(http.recordMatches(submitted)).toBe(true);
      } else {
        explicitChecks++;
        await activate(check);
        await expect(
          editor.getByText("暂未找到本次创建的端点", { exact: true }),
        ).toBeVisible();
        const retry = editor.getByRole("button", {
          name: "重试本次创建",
          exact: true,
        });
        expect(http.ledger.postAttempts).toBe(1);
        expect(http.ledger.syntheticCommits).toBe(0);
        await assertFrozen();
        await tabTo(page, editor, retry);
        await capture(
          page,
          info,
          "absent",
          editor,
          retry,
          editor.getByText(absentCopy, { exact: true }),
        );
        // Occupancy changes only after absence has been observed. The retry
        // must remain exact and guarded; conflict must not expose stored data.
        http.occupy();
        await activate(retry);
        await expect(
          editor.getByText("尚未确认端点是否创建", { exact: true }).first(),
        ).toBeVisible();
        await expect(
          editor.getByText("已有端点的资料与本次提交不同", { exact: true }),
        ).toHaveCount(0);
        await expect(
          editor.getByText(different.name, { exact: true }),
        ).toHaveCount(0);
        await assertFrozen();
        expect(http.ledger.postAttempts).toBe(2);
        expect(http.ledger.conflictReplies).toBe(1);
        expect(http.recordMatches(different)).toBe(true);
        await tabTo(page, editor, check);
        await capture(
          page,
          info,
          "conflict",
          editor,
          check,
          editor.getByText(uncertainCopy, { exact: true }),
        );
        await expect.poll(() => http.ledger.stateReadsInFlight).toBe(0);
        const beforeFreshCheck = http.ledger.stateReads;
        explicitChecks++;
        await activate(check);
        await expect(
          editor.getByText("已有端点的资料与本次提交不同", { exact: true }),
        ).toBeVisible();
        expect(http.ledger.stateReads).toBeGreaterThan(beforeFreshCheck);
        await expect(
          editor.getByText(different.name, { exact: true }),
        ).toBeVisible();
        await expect(
          editor.getByText(`${different.host}:${different.port}`, {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          editor.getByRole("button", { name: "重试本次创建", exact: true }),
        ).toHaveCount(0);
        await assertFrozen();
        await tabTo(page, editor, check);
        await capture(
          page,
          info,
          "different",
          editor,
          check,
          editor.getByText(differentCopy, { exact: false }),
        );
        await truthfulClose();
        expect(http.ledger.postAttempts).toBe(2);
        expect(http.ledger.validatedCommands).toBe(2);
        expect(http.ledger.commandIDsMatch).toBe(true);
        expect(http.ledger.commandBodiesMatch).toBe(true);
        expect(http.ledger.commandWireBodiesMatch).toBe(true);
        expect(http.ledger.occupiedRecordUnchanged).toBe(true);
        expect(http.recordMatches(different)).toBe(true);
      }
      const listName = journey.scenario === "ownership" ? name : different.name;
      await expect(
        page.getByRole("button", { name: new RegExp(`^${listName} `) }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("heading", { name: "连接端点", exact: true }),
      ).toBeVisible();
      await capture(page, info, "refreshed-list", page.locator("body"));
      expect(http.ledger.syntheticCommits).toBe(1);
      expect(http.ledger.guardedHeadersMatch).toBe(true);
    } catch (error) {
      failures.push(error);
    } finally {
      // Preserve the original failed viewport before releasing any pending read.
      try {
        await capture(
          page,
          info,
          "final-original",
          page.locator("body"),
          undefined,
          undefined,
          false,
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        const body = JSON.stringify(
          {
            width: journey.width,
            persistedDark: journey.theme === "dark",
            ownershipJourney: journey.scenario === "ownership",
            explicitChecks,
            initialReads,
            readsBeforeClose,
            closeRefreshed,
            ...http.ledger,
          },
          null,
          2,
        );
        await writeFile(
          info.outputPath("endpoint-creation-request-ledger.json"),
          body,
        );
        await info.attach("endpoint-creation-request-ledger", {
          body,
          contentType: "application/json",
        });
        expect(http.ledger.unexpectedRequests).toBe(0);
        expect(http.ledger.unexpectedWrites).toBe(0);
        expect(http.ledger.malformedCommands).toBe(0);
        expect(http.ledger.rejectedReadGates).toBe(0);
        expect(http.ledger.pageErrors).toBe(0);
      } catch (error) {
        failures.push(error);
      }
      http.releaseAll();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Endpoint journey or evidence failed");
  });
}
