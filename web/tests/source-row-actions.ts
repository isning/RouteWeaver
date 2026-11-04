import type { Page } from "@playwright/test";

/** Open the row menu before returning its named action. */
export async function sourceRowAction(
  page: Page,
  action: "刷新" | "编辑",
  name: string,
) {
  await page
    .getByRole("button", { name: `更多操作 ${name}`, exact: true })
    .click();
  return page.getByRole("menuitem", { name: `${action} ${name}`, exact: true });
}
