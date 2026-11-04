import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Reach a source's secondary action through the same menu a user opens. */
export async function sourceRowAction(action: "刷新" | "编辑", name: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: `更多操作 ${name}` }),
  );
  return screen.findByRole("menuitem", { name: `${action}来源 ${name}` });
}
