import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { constants } from "node:fs";

export async function nativeBridge(init: {
  url: string;
  token: string;
  scope: unknown;
}) {
  const executable = process.env.ROUTEWEAVER_BROWSER_NATIVE_HELPER;
  if (
    !executable ||
    !process.env.ROUTEWEAVER_MANAGED_XRAY_BIN ||
    !/^[a-f0-9]{64}$/.test(process.env.ROUTEWEAVER_MANAGED_XRAY_SHA256 || "")
  )
    throw new Error(
      "Explicit exact-source browser/native gate prerequisites required",
    );
  await access(executable, constants.X_OK);
  const child = spawn(
    executable,
    ["-test.run=^TestBrowserNativeBridge$", "-test.timeout=180s", "-test.v"],
    {
      env: { ...process.env, ROUTEWEAVER_BROWSER_NATIVE_BRIDGE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  type Reply = {
    error?: string;
    ready?: boolean;
    state?: any;
    binarySHA256?: string;
    closing?: boolean;
  };
  let waiter:
    { resolve: (v: Reply) => void; reject: (e: Error) => void } | undefined;
  let diagnostic = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.startsWith("RW_BRIDGE ")) {
      let v: Reply;
      try {
        v = JSON.parse(line.slice(10)) as Reply;
      } catch {
        waiter?.reject(new Error("Malformed native bridge reply"));
        waiter = undefined;
        child.kill("SIGTERM");
        return;
      }
      if (!waiter) return;
      const w = waiter;
      waiter = undefined;
      v.error ? w.reject(new Error(v.error)) : w.resolve(v);
    } else diagnostic = (diagnostic + line + "\n").slice(-4096);
  });
  child.stderr.on("data", (b) => {
    diagnostic = (diagnostic + b.toString()).slice(-4096);
  });
  child.stdin.on("error", (error) => {
    waiter?.reject(error);
    waiter = undefined;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const e = new Error(
        `Native bridge exit ${code}/${signal}: ${diagnostic}`,
      );
      if (waiter) {
        waiter.reject(e);
        waiter = undefined;
      }
      code === 0 ? resolve() : reject(e);
    });
  });
  // Observe errors immediately; close() still awaits and propagates the same result.
  exited.catch(() => {});
  async function command(value: object): Promise<Reply> {
    if (waiter) throw new Error("Overlapping native bridge command");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = undefined;
        reject(new Error("Native bridge command deadline"));
      }, 15000);
      waiter = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      child.stdin.write(JSON.stringify(value) + "\n");
    });
  }
  async function waitForExit() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Native bridge cleanup outcome uncertain; private runtime evidence retained: ${diagnostic}`,
                ),
              ),
            20000,
          );
        }),
      ]);
    } catch (error) {
      // Do not blind-kill a runtime with unknown ownership or erase its journal.
      child.kill("SIGTERM");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await command({ action: "close" });
        child.stdin.end();
      } catch (e) {
        child.kill("SIGTERM");
        await waitForExit();
        throw e;
      }
    }
    await waitForExit();
    lines.close();
  };
  try {
    const ready = await command({ action: "init", ...init });
    if (
      !ready.ready ||
      ready.binarySHA256 !== process.env.ROUTEWEAVER_MANAGED_XRAY_SHA256
    )
      throw new Error("Native bridge identity mismatch");
    return { ready, command: (action: string) => command({ action }), close };
  } catch (e) {
    child.kill("SIGTERM");
    try {
      await waitForExit();
    } catch (cleanupError) {
      throw new AggregateError(
        [e, cleanupError],
        "Native bridge initialization failed with uncertain cleanup",
      );
    }
    throw e;
  }
}
