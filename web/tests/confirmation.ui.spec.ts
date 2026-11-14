import { test, expect, type Page } from "@playwright/test";
import { waitForConfirmedWorkspace } from "./ui-workspace-confirmation";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("routeweaver");
  await page.getByLabel("密码", { exact: true }).fill("local-demo-password");
  await page.getByRole("button", { name: "进入工作空间" }).click();
  await waitForConfirmedWorkspace(page, "normal-ui-login");
  await expect(
    page.getByRole("heading", { name: "概览", exact: true }),
  ).toBeVisible();
}
for (const width of [390, 320])
  test(`collection cancellation has 44px targets at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    await page.goto("/#collections");
    await page
      .getByRole("button", { name: "新建集合", exact: true })
      .first()
      .click();
    const drawer = page.getByRole("dialog", { name: "新建集合", exact: true });
    await drawer.getByLabel("集合名称").fill("未保存的合成集合");
    await drawer.getByRole("button", { name: "关闭", exact: true }).click();
    const confirm = page.getByRole("alertdialog", {
      name: "放弃尚未保存的集合修改？",
    });
    await expect(confirm).toBeVisible();
    const cancel = confirm.getByRole("button", {
      name: "继续编辑",
      exact: true,
    });
    await expect(cancel).toBeFocused();
    // Wait for the default action to become stable and actionable without
    // activating it; initial visibility can precede the scale-in transition.
    await cancel.click({ trial: true });
    await expect
      .poll(() =>
        confirm.evaluate((el) => ({
          opacity: getComputedStyle(el).opacity,
          preparing: /(?:appear|enter)(?:-|\s|$)/.test(el.className),
          running: el
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        })),
      )
      .toEqual({ opacity: "1", preparing: false, running: false });
    const dimensions = await confirm
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((b) => ({
          text: b.textContent,
          width: b.getBoundingClientRect().width,
          height: b.getBoundingClientRect().height,
          left: b.getBoundingClientRect().left,
          top: b.getBoundingClientRect().top,
          marginInlineStart: getComputedStyle(b).marginInlineStart,
        })),
      );
    console.log("CONFIRM_GEOMETRY", JSON.stringify({ width, dimensions }));
    for (const b of dimensions)
      expect.soft(b.height).toBeGreaterThanOrEqual(44);
    for (const b of dimensions) expect.soft(b.marginInlineStart).toBe("0px");
    if (width === 320) expect.soft(dimensions[0].left).toBe(dimensions[1].left);
    await expect
      .poll(() =>
        confirm.evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter((a) => a.playState === "running").length,
        ),
      )
      .toBe(0);
    await expect(confirm).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("collection-confirmation-mobile.png"),
    });
    await cancel.click();
    await expect(drawer.getByLabel("集合名称")).toHaveValue("未保存的合成集合");
  });
test("rule import visible label focuses and types into its own visible field", async ({
  page,
}) => {
  await login(page);
  await page.goto("/#resources");
  await page
    .getByRole("button", { name: "导入规则文件", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "导入规则文件",
    exact: true,
  });
  const label = dialog.locator("label").filter({ hasText: "导入资源名称" });
  const field = dialog.getByRole("textbox", { name: "导入资源名称" });
  await label.click();
  await expect(field).toBeFocused();
  expect(
    await label.evaluate(
      (el) => (el as HTMLLabelElement).control === document.activeElement,
    ),
  ).toBe(true);
  await page.keyboard.type("Synthetic rules");
  await expect(field).toHaveValue("Synthetic rules");
});
