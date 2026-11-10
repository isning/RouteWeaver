import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureNativeFocusPair } from "./focus-paint-evidence";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
// A private test-owned static sampler, not a new app route or public endpoint.
const test = base.extend<{}, { sampleURL: string }>({
  sampleURL: [
    async ({}, use) => {
      const directory = await mkdtemp(
        join(tmpdir(), "routeweaver-focus-sample-"),
      );
      const server = createServer(async (request, response) => {
        try {
          const pathname = decodeURIComponent(
            new URL(request.url ?? "/", "http://localhost").pathname,
          );
          const path = resolve(
            directory,
            `.${pathname === "/" ? "/tests/focus-sample/index.html" : pathname}`,
          );
          if (!path.startsWith(directory + sep)) {
            response.writeHead(403).end();
            return;
          }
          const mime: Record<string, string> = {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".woff2": "font/woff2",
          };
          const body = await readFile(path);
          response
            .writeHead(200, {
              "Content-Type": mime[extname(path)] ?? "application/octet-stream",
            })
            .end(body);
        } catch {
          response.writeHead(404).end();
        }
      });
      try {
        await execute(
          process.execPath,
          [
            join(web, "node_modules/vite/bin/vite.js"),
            "build",
            "--config",
            "tests/focus-sample/vite.config.ts",
            "--outDir",
            directory,
          ],
          { cwd: web, timeout: 120000 },
        );
        await new Promise<void>((done, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", done);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing sampler address");
        await use(`http://127.0.0.1:${address.port}`);
      } finally {
        if (server.listening)
          await new Promise<void>((done, reject) =>
            server.close((error) => (error ? reject(error) : done())),
          );
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 150000 },
  ],
});
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
});
async function tabTo(page: Page, target: Locator) {
  const stops = await page
    .locator("a[href],button,input,select,textarea,[tabindex]")
    .count();
  for (let step = 0; step <= stops; step++) {
    if (await target.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}
for (const theme of ["light", "dark"]) {
  test(`shared focus samples on desktop ${theme} surfaces`, async ({
    page,
    sampleURL,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${sampleURL}/?theme=${theme}`);
    await expect(
      page.getByRole("heading", { name: `Synthetic focus samples (${theme})` }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const samples: [string, Locator][] = [
      [
        "outline",
        page.getByRole("button", { name: "Outline sample", exact: true }),
      ],
      [
        "primary",
        page.getByRole("button", { name: "Primary sample", exact: true }),
      ],
      [
        "destructive",
        page.getByRole("button", { name: "Destructive sample", exact: true }),
      ],
      ["input", page.getByLabel("Name sample", { exact: true })],
      [
        "invalid-input",
        page.getByLabel("Invalid name sample", { exact: true }),
      ],
      [
        "unchecked",
        page.getByRole("checkbox", { name: "Unchecked sample", exact: true }),
      ],
      [
        "checked",
        page.getByRole("checkbox", { name: "Checked sample", exact: true }),
      ],
      [
        "invalid-checkbox",
        page.getByRole("checkbox", {
          name: "Invalid checkbox sample",
          exact: true,
        }),
      ],
      [
        "active-tab",
        page.getByRole("tab", { name: "Active sample tab", exact: true }),
      ],
      [
        "muted-outline",
        page.getByRole("button", { name: "Muted outline sample", exact: true }),
      ],
      ["muted-input", page.getByLabel("Muted name sample", { exact: true })],
      [
        "sidebar",
        page.getByRole("button", { name: "Sidebar sample", exact: true }),
      ],
    ];
    for (const [name, target] of samples) {
      await tabTo(page, target);
      await captureNativeFocusPair(
        page,
        target,
        info,
        `focus-sample-${theme}-${name}`,
      );
    }
    await tabTo(
      page,
      page.getByRole("tab", { name: "Active sample tab", exact: true }),
    );
    await page.keyboard.press("ArrowRight");
    const inactive = page.getByRole("tab", {
      name: "Inactive sample tab",
      exact: true,
    });
    await expect(inactive).toHaveAttribute("aria-selected", "false");
    await captureNativeFocusPair(
      page,
      inactive,
      info,
      `focus-sample-${theme}-inactive-tab`,
      { leave: "ArrowLeft", return: "ArrowRight" },
    );
    await expect(inactive).toHaveAttribute("aria-selected", "false");
    await expect(
      page.getByRole("checkbox", { name: "Unchecked sample", exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Checked sample", exact: true }),
    ).toBeChecked();
    expect(errors).toEqual([]);
    await info.attach(`focus-sample-${theme}-scope`, {
      contentType: "application/json",
      body: JSON.stringify({
        scope:
          "Synthetic actual shared components, native focus, desktop; screenshots for review, not compliance assertions. App layout and dark/destructive/sidebar contrast are not repaired by the light ring change.",
        samples: [...samples.map(([name]) => name), "inactive-tab"],
      }),
    });
  });
}
