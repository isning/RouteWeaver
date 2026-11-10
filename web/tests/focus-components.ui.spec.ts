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
        "invalid-checked",
        page.getByRole("checkbox", {
          name: "Invalid checked sample",
          exact: true,
        }),
      ],
      [
        "invalid-unchecked-card",
        page.getByRole("checkbox", {
          name: "Invalid unchecked card sample",
          exact: true,
        }),
      ],
      [
        "invalid-checked-card",
        page.getByRole("checkbox", {
          name: "Invalid checked card sample",
          exact: true,
        }),
      ],
      [
        "invalid-plain-label",
        page.getByRole("checkbox", {
          name: "Invalid plain label sample",
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
      const paint = await captureNativeFocusPair(
        page,
        target,
        info,
        `focus-sample-${theme}-${name}`,
      );
      if (name === "sidebar" || name === "destructive") {
        // Inspect actual screenshot pixels at a straight edge, avoiding
        // rounded-corner antialiasing. Computed tokens alone miss compositing.
        const screenshot = await page.screenshot({ fullPage: false, scale: "css" });
        await info.attach(`focus-sample-${theme}-${name}-measured.png`, {
          body: screenshot, contentType: "image/png",
        });
        const png = screenshot.toString("base64");
        const pixels = await page.evaluate(async ({ png, rect, name }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          const scale = image.naturalWidth / innerWidth;
          const read = (x: number, y: number) => Array.from(context.getImageData(
            Math.floor(x * scale),
            Math.floor(y * scale),
            1, 1,
          ).data).slice(0, 3);
          // The destructive button sits close to a sibling. Use the top
          // midpoint so another button's halo cannot contaminate the sample.
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          return name === "destructive"
            ? { ring: read(x, rect.y - 1), background: read(x, rect.y - 5), border: read(x, Math.ceil(rect.y)) }
            : { ring: read(rect.x - 1, y), background: read(rect.x - 4, y) };
        }, { png, rect: paint.after.target.rect, name });
        const luminance = (rgb: number[]) => rgb.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        const a = luminance(pixels.ring), b = luminance(pixels.background);
        const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        await info.attach(`focus-sample-${theme}-${name}-pixels`, {
          body: JSON.stringify({ ...pixels, contrast }), contentType: "application/json",
        });
        expect(contrast, `${name} keyboard focus against its adjacent background`).toBeGreaterThanOrEqual(3);
        expect(paint.after.target.rect.width).toBe(paint.before.target.rect.width);
        expect(paint.after.target.rect.height).toBe(paint.before.target.rect.height);
        expect(paint.after.target.shadow).not.toBe(paint.before.target.shadow);
      }
      if (
        name === "invalid-checkbox" ||
        name === "invalid-checked" ||
        name === "invalid-plain-label"
      ) {
        // The saved pre-fix actual snapshots fail this public painted-state
        // assertion: their invalid shadow is identical before/after native Tab.
        expect(paint.after.target.shadow).not.toBe(paint.before.target.shadow);
        expect(paint.after.target.shadow).toMatch(
          /(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/,
        );
        expect(paint.after.target.border).toEqual(paint.before.target.border);
        if (name === "invalid-plain-label") {
          const label = paint.after.ancestors.find(
            (node) => node.slot === "field-label",
          );
          expect(label).toBeDefined();
          expect(label!.shadow).toBe("none");
        }
        expect(paint.after.target.rect.width).toBe(
          paint.before.target.rect.width,
        );
        expect(paint.after.target.rect.height).toBe(
          paint.before.target.rect.height,
        );
        await expect(target).toHaveAttribute("aria-invalid", "true");
        await expect(target).toBeChecked({
          checked: name === "invalid-checked",
        });
      }
      if (name.endsWith("-card")) {
        const beforeOwner = paint.before.ancestors.find(
          (node) => node.slot === "field-label",
        );
        const afterOwner = paint.after.ancestors.find(
          (node) => node.slot === "field-label",
        );
        expect(beforeOwner).toBeDefined();
        expect(afterOwner).toBeDefined();
        expect(afterOwner!.shadow).not.toBe(beforeOwner!.shadow);
        expect(afterOwner!.shadow).toMatch(/(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/);
        // The composed label owns focus, without a second checkbox halo.
        expect(paint.after.target.shadow).not.toMatch(
          /(?:^|\s)0px 0px 0px 3px(?:\s|,|$)/,
        );
        const errorBorder = await page
          .getByRole("checkbox", {
            name: "Invalid checkbox sample",
            exact: true,
          })
          .evaluate((element) => getComputedStyle(element).borderTopColor);
        expect(paint.after.target.border[0].color).toBe(errorBorder);
        expect(afterOwner!.rect.width).toBe(beforeOwner!.rect.width);
        expect(afterOwner!.rect.height).toBe(beforeOwner!.rect.height);
        await expect(target).toHaveAttribute("aria-invalid", "true");
        await expect(target).toBeChecked({
          checked: name === "invalid-checked-card",
        });
      }
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
          "Synthetic actual shared components, native focus, desktop. Bounded sidebar/destructive pixel contrast and checkbox focus assertions, not whole-app compliance. Both destructive themes are sampled; app layout and other dark focus treatments remain outside these repairs.",
        samples: [...samples.map(([name]) => name), "inactive-tab"],
      }),
    });
  });
}
