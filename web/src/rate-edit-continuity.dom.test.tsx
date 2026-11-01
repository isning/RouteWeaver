// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RateSettings } from "./Rates";
import { hasUnsavedChanges } from "./navigation";
import type { RouteRecord } from "./types";

const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount() {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, init) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return json({ error: "暂时无法保存倍率，请重试" }, 503);
      }
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <RateSettings
          routes={[{ id: "route", name: "办公线路" } as RouteRecord]}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return writes;
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});

it("preserves changed rates when Escape is canceled, guards navigation, and discards only explicitly", async () => {
  mount();
  const user = userEvent.setup();
  const opener = screen.getByRole("button", { name: "调整倍率" });
  await user.click(opener);
  const dialog = screen.getByRole("dialog", { name: "调整线路扣量倍率" });
  fireEvent.change(within(dialog).getByLabelText("整条线路倍率（×）"), {
    target: { value: "2.5" },
  });
  await user.keyboard("{Escape}");
  const confirmation = screen.queryByRole("alertdialog", {
    name: "放弃未保存的倍率调整？",
  });
  expect(confirmation).not.toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  await user.click(
    within(confirmation!).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    (within(dialog).getByLabelText("整条线路倍率（×）") as HTMLInputElement)
      .value,
  ).toBe("2.5");
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "放弃修改",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "调整线路扣量倍率" }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(hasUnsavedChanges()).toBe(false);
});

it("closes untouched and reverted rates without an extra decision", async () => {
  mount();
  const user = userEvent.setup();
  for (const reverted of [false, true]) {
    await user.click(screen.getByRole("button", { name: "调整倍率" }));
    const dialog = screen.getByRole("dialog", { name: "调整线路扣量倍率" });
    if (reverted) {
      const factor = within(dialog).getByLabelText("整条线路倍率（×）");
      fireEvent.change(factor, { target: { value: "2" } });
      fireEvent.change(factor, { target: { value: "1" } });
    }
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "调整线路扣量倍率" }),
      ).toBeNull(),
    );
    expect(hasUnsavedChanges()).toBe(false);
  }
});

it("keeps the selected route, factor, and start time when saving fails", async () => {
  const writes = mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "调整倍率" }));
  const dialog = screen.getByRole("dialog", { name: "调整线路扣量倍率" });
  await user.click(within(dialog).getByRole("combobox", { name: "线路" }));
  await user.click(screen.getByRole("option", { name: "办公线路" }));
  fireEvent.change(within(dialog).getByLabelText("整条线路倍率（×）"), {
    target: { value: "2.5" },
  });
  fireEvent.change(within(dialog).getByLabelText("开始时间（本机时区）"), {
    target: { value: "2026-11-01T08:00" },
  });
  await user.click(
    within(dialog).getByRole("button", { name: "保存倍率版本" }),
  );
  await screen.findByText("暂时无法保存倍率，请重试");
  expect(writes).toHaveLength(1);
  expect(
    within(dialog).getByRole("combobox", { name: "线路" }).textContent,
  ).toContain("办公线路");
  expect(
    (within(dialog).getByLabelText("整条线路倍率（×）") as HTMLInputElement)
      .value,
  ).toBe("2.5");
  expect(
    (within(dialog).getByLabelText("开始时间（本机时区）") as HTMLInputElement)
      .value,
  ).toBe("2026-11-01T08:00");
  expect(hasUnsavedChanges()).toBe(true);
  expect(
    within(dialog)
      .getByRole("button", { name: "保存倍率版本" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("keeps rate Close focus after twice canceling an unsaved adjustment", async () => {
  const writes = mount();
  await userEvent.click(screen.getByRole("button", { name: "调整倍率" }));
  const dialog = screen.getByRole("dialog", { name: "调整线路扣量倍率" });
  const rate = within(dialog).getByLabelText("整条线路倍率（×）");
  fireEvent.change(rate, { target: { value: "2.5" } });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((rate as HTMLInputElement).value).toBe("2.5");
  }
  expect(writes).toEqual([]);
});
