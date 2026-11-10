import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./isolated-control-plane-fixture";
import { activate, Inventory, read, signIn } from "./uiux-inventory-helper";

// Native acceptance against the production-built App and fresh normal CLI DB.
// No seeds, mocked responses, inventory writes or application/runtime actions.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  reducedMotion: "no-preference",
  serviceWorkers: "block",
});
const inventoryPaths = [
  "/hosts",
  "/core-instances",
  "/managed-endpoints",
  "/links",
  "/server-deployments",
];
const editors = [
  { kind: "host", title: "添加服务器", field: "服务器名称", tab: null },
  {
    kind: "core",
    title: "添加核心实例",
    field: "所属服务器",
    tab: "核心实例 0",
  },
  {
    kind: "listener",
    title: "添加监听端点",
    field: "端点名称",
    tab: "监听端点 0",
  },
] as const;

async function emptyInventory(page: Page) {
  // Browser routing does not intercept page.request. This helper only GETs
  // the five public inventory endpoints; never use a write/setup helper here.
  for (const path of inventoryPaths)
    expect(await read(page.request, path), path).toEqual([]);
}
async function defaults(
  dialog: Locator,
  kind: (typeof editors)[number]["kind"],
) {
  if (kind === "host") {
    for (const name of ["服务器名称", "服务器连接地址", "服务器分组"])
      await expect(
        dialog.getByRole("textbox", { name, exact: true }),
      ).toHaveValue("");
  } else if (kind === "core") {
    await expect(
      dialog.getByRole("combobox", { name: "所属服务器", exact: true }),
    ).toHaveText("请选择");
    await expect(
      dialog.getByRole("textbox", { name: "实例名称", exact: true }),
    ).toHaveValue("");
    await expect(
      dialog.getByRole("combobox", { name: "核心家族", exact: true }),
    ).toHaveText("sing-box");
    await expect(
      dialog.getByRole("combobox", { name: "核心版本", exact: true }),
    ).toHaveText("1.14.4");
  } else {
    await expect(
      dialog.getByRole("combobox", { name: "所属服务器", exact: true }),
    ).toHaveText("选择服务器");
    await expect(
      dialog.getByRole("textbox", { name: "端点名称", exact: true }),
    ).toHaveValue("");
    await expect(
      dialog.getByRole("textbox", { name: "监听 IP", exact: true }),
    ).toHaveValue("0.0.0.0");
    await expect(
      dialog.getByRole("spinbutton", { name: "端口", exact: true }),
    ).toHaveValue("1080");
    await expect(
      dialog.getByRole("combobox", { name: "协议", exact: true }),
    ).toHaveText("SOCKS5");
    await expect(
      dialog.getByRole("textbox", { name: "用户名", exact: true }),
    ).toHaveValue("");
    const password = dialog.getByLabel("密码", { exact: true });
    await expect(password).toHaveValue("");
    await expect(password).toHaveAttribute("type", "password");
    await expect(
      dialog.getByRole("combobox", { name: "所属核心", exact: true }),
    ).toBeDisabled();
  }
}
async function background(page: Page) {
  return page.locator(".route-content").evaluate((content) => {
    const ancestors = [];
    for (
      let node: HTMLElement | null = content as HTMLElement;
      node;
      node = node.parentElement
    )
      ancestors.push({
        tag: node.tagName,
        x: node.scrollLeft,
        y: node.scrollTop,
      });
    return { window: { x: scrollX, y: scrollY }, ancestors };
  });
}
async function geometry(dialog: Locator, field: Locator) {
  const mode = await dialog.getAttribute("data-task-scroll");
  expect(["body", "task"]).toContain(mode);
  // Follow the actual adaptive scroll owner, rather than assuming a fixed footer.
  const scroller =
    mode === "task" ? dialog : dialog.locator("[data-task-overlay-body]");
  const rail = await scroller.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      top: box.top + element.clientTop,
      bottom: box.top + element.clientTop + element.clientHeight,
      offset: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
    };
  });
  const box = await field.boundingBox();
  expect(box).not.toBeNull();
  return { mode, rail, field: box! };
}

