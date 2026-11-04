import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openWorkspace } from "./ui-session";

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error(
    "Source action was not reachable through ordinary Tab traversal",
  );
}

async function settledMenu(menu: Locator) {
  await expect(menu).toBeVisible();
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const popup = element.closest('[data-slot="dropdown-menu-content"]')!;
        return (
          !/(?:appear|enter|leave)-(?:prepare|start|active)/.test(
            popup.className,
          ) &&
          !popup
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running")
        );
      }),
    )
    .toBe(true);
}

for (const width of [1280, 390]) {
  test(`source menu preserves keyboard context and safe deletion handoff at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await openWorkspace(page);
    const auth = await page.request.get("/api/auth/me");
    expect(auth.ok()).toBe(true);
    const headers = { "X-CSRF-Token": (await auth.json()).csrfToken };
    const suffix = Date.now().toString(36);
    const created: string[] = [];
    let deletionRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        request.url().includes("/api/me/sources/")
      )
        deletionRequests += 1;
    });
    try {
      for (const letter of ["A", "B"]) {
        const id = `menu-regression-${suffix}-${letter}`;
        const response = await page.request.post("/api/me/sources", {
          headers,
          data: {
            id,
            name: `菜单键盘 ${letter}`,
            kind: "text",
            enabled: true,
            content: `socks5://synthetic-menu-${letter.toLowerCase()}.example:1080#Keyboard menu`,
          },
        });
        expect(response.ok()).toBe(true);
        created.push(id);
      }
      await page.goto("/#sources");
      const triggers = page.getByRole("button", {
        name: /^更多操作 菜单键盘 /,
      });
      await expect(triggers).toHaveCount(2);
      const trigger = triggers.first();
      const firstName = (await trigger.getAttribute("aria-label"))!.replace(
        "更多操作 ",
        "",
      );
      const nextName = (await triggers
        .nth(1)
        .getAttribute("aria-label"))!.replace("更多操作 ", "");
      const nextSource = page.getByRole("button", {
        name: new RegExp(`^${nextName}\\s*文本导入$`),
      });
      const previousAction = page.getByRole("button", {
        name: new RegExp(`^${firstName}\\s*文本导入$`),
      });
      const menu = page.getByRole("menu");
      const sourceMenu = page.getByRole("menu", {
        name: `更多操作 ${firstName}`,
        exact: true,
        includeHidden: true,
      });
      await page.evaluate(() => {
        const state = window as unknown as {
          sourceMenuEvents: unknown[];
          sourceMenuPhase: string;
        };
        state.sourceMenuEvents = [];
        state.sourceMenuPhase = "initial tab traversal";
        const describe = (element: Element | null) =>
          element && {
            tag: element.tagName,
            role: element.getAttribute("role"),
            name: element.getAttribute("aria-label"),
            id: element.id,
            connected: element.isConnected,
          };
        const record = (kind: string, event: Event) => {
          state.sourceMenuEvents.push({
            kind,
            phase: state.sourceMenuPhase,
            at: performance.now(),
            key: (event as KeyboardEvent).key,
            defaultPrevented: event.defaultPrevented,
            target: describe(
              event.target instanceof Element ? event.target : null,
            ),
            active: describe(document.activeElement),
            menus: Array.from(document.querySelectorAll('[role="menu"]')).map(
              (element) => ({
                ...describe(element),
                visible: (element as HTMLElement).checkVisibility(),
                items: element.querySelectorAll('[role="menuitem"]').length,
              }),
            ),
          });
        };
        for (const kind of ["focusin", "focusout"])
          document.addEventListener(kind, (event) => record(kind, event), true);
        document.addEventListener(
          "keydown",
          (event) => {
            record("keydown-capture", event);
            requestAnimationFrame(() => record("keydown-next-frame", event));
          },
          true,
        );
        document.addEventListener("keydown", (event) =>
          record("keydown-bubble", event),
        );
      });
      const firstItem = page.getByRole("menuitem", {
        name: `刷新 ${firstName}`,
        exact: true,
      });
      const editItem = page.getByRole("menuitem", {
        name: `编辑 ${firstName}`,
        exact: true,
      });
      const item = page.getByRole("menuitem", {
        name: "删除来源",
        exact: true,
      });
      const open = async (key: string) => {
        await page.keyboard.press(key);
        await settledMenu(menu);
        await expect(
          firstItem,
          "Opening by keyboard enters the first source action",
        ).toBeFocused();
        await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const menuId = await trigger.getAttribute("aria-controls");
        expect(menuId).toBeTruthy();
        await expect(menu).toHaveAttribute("id", menuId!);
      };

      await tabTo(page, trigger);
      for (const opener of ["Enter", "Space"]) {
        await page.evaluate((phase) => {
          (window as unknown as { sourceMenuPhase: string }).sourceMenuPhase =
            phase;
        }, `${width}px ${opener} arrow-escape loop`);
        await open(opener);
        if (opener === "Enter")
          await page.screenshot({
            path: info.outputPath(`source-menu-${width}-focused.png`),
          });
        await page.keyboard.press("ArrowDown");
        await expect(editItem).toBeFocused();
        await page.keyboard.press("ArrowUp");
        await expect(firstItem).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).not.toBeVisible();
        await expect(
          sourceMenu,
          "Closed source menu is removed, not merely hidden",
        ).toHaveCount(0);
        await expect(
          trigger,
          "Escape returns to the same source action",
        ).toBeFocused();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
      }

      // An arrow key schedules vendor focus work; an immediate dismissal must
      // not let that work steal focus back into a closing menu.
      await open("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      await expect(menu).not.toBeVisible();
      await expect(
        sourceMenu,
        "Closed source menu is removed, not merely hidden",
      ).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await open("Enter");
      await page.keyboard.press("Tab");
      await expect(menu).not.toBeVisible();
      await expect(
        sourceMenu,
        "Closed source menu is removed, not merely hidden",
      ).toHaveCount(0);
      await expect(
        nextSource,
        "Tab continues past the source action",
      ).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(trigger).toBeFocused();
      await open("Space");
      await page.keyboard.press("Shift+Tab");
      await expect(menu).not.toBeVisible();
      await expect(
        sourceMenu,
        "Closed source menu is removed, not merely hidden",
      ).toHaveCount(0);
      await expect(
        previousAction,
        "Shift+Tab returns to the source identity",
      ).toBeFocused();

      await trigger.click();
      await settledMenu(menu);
      const search = page.getByRole("textbox", {
        name: "搜索来源",
        exact: true,
      });
      await search.click();
      await expect(menu).not.toBeVisible();
      await expect(
        sourceMenu,
        "Closed source menu is removed, not merely hidden",
      ).toHaveCount(0);
      await expect(
        search,
        "Outside pointer dismissal must not steal focus",
      ).toBeFocused();

      await tabTo(page, trigger);
      await open("Enter");
      await page.keyboard.press("End");
      await expect(item).toBeFocused();
      await page.keyboard.press("Enter");
      const confirm = page.getByRole("alertdialog", {
        name: `删除「${firstName}」？`,
        exact: true,
      });
      await expect(confirm).toBeVisible();
      await expect(
        confirm.getByRole("button", { name: "保留来源", exact: true }),
      ).toBeFocused();
      await expect(menu).not.toBeVisible();
      await expect(
        sourceMenu,
        "Closed source menu is removed, not merely hidden",
      ).toHaveCount(0);
      // The alert dialog correctly conceals background controls. Inspect the
      // closed internal state by exact identity, then verify public focus after cancel.
      await expect(
        page.getByRole("button", {
          name: `更多操作 ${firstName}`,
          exact: true,
          includeHidden: true,
        }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(
        deletionRequests,
        "Selecting delete only opens review, never deletes before consent",
      ).toBe(0);
      await page.keyboard.press("Escape");
      await expect(confirm).not.toBeVisible();
      await expect(
        trigger,
        "Canceling deletion returns to the source opener",
      ).toBeFocused();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(menu).not.toBeVisible();
      await expect(
        sourceMenu,
        "Closed source menu is removed, not merely hidden",
      ).toHaveCount(0);
      expect(deletionRequests).toBe(0);
      await open("Enter");
      await page.keyboard.press("ArrowDown");
      await expect(editItem).toBeFocused();
      await page.keyboard.press("Enter");
      const editor = page.getByRole("dialog", {
        name: "编辑来源",
        exact: true,
      });
      await expect(editor).toBeVisible();
      await expect(menu).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(editor).not.toBeVisible();
      await expect(
        trigger,
        "Closing source editing returns to its row menu opener",
      ).toBeFocused();
      const sources = await page.request.get("/api/me/sources");
      expect(sources.ok()).toBe(true);
      const retained = (await sources.json()).map(
        (source: { id: string }) => source.id,
      );
      for (const id of created) expect(retained).toContain(id);
      await page.screenshot({
        path: info.outputPath(`source-menu-${width}-after-cancel.png`),
      });
    } finally {
      const eventPath = info.outputPath("source-menu-lifecycle-events.json");
      await writeFile(
        eventPath,
        JSON.stringify(
          await page.evaluate(() => ({
            events:
              (window as unknown as { sourceMenuEvents?: unknown[] })
                .sourceMenuEvents || [],
            finalActive: {
              tag: document.activeElement?.tagName,
              role: document.activeElement?.getAttribute("role"),
              name: document.activeElement?.getAttribute("aria-label"),
              id: document.activeElement?.id,
            },
            remainingMenus: document.querySelectorAll('[role="menu"]').length,
          })),
          null,
          2,
        ),
      );
      await info.attach("source-menu-lifecycle-events", {
        path: eventPath,
        contentType: "application/json",
      });
      for (const id of created) {
        const response = await page.request.delete(`/api/me/sources/${id}`, {
          headers,
        });
        expect(response.ok(), "Owned synthetic source cleanup").toBe(true);
      }
    }
  });
}
