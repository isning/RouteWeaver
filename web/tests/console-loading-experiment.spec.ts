import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const modes = ["suspense", "state"] as const;
type Mode = (typeof modes)[number];
type Build = {
  binary: string;
  directories: Record<Mode, string>;
  identity: unknown;
};
type Instance = { url: string; stop: () => Promise<void> };
type Event = {
  name: string;
  time: number;
  detail?: { phase: string; concealed: boolean };
};
type Resource = {
  path: string;
  startTime: number;
  duration: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
};
type Observation = {
  events: Event[];
  resources: Resource[];
  paints: { name: string; startTime: number }[];
  longTasks: { startTime: number; duration: number }[];
  visibility: string;
  observedAt: number;
};

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Diagnostic server did not stop within 15 seconds"));
    }, 15000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}
async function start(
  build: Build,
  mode: Mode,
  directory: string,
): Promise<Instance> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("ROUTEWEAVER_"),
    ),
  );
  env.ROUTEWEAVER_MASTER_KEY = randomBytes(32).toString("hex");
  env.ROUTEWEAVER_ADMIN_USERNAME = "routeweaver";
  env.ROUTEWEAVER_ADMIN_PASSWORD = "local-demo-password";
  const child = spawn(
    build.binary,
    [
      "--listen",
      "127.0.0.1:0",
      "--db",
      join(directory, `${mode}.db`),
      "--ui-dir",
      build.directories[mode],
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const url = await new Promise<string>((done, reject) => {
      let startup = "";
      const timer = setTimeout(
        () => reject(new Error("Diagnostic server startup timed out")),
        30000,
      );
      const failed = () => {
        clearTimeout(timer);
        reject(new Error("Diagnostic server exited during startup"));
      };
      child.once("error", failed);
      child.once("exit", failed);
      child.stderr!.on("data", (chunk: Buffer) => {
        startup = (startup + chunk.toString()).slice(-4096);
        const match = startup.match(
          /RouteWeaver listening at (http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (match) {
          clearTimeout(timer);
          child.removeListener("error", failed);
          child.removeListener("exit", failed);
          done(match[1]);
        }
      });
    });
    return { url, stop: () => stop(child) };
  } catch (error) {
    await stop(child);
    throw error;
  }
}
async function inventory(directory: string) {
  const entries = [];
  for (const file of (await readdir(join(directory, "assets"))).sort()) {
    const data = await readFile(join(directory, "assets", file));
    entries.push({
      file,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  return entries;
}
const test = base.extend<
  { instances: Record<Mode, Instance> },
  { build: Build }
>({
  build: [
    async ({}, use) => {
      const directory = await mkdtemp(
        join(tmpdir(), "routeweaver-loading-build-"),
      );
      try {
        const binary = join(directory, "control-plane");
        await execute(
          join(root, "scripts/go.sh"),
          ["build", "-o", binary, "./cmd/control-plane"],
          { cwd: root, timeout: 120000 },
        );
        const directories = {
          suspense: join(directory, "suspense"),
          state: join(directory, "state"),
        };
        const outputs: Record<string, unknown> = {};
        for (const mode of modes) {
          await execute(
            process.execPath,
            [
              join(root, "web/node_modules/vite/bin/vite.js"),
              "build",
              "--config",
              "tests/console-loading-experiment.vite.ts",
              "--outDir",
              directories[mode],
            ],
            {
              cwd: join(root, "web"),
              timeout: 120000,
              env: {
                ...process.env,
                ROUTEWEAVER_LOADING_EXPERIMENT_MODE: mode,
              },
            },
          );
          outputs[mode] = await inventory(directories[mode]);
        }
        const sourceHashes: Record<string, string> = {};
        for (const path of [
          "web/src/App.tsx",
          "web/src/Subscriptions.tsx",
          "web/src/SessionLifecycle.ts",
          "web/src/PageBoundary.tsx",
          "web/package-lock.json",
          "web/tests/console-loading-experiment.vite.ts",
        ]) {
          sourceHashes[path] = createHash("sha256")
            .update(await readFile(join(root, path)))
            .digest("hex");
        }
        await use({
          binary,
          directories,
          identity: {
            testedCommit: process.env.GITHUB_SHA || null,
            baseCommit: process.env.ROUTEWEAVER_EXPERIMENT_BASE || null,
            sourceHashes,
            outputs,
          },
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 360000 },
  ],
  instances: async ({ build }, use) => {
    const directory = await mkdtemp(
      join(tmpdir(), "routeweaver-loading-state-"),
    );
    const servers: Instance[] = [];
    try {
      const suspense = await start(build, "suspense", directory);
      servers.push(suspense);
      const state = await start(build, "state", directory);
      servers.push(state);
      await use({ suspense, state });
    } finally {
      try {
        const outcomes = await Promise.allSettled(
          servers.reverse().map((server) => server.stop()),
        );
        const failures = outcomes.filter(
          (result) => result.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Diagnostic server cleanup failed",
          );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});

// Executes before any application module. Observe actual fetch calls; do not
// route, stub, replace responses or disable HTTP caching. No cookies/bodies/IDs.
function installProbe() {
  const events: Event[] = [];
  const longTasks: { startTime: number; duration: number }[] = [];
  let release!: () => void;
  const gated = new URLSearchParams(location.search).has("moduleGate");
  const moduleGate = gated
    ? new Promise<void>((done) => {
        release = done;
      })
    : undefined;
  const mark = (name: string, detail?: Event["detail"]) =>
    events.push({
      name,
      time: performance.now(),
      ...(detail ? { detail } : {}),
    });
  const state = {
    events,
    longTasks,
    mark,
    moduleGate,
    release: () => {
      mark("gate-release");
      release?.();
    },
  };
  (globalThis as any).__rwLoadingExperiment = state;
  const fetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const path = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    ).pathname;
    if (
      [
        "/api/auth/me",
        "/api/me/overview",
        "/api/me/outputs",
        "/api/me/profiles",
      ].includes(path)
    )
      mark(`fetch:${path}`);
    return fetch.call(this, input, init);
  };
  document.addEventListener("visibilitychange", () =>
    mark(`visibility:${document.visibilityState}`),
  );
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
        });
    }).observe({ type: "longtask", buffered: true });
  }
}
async function context(
  browser: Browser,
  url: string,
  width: number,
  cookies?: Awaited<ReturnType<BrowserContext["cookies"]>>,
) {
  expect(new URL(url).hostname).toBe("127.0.0.1");
  const result = await browser.newContext({
    baseURL: url,
    viewport: { width, height: 960 },
    reducedMotion: "reduce",
  });
  await result.addInitScript(installProbe);
  if (cookies) await result.addCookies(cookies);
  return result;
}
async function login(browser: Browser, url: string, width: number) {
  const setup = await context(browser, url, width);
  try {
    const page = await setup.newPage();
    await page.goto("/");
    await expect(page.getByLabel("账号", { exact: true })).toBeVisible();
    const before = await page.evaluate(
      () => (globalThis as any).__rwLoadingExperiment.events as Event[],
    );
    expect(
      before.filter(
        (entry) =>
          entry.name === "module-request" ||
          entry.name.startsWith("fetch:/api/me/"),
      ),
    ).toEqual([]);
    await page.getByLabel("账号", { exact: true }).fill("routeweaver");
    await page.getByLabel("密码", { exact: true }).fill("local-demo-password");
    await page
      .getByRole("button", { name: "进入工作空间", exact: true })
      .click();
    await waitForConfirmedWorkspace(page, "normal-ui-login");
    const cookies = (await setup.cookies(url)).filter(
      (cookie) => cookie.name === "routeweaver_session",
    );
    expect(cookies).toHaveLength(1);
    return cookies;
  } finally {
    await setup.close();
  }
}
async function observe(page: Page, gateDelay?: number): Promise<Observation> {
  try {
    const reads = [
      "/api/auth/me",
      "/api/me/overview",
      "/api/me/outputs",
      "/api/me/profiles",
    ].map((path) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path &&
          response.request().method() === "GET",
      ),
    );
    await page.goto(
      gateDelay === undefined
        ? "/#subscriptions"
        : "/?moduleGate=1#subscriptions",
      { waitUntil: "load" },
    );
    if (gateDelay !== undefined) {
      await page.waitForFunction(() => {
        const events = (globalThis as any).__rwLoadingExperiment
          .events as Event[];
        return ["module-loaded", "fallback-commit"].every((name) =>
          events.some((entry) => entry.name === name),
        );
      });
      // Intentional experimental input, not an interaction retry or readiness sleep.
      await page.evaluate(async (delay) => {
        const probe = (globalThis as any).__rwLoadingExperiment;
        const fallback = probe.events.find(
          (entry: Event) => entry.name === "fallback-commit",
        ).time;
        await new Promise<void>((done) =>
          setTimeout(
            () => {
              probe.release();
              done();
            },
            Math.max(0, fallback + delay - performance.now()),
          ),
        );
      }, gateDelay);
    }
    await waitForConfirmedWorkspace(page);
    await expect(page.getByText("暂无订阅", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "新建分流配置", exact: true }),
    ).toBeEnabled();
    for (const response of await Promise.all(reads)) {
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("no-store");
      await response.finished();
    }
    await page.evaluate(() => document.fonts.ready);
    return snapshot(page);
  } catch (error) {
    try {
      await test
        .info()
        .attach("incomplete-loader-probe", {
          contentType: "application/json",
          body: JSON.stringify({
            gateDelay: gateDelay ?? null,
            observation: await snapshot(page),
          }),
        });
    } catch {
      /* Original failure remains authoritative if capture is unavailable. */
    }
    throw error;
  }
}
async function snapshot(page: Page): Promise<Observation> {
  return page.evaluate(() => {
    const probe = (globalThis as any).__rwLoadingExperiment;
    return {
      events: probe.events,
      longTasks: probe.longTasks,
      visibility: document.visibilityState,
      observedAt: performance.now(),
      resources: (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).map((entry) => ({
        path: new URL(entry.name).pathname,
        startTime: entry.startTime,
        duration: entry.duration,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      })),
      paints: performance
        .getEntriesByType("paint")
        .map(({ name, startTime }) => ({ name, startTime })),
    };
  });
}
function check(value: Observation, warm: boolean) {
  const time = (name: string) => {
    const events = value.events.filter((entry) => entry.name === name);
    expect(events, name).toHaveLength(1);
    return events[0].time;
  };
  expect(value.visibility).toBe("visible");
  expect(
    value.events.filter(
      (entry) =>
        entry.name.startsWith("visibility:") &&
        entry.name !== "visibility:visible",
    ),
  ).toEqual([]);
  const active = time("session-active"),
    requested = time("module-request"),
    loaded = time("module-loaded"),
    settled = time("module-settled"),
    committed = time("page-commit"),
    fallback = time("fallback-commit");
  expect(requested).toBeGreaterThanOrEqual(active);
  expect(loaded).toBeGreaterThanOrEqual(requested);
  expect(settled).toBeGreaterThanOrEqual(loaded);
  const releases = value.events.filter(
    (entry) => entry.name === "gate-release",
  );
  if (releases.length) {
    expect(releases).toHaveLength(1);
    expect(releases[0].time).toBeGreaterThanOrEqual(loaded);
    expect(releases[0].time).toBeGreaterThanOrEqual(fallback);
    expect(settled).toBeGreaterThanOrEqual(releases[0].time);
  }
  expect(committed).toBeGreaterThanOrEqual(settled);
  expect(committed).toBeGreaterThanOrEqual(fallback);
  for (const path of [
    "/api/me/overview",
    "/api/me/outputs",
    "/api/me/profiles",
  ])
    expect(time(`fetch:${path}`)).toBeGreaterThanOrEqual(committed);
  const guards = value.events.filter(
    (entry) => entry.name === "transport-check",
  );
  expect(guards).toHaveLength(3);
  expect(
    guards.every(
      (entry) =>
        entry.detail?.phase === "active" && entry.detail?.concealed === false,
    ),
  ).toBe(true);
  const assets = value.resources.filter((entry) =>
    entry.path.startsWith("/assets/"),
  );
  expect(assets.length).toBeGreaterThan(0);
  expect(
    assets.every((entry) =>
      warm ? entry.transferSize === 0 : entry.transferSize > 0,
    ),
  ).toBe(true);
  expect(
    value.resources.some((entry) => /^\/(src|node_modules)\//.test(entry.path)),
  ).toBe(false);
  const sum = (suffix: string) =>
    assets
      .filter((entry) => entry.path.endsWith(suffix))
      .reduce((total, entry) => total + entry.decodedBodySize, 0);
  expect(sum(".js")).toBeLessThan(850000);
  expect(sum(".css")).toBeLessThan(180000);
}
for (const width of [1440, 390])
  test(`controlled production loader comparison at ${width}`, async ({
    browser,
    instances,
    build,
  }, info) => {
    const records: {
      pair: number;
      mode: Mode;
      condition: string;
      observation: Observation;
    }[] = [];
    const errors: string[] = [];
    try {
      const cookies = {
        suspense: await login(browser, instances.suspense.url, width),
        state: await login(browser, instances.state.url, width),
      };
      for (let pair = 0; pair < 8; pair++) {
        const order: Mode[] =
          pair % 2 === 0 ? ["suspense", "state"] : ["state", "suspense"];
        for (const mode of order) {
          const sample = await context(
            browser,
            instances[mode].url,
            width,
            cookies[mode],
          );
          try {
            const page = await sample.newPage();
            page.on("pageerror", (error) => errors.push(error.name));
            const cold = await observe(page);
            records.push({ pair, mode, condition: "cold", observation: cold });
            check(cold, false);
            await page.goto("about:blank");
            const warm = await observe(page);
            records.push({ pair, mode, condition: "warm", observation: warm });
            check(warm, true);
          } finally {
            await sample.close();
          }
        }
      }
      // Separate mechanism probe: hold already-loaded code, then release relative
      // to a committed fallback. Total gated page duration is not a UX comparison.
      for (let pair = 0; pair < 4; pair++) {
        const order: Mode[] =
          pair % 2 === 0 ? ["suspense", "state"] : ["state", "suspense"];
        for (const mode of order) {
          const sample = await context(
            browser,
            instances[mode].url,
            width,
            cookies[mode],
          );
          try {
            const page = await sample.newPage();
            page.on("pageerror", (error) => errors.push(error.name));
            await observe(page); // Prime only this isolated context's HTTP cache.
            for (const delay of pair % 2 === 0 ? [50, 350] : [350, 50]) {
              await page.goto("about:blank");
              const observation = await observe(page, delay);
              records.push({
                pair,
                mode,
                condition: `warm-gate-${delay}`,
                observation,
              });
              check(observation, true);
            }
          } finally {
            await sample.close();
          }
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await info.attach(`production-loader-experiment-${width}`, {
        contentType: "application/json",
        body: JSON.stringify(
          {
            scope:
              "Diagnostic production builds on isolated loopback Go servers with synthetic accounts/empty inventories; no request interception, no owner data, no Sites or live latency claim. Eight AB/BA paired natural cold/warm samples and four paired early/late promise-release probes; every sample retained, no causal timing threshold asserted.",
            viewport: { width, height: 960 },
            browserVersion: browser.version(),
            expectedRecords: 48,
            build: build.identity,
            errors,
            records,
          },
          null,
          2,
        ),
      });
    }
  });