for (const width of [1440, 390])
  for (const editor of editors) {
    test(`empty inventory ${editor.kind} invalid Save restores focus at ${width}px`, async ({
      page,
      baseURL,
    }, info) => {
      await page.setViewportSize({
        width,
        height: editor.kind === "listener" ? 560 : 900,
      });
      await signIn(page, baseURL, "admin");
      const origin = new URL(baseURL!).origin;
      const blocked: Array<{ method: string; target: string }> = [];
      // Installed AFTER successful login, BEFORE cold workspace navigation. No
      // request bodies, headers, cookies, session/CSRF material or external URLs
      // enter evidence. Abort all writes, including impact/enrollment/runtime.
      await page.context().route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (
          url.origin !== origin ||
          !["GET", "HEAD"].includes(request.method())
        ) {
          blocked.push({
            method: request.method(),
            target: url.origin === origin ? url.pathname : "external-origin",
          });
          await route.abort("blockedbyclient");
        } else await route.continue();
      });
      const inventory = new Inventory(page, info, "admin", "servers");
      const measurements: unknown[] = [];
      try {
        await page.goto("/#servers");
        await inventory.heading("服务器");
        await emptyInventory(page);
        await inventory.stable();
        if (editor.tab) await inventory.tab(editor.tab);
        const opener = page
          .locator(".page-heading")
          .getByRole("button", { name: editor.title, exact: true });
        for (let attempt = 1; attempt <= 2; attempt++) {
          await activate(page, opener);
          const dialog = page.getByRole("dialog", {
            name: editor.title,
            exact: true,
          });
          await inventory.stable(dialog); // includes settledTask; natural motion stays enabled
          await expect(dialog.getByRole("alert")).toHaveCount(0);
          await defaults(dialog, editor.kind);
          const field = dialog.getByLabel(editor.field, { exact: true });
          const save = dialog.getByRole("button", {
            name: "保存",
            exact: true,
          });
          const cancel = dialog.getByRole("button", {
            name: "取消",
            exact: true,
          });
          expect(
            await save.evaluate((element) => {
              const button = element as HTMLButtonElement;
              return {
                external: button.closest("form") === null,
                associated: !!button.form,
                sameDialog:
                  button.form?.closest('[role="dialog"]') ===
                  button.closest('[role="dialog"]'),
                type: button.type,
              };
            }),
          ).toEqual({
            external: true,
            associated: true,
            sameDialog: true,
            type: "submit",
          });
          const untouchedBackground = await background(page);
          // Native bounded Tab traversal, never focus() the footer or submit via JS.
          await inventory.tabTo(dialog, save);
          const before = await geometry(dialog, field);
          if (editor.kind === "listener") {
            expect(
              before.rail.max,
              "Short listener task really overflows",
            ).toBeGreaterThan(0);
            expect(before.rail.offset).toBeGreaterThan(0);
            expect(
              before.field.y + before.field.height,
              "First field is above the actual scroll clip before invalid Save",
            ).toBeLessThanOrEqual(before.rail.top);
          }
          await info.attach(`${editor.kind}-${width}-${attempt}-before`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          await page.keyboard.press("Enter");
          await expect(field).toBeFocused();
          await expect(field).toHaveAttribute("aria-invalid", "true");
          const error = dialog
            .getByRole("alert")
            .filter({ hasText: `请填写${editor.field}` });
          await expect(error).toHaveCount(1);
          if (editor.kind === "core") {
            await expect(dialog.locator('[aria-invalid="true"]')).toHaveCount(
              1,
            );
            await expect(dialog.getByRole("alert")).toHaveCount(1);
          }
          await expect(error).toHaveText(`请填写${editor.field}`);
          const errorId = await error.getAttribute("id");
          expect(errorId).toBeTruthy();
          expect(
            (await field.getAttribute("aria-describedby"))?.split(/\s+/),
          ).toContain(errorId);
          expect(
            await field.evaluate((element) => element.closest("form") !== null),
          ).toBe(true);
          await inventory.stable(dialog);
          // Reuses the full ancestor clipping intersection, not viewport-only checks.
          await inventory.inView(field);
          await inventory.inView(error);
          await defaults(dialog, editor.kind);
          await expect(dialog).toBeVisible();
          const after = await geometry(dialog, field);
          if (editor.kind === "listener")
            expect(after.rail.offset).toBeLessThan(before.rail.offset);
          expect(await background(page)).toEqual(untouchedBackground);
          await info.attach(`${editor.kind}-${width}-${attempt}-after`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
          measurements.push({
            attempt,
            before,
            after,
            background: untouchedBackground,
            focusedField: editor.field,
            error: `请填写${editor.field}`,
            externalNativeSubmit: true,
          });
          // Footer remains keyboard-reachable after recovery, including task-scroll mode.
          await inventory.tabTo(dialog, save);
          await inventory.tabTo(dialog, cancel);
          await page.keyboard.press("Enter");
          await expect(dialog).toBeHidden();
          await inventory.stable();
          await expect(opener).toBeFocused();
          await expect(page.getByRole("alertdialog")).toHaveCount(0); // untouched, no discard prompt
          await emptyInventory(page);
          expect(
            blocked,
            "No writes or external requests, including impact/enrollment/runtime",
          ).toEqual([]);
        }
        inventory.finish();
      } finally {
        await info.attach("inventory-submit-focus-measurements", {
          contentType: "application/json",
          body: JSON.stringify(
            {
              viewport: page.viewportSize(),
              editor: editor.kind,
              measurements,
              blocked,
              scope:
                "Synthetic empty inventory; two invalid native submits and Cancel per editor. No successful save, live infrastructure, reduced-motion or screen-reader acceptance.",
            },
            null,
            2,
          ),
        });
        expect(
          blocked,
          "Read-only guard must remain intact even if a UI assertion fails",
        ).toEqual([]);
      }
    });
  }
