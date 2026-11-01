import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  test as base,
  expect,
  request as createRequest,
} from "@playwright/test";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const username = "routeweaver";
const password = "local-demo-password"; // synthetic bootstrap only; normal CLI, not --demo

type Server = { url: string; stop: () => Promise<void> };
type Build = { binary: string; ui: string };
type Instance = { url: string; restore: (target: string) => Promise<Server> };

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error("Synthetic control plane did not stop within 15 seconds"),
      );
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
  db: string,
  key: string,
  bootstrap: boolean,
): Promise<Server> {
  // Do not inherit real operator configuration or credentials into this fixture.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("ROUTEWEAVER_"),
    ),
  );
  env.ROUTEWEAVER_MASTER_KEY = key;
  if (bootstrap) {
    env.ROUTEWEAVER_ADMIN_USERNAME = username;
    env.ROUTEWEAVER_ADMIN_PASSWORD = password;
  }
  const child = spawn(
    build.binary,
    ["--listen", "127.0.0.1:0", "--db", db, "--ui-dir", build.ui],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const url = await new Promise<string>((done, reject) => {
      let startup = "";
      const timer = setTimeout(
        () => reject(new Error("Synthetic control plane startup timed out")),
        30000,
      );
      const failure = () => {
        clearTimeout(timer);
        reject(new Error("Synthetic control plane exited during startup"));
      };
      child.once("error", failure);
      child.once("exit", failure);
      child.stderr!.on("data", (chunk: Buffer) => {
        startup = (startup + chunk.toString()).slice(-4096);
        const match = startup.match(
          /RouteWeaver listening at (http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (match) {
          clearTimeout(timer);
          child.removeListener("exit", failure);
          child.removeListener("error", failure);
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

export const test = base.extend<
  { isolatedBackup: Instance },
  { backupBuild: Build }
>({
  backupBuild: [
    async ({}, use) => {
      const directory = await mkdtemp(
        join(tmpdir(), "routeweaver-ops01-build-"),
      );
      try {
        const binary = join(directory, "control-plane");
        const ui = join(directory, "ui");
        await execute(
          join(root, "scripts/go.sh"),
          ["build", "-o", binary, "./cmd/control-plane"],
          { cwd: root, timeout: 120000 },
        );
        await execute(
          process.execPath,
          [
            join(root, "web/node_modules/vite/bin/vite.js"),
            "build",
            "--outDir",
            ui,
          ],
          { cwd: join(root, "web"), timeout: 120000 },
        );
        await use({ binary, ui });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 180000 },
  ],
  isolatedBackup: async ({ backupBuild }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "routeweaver-ops01-state-"));
    const key = randomBytes(32).toString("hex");
    const servers: Server[] = [];
    try {
      const live = await start(
        backupBuild,
        join(directory, "live.db"),
        key,
        true,
      );
      servers.push(live);
      await use({
        url: live.url,
        async restore(target) {
          expect(target).toMatch(/^restore_[A-Za-z0-9_-]+\.db$/);
          const restoreDir = join(directory, "restore-staging");
          const db = join(restoreDir, target);
          // Require the exact server-returned existing file, not a guessed target,
          // missing-file bootstrap, symlink, copied snapshot or running live DB.
          expect(await realpath(db)).toBe(db);
          const info = await stat(db);
          expect(info.isFile()).toBe(true);
          expect(info.mode & 0o777).toBe(0o600);
          const restored = await start(backupBuild, db, key, false);
          servers.push(restored);
          return restored;
        },
      });
    } finally {
      try {
        const results = await Promise.allSettled(
          servers.reverse().map((server) => server.stop()),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  request: async ({ isolatedBackup }, use) => {
    const request = await createRequest.newContext({
      baseURL: isolatedBackup.url,
    });
    try {
      await use(request);
    } finally {
      await request.dispose();
    }
  },
  page: async ({ browser, isolatedBackup }, use) => {
    const context = await browser.newContext({ baseURL: isolatedBackup.url });
    try {
      await use(await context.newPage());
    } finally {
      await context.close();
    }
  },
});
export { expect };
