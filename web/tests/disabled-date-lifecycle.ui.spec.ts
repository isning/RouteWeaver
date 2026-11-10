import { test as base, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const test = base.extend<{}, { fixtureDirectory: string }>({
  fixtureDirectory: [
    async ({}, use) => {
      const directory = await mkdtemp(
        join(tmpdir(), "routeweaver-disabled-date-"),
      );
      try {
        await promisify(execFile)(
          process.execPath,
          [
            join(web, "node_modules/vite/bin/vite.js"),
            "build",
            "--config",
            "tests/disabled-date-sample/vite.config.ts",
            "--outDir",
            directory,
          ],
          { cwd: web, timeout: 120000 },
        );
        await use(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 150000 },
  ],
});
test.use({
  reducedMotion: "no-preference",
  trace: "off",
  screenshot: "off",
  video: "off",
});

test("component fixture: disabled date retirement survives immediate re-enable and newer focus", async ({
  page,
  fixtureDirectory,
}) => {
  // Serve compiled production components through a private synthetic origin, no
  // app endpoint, backend state, replacement CSS, mock Radix or animation controls.
  const unexpectedRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin !== "https://disabled-date.invalid" ||
      request.method() !== "GET"
    ) {
      unexpectedRequests.push(`${request.method()} ${request.url()}`);
      return route.abort();
    }
    const pathname = url.pathname;
    const path = resolve(
      fixtureDirectory,
      `.${pathname === "/" ? "/tests/disabled-date-sample/index.html" : pathname}`,
    );
    if (!path.startsWith(fixtureDirectory + sep)) return route.abort();
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
    };
    await route.fulfill({
      body: await readFile(path),
      contentType: mime[extname(path)] ?? "application/octet-stream",
    });
  });
  await page.goto("https://disabled-date.invalid/");
  const value = "2026-02-03T04:05:06.123456789+05:30";
  const field = page.getByLabel("到期时间", { exact: true });
  await field.click();
  const picker = page.getByRole("dialog", { name: "选择日期与时间" });
  await expect(picker).toBeVisible();
  await page.getByLabel("时间（UTC+8）", { exact: true }).fill("23:10:15");
  await expect(page.getByTestId("pending")).toHaveText("true");
  // Register before changing the owner. Inspect in animationstart itself so the
  // normal 100ms exit cannot finish between Playwright round trips.
  const exit = await page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const popup = document.querySelector<HTMLElement>(
          '[data-slot="popover-content"]',
        )!;
        const confirm = [...popup.querySelectorAll("button")].find(
          (button) => button.textContent === "确定",
        )!;
        const time =
          popup.querySelector<HTMLInputElement>('input[type="time"]')!;
        popup.addEventListener("animationstart", function start(event) {
          if (event.target !== popup || popup.dataset.state !== "closed")
            return;
          popup.removeEventListener("animationstart", start);
          const newer = document.getElementById("new-task")!;
          newer.focus();
          // Attempt the stale native button and focus path while real exit is retained.
          confirm.click();
          confirm.focus();
          const snapshot = {
            retained: popup.isConnected,
            inert: popup.inert,
            hidden: popup.getAttribute("aria-hidden"),
            confirmDisabled: confirm.disabled,
            timeDisabled: time.disabled,
            ownerReenabled: !document.querySelector<HTMLInputElement>(
              'input[aria-haspopup="dialog"]',
            )!.disabled,
            focusStayed: document.activeElement === newer,
            stored: document.querySelector('[data-testid="stored"]')!
              .textContent,
            pending: document.querySelector('[data-testid="pending"]')!
              .textContent,
            animationName: getComputedStyle(popup).animationName,
          };
          popup.addEventListener("animationend", function finish(end) {
            if (
              end.target !== popup ||
              end.animationName !== event.animationName
            )
              return;
            popup.removeEventListener("animationend", finish);
            resolve(snapshot);
          });
        });
        // Prop-driver only: avoid an outside pointer dismissal preceding disable.
        document.getElementById("disable-owner")!.click();
      }),
  );
  expect(exit).toMatchObject({
    retained: true,
    inert: true,
    hidden: "true",
    confirmDisabled: true,
    timeDisabled: true,
    ownerReenabled: true,
    focusStayed: true,
    stored: value,
    pending: "false",
  });
  expect(exit.animationName).not.toBe("none");
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "选择日期与时间" }),
  ).toHaveCount(0);
  // Flush the native deferred FocusScope cleanup before checking its outcome.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(
          () =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          0,
        ),
      ),
  );
  await expect(page.getByRole("button", { name: "Newer task" })).toBeFocused();
  await expect(page.getByTestId("changes")).toHaveText("0");
  await field.click();
  await expect(page.getByLabel("时间（UTC+8）", { exact: true })).toHaveValue(
    "06:35:06",
  );
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("submitted")).toHaveText(value);
  expect(unexpectedRequests).toEqual([]);
  await expect(page.getByTestId("changes")).toHaveText("0");
});
