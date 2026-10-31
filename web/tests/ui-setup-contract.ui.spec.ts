import { expect, test, type Page } from "@playwright/test";
import { openWorkspace } from "./ui-session";
import { surfaceMotionState } from "./ui-surface-stability";
import {
  waitForConfirmedWorkspace,
  workspaceConfirmationState,
  WORKSPACE_SETUP_TIMEOUT_MS,
} from "./ui-workspace-confirmation";

async function spinner(
  page: Page,
  options: {
    visible?: boolean;
    busy?: boolean;
    loading?: boolean;
    disabled?: boolean;
    opaque?: boolean;
    finite?: boolean;
    unrelated?: boolean;
    entrance?: boolean;
  } = {},
) {
  await page.setContent(`
    <style>
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes unrelatedMotion { to { transform: rotate(360deg); } }
      @keyframes entrance { from { transform: translateX(1px); } to { transform: none; } }
      [data-loading-decoration] { display: inline-flex; width: ${options.visible ? 16 : 0}px; height: ${options.visible ? 16 : 0}px; opacity: ${options.visible || options.opaque ? 1 : 0}; }
      [data-slot="spinner"] { width: 100%; height: 100%; animation: ${options.unrelated ? "unrelatedMotion" : "spin"} 60s linear ${options.finite ? "2" : "infinite"}; }
      [data-task-overlay] { ${options.entrance ? "animation: entrance 60s linear;" : ""} }
    </style>
    <div data-task-overlay="sheet">
      <section role="dialog"><button data-loading="${!!options.loading}" aria-busy="${!!options.busy}" ${options.disabled ? "disabled" : ""}>
        <span data-loading-decoration><span data-slot="spinner"></span></span>保存集合
      </button></section>
    </div>`);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  // These are actual running Chromium CSS animations, not a mocked WAAPI list.
  expect(
    await page
      .locator("[data-slot='spinner']")
      .evaluate((el) =>
        el.getAnimations().some((a) => a.playState === "running"),
      ),
  ).toBe(true);
}

test("setup helper: completed transparent zero-area loading decoration is not surface motion", async ({
  page,
}) => {
  await spinner(page);
  expect(await page.getByRole("dialog").evaluate(surfaceMotionState)).toEqual({
    opacity: "1",
    preparing: false,
    running: false,
  });
});

test("setup helper: visible opaque busy loading or disabled spinners still block stability", async ({
  page,
}) => {
  for (const options of [
    { visible: true },
    { opaque: true },
    { busy: true },
    { loading: true },
    { disabled: true },
  ]) {
    await spinner(page, options);
    expect(
      await page.getByRole("dialog").evaluate(surfaceMotionState),
      JSON.stringify(options),
    ).toEqual({ opacity: "1", preparing: false, running: true });
  }
});

test("setup helper: finite loading unrelated infinite and real entrance motion still block stability", async ({
  page,
}) => {
  for (const options of [
    { finite: true },
    { unrelated: true },
    { entrance: true },
  ]) {
    await spinner(page, options);
    expect(
      (await page.getByRole("dialog").evaluate(surfaceMotionState)).running,
      JSON.stringify(options),
    ).toBe(true);
  }
});

test("setup helper: only a confirmed visible workspace qualifies, not stale headings or recovery errors", async ({
  page,
}) => {
  const markup =
    '<div data-session-workspace aria-busy="false"><h1>我的订阅</h1><div role="alert">Ordinary business error</div></div>';
  await page.setContent(markup);
  expect(await page.evaluate(workspaceConfirmationState)).toBe("confirmed");
  for (const attribute of ["hidden", "inert", "aria-busy", "aria-hidden"]) {
    await page.setContent(markup);
    await page
      .locator("[data-session-workspace]")
      .evaluate((el, name) => el.setAttribute(name, "true"), attribute);
    expect(await page.evaluate(workspaceConfirmationState), attribute).toBe(
      false,
    );
  }
  await page.setContent(
    markup +
      '<div role="region" aria-label="恢复登录"><div role="alert">Explicit session error</div></div>',
  );
  expect(await page.evaluate(workspaceConfirmationState)).toBe("session-error");
  const started = Date.now();
  await expect(waitForConfirmedWorkspace(page)).rejects.toThrow(
    "explicit session-recovery error",
  );
  expect(Date.now() - started).toBeLessThan(5000);
});

test("setup helper: real cold workspace waits for complete delayed session confirmation beyond 5s", async ({
  page,
}) => {
  await openWorkspace(page);
  let delayed = 0;
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    delayed++;
    // Named protocol delay, not a stabilization sleep: headers and body remain
    // unavailable until the complete legitimate response is fulfilled.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.fulfill({ response });
  });
  await page.reload();
  const started = Date.now();
  await waitForConfirmedWorkspace(page, "cold-workspace");
  expect(delayed).toBeGreaterThan(0);
  expect(Date.now() - started).toBeGreaterThan(5000);
  expect(Date.now() - started).toBeLessThan(WORKSPACE_SETUP_TIMEOUT_MS);
  await expect(
    page.getByRole("heading", { name: "我的订阅", exact: true }),
  ).toBeVisible();
});

test("setup helper: real session 503 fails early without retry or mistaking business errors for login", async ({
  page,
}) => {
  await openWorkspace(page);
  let requests = 0;
  await page.route("**/api/auth/me", async (route) => {
    requests++;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Synthetic unavailable session confirmation",
      }),
    });
  });
  await page.reload();
  const started = Date.now();
  await expect(waitForConfirmedWorkspace(page)).rejects.toThrow(
    "explicit session-recovery error",
  );
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(
    page.getByRole("region", { name: "恢复登录" }).getByRole("alert"),
  ).toBeVisible();
  // Count only helper-owned effects, not the development app's startup checks.
  // Calling it at an explicit recovery error must neither reconnect nor retry.
  expect(requests).toBeGreaterThan(0);
  const beforeConfirmation = requests;
  await expect(waitForConfirmedWorkspace(page)).rejects.toThrow(
    "explicit session-recovery error",
  );
  expect(requests).toBe(beforeConfirmation);
  await expect(
    page.locator('[data-session-workspace][aria-busy="false"]'),
  ).toHaveCount(0);
});
