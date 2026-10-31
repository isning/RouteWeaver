import { test as base } from "@playwright/test";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { ownNativeBrowserProcess } from "./native-browser-process";
const processEnvChromium = () =>
  globalThis.process.env.ROUTEWEAVER_CHROMIUM || chromium.executablePath();
export const test = base.extend({
  context: async ({}, use, info) => {
    // The public noDefaults CDP option avoids Playwright's forced-focus override.
    // Explicit CDP off-the-record targets keep invite URLs/cookies out of disk history.
    const dir = await mkdtemp("/tmp/routeweaver-native-focus-");
    const process = spawn(
      processEnvChromium(),
      [
        "--headless=new",
        "--incognito",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let browser:
      Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    const closeProcess = ownNativeBrowserProcess(process, dir);
    let control:
      | Awaited<ReturnType<NonNullable<typeof browser>["newBrowserCDPSession"]>>
      | undefined;
    const errors: unknown[] = [];
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = "";
        process.stderr.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) resolve(match[1]);
        });
        process.on("error", reject);
        process.on("exit", (code) =>
          reject(new Error(`Local browser exited (${code})`)),
        );
      });
      browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      const context = browser.contexts()[0];
      const browserControl = await browser.newBrowserCDPSession();
      control = browserControl;
      const { browserContextId } = await browserControl.send(
        "Target.createBrowserContext",
        { disposeOnDetach: true },
      );
      // Externally-created OTR targets are observed by the noDefaults connection's
      // default context. Create all test tabs in this single real OTR scope.
      context.newPage = async () => {
        const next = context.waitForEvent("page");
        await browserControl.send("Target.createTarget", {
          url: "about:blank",
          browserContextId,
        });
        const page = await next;
        const cdp = await context.newCDPSession(page);
        const { targetInfo } = await cdp.send("Target.getTargetInfo");
        if (targetInfo.browserContextId !== browserContextId)
          throw new Error("Test tab not isolated in ephemeral browser context");
        return page;
      };
      await use(context);
      await browserControl.send("Target.disposeBrowserContext", {
        browserContextId,
      });
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        // Closing a connectOverCDP Browser only disconnects Playwright. Ask the
        // owned browser to shut down gracefully while its CDP session is alive.
        const result = await closeProcess(
          control ? () => control!.send("Browser.close") : undefined,
        );
        await info.attach("native-browser-shutdown", {
          body: JSON.stringify({
            ...result,
            stdioClosed: true,
            profileRemoved: true,
          }),
          contentType: "application/json",
        });
      } catch (error) {
        errors.push(error);
      }
      try {
        await browser?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(
        errors,
        "Native browser task and cleanup failed",
      );
  },
});
