// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RateSettings } from "./Rates";
import type { RouteRecord } from "./types";

const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
async function editRate(fail = false, selectRoute = true) {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path !== "/api/rates") throw new Error(`Unexpected request: ${path}`);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return fail ? json({ error: "invalid rate revision" }, 400) : json(body);
    }
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>
    <RateSettings routes={[{ id: "route", name: "办公线路" } as RouteRecord]} />
  </UIProviders></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "调整倍率" }));
  const dialog = screen.getByRole("dialog", { name: "调整线路扣量倍率" });
  if (selectRoute) {
    await user.click(within(dialog).getByRole("combobox", { name: "线路" }));
    await user.click(screen.getByRole("option", { name: "办公线路" }));
  }
  const factor = within(dialog).getByLabelText("整条线路倍率（×）") as HTMLInputElement;
  const save = within(dialog).getByRole("button", { name: "保存倍率版本" });
  return { writes, user, dialog, factor, save };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

it("rejects a sub-millionth factor without sending a free rate, then saves the corrected factor", async () => {
  const { writes, user, dialog, factor, save } = await editRate();
  fireEvent.change(factor, { target: { value: "0.0000004" } });
  await user.click(save);
  await within(dialog).findByText("倍率须为 0.000001 的整数倍，请调整后保存");
  expect(writes).toEqual([]);
  expect(factor.value).toBe("0.0000004");
  fireEvent.change(factor, { target: { value: "0.000001" } });
  await user.click(save);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ routeId: "route", micros: 1 });
});

it.each([
  ["0", 0],
  ["1", 1_000_000],
  ["1000", 1_000_000_000],
  ["1.000001", 1_000_001],
  ["0.0000010", 1],
  ["1e-6", 1],
  [".5", 500_000],
  ["+1.2500000", 1_250_000],
  ["1" + "0".repeat(400) + "e-400", 1_000_000],
])("saves the exact supported factor %s as integer micros", async (raw, micros) => {
  const { writes, user, factor, save } = await editRate();
  fireEvent.change(factor, { target: { value: raw } });
  await user.click(save);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ routeId: "route", micros });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it.each([
  ["0.0000015", "倍率须为 0.000001 的整数倍，请调整后保存"],
  ["1.0000000000000001", "倍率须为 0.000001 的整数倍，请调整后保存"],
  ["1e-999999999999999999999", "倍率须为 0.000001 的整数倍，请调整后保存"],
  ["1e999999999999999999999", "倍率范围为 0–1000"],
  ["1000.000001", "倍率范围为 0–1000"],
  ["-1", "倍率范围为 0–1000"],
  ["1e", "请输入有效倍率"],
  ["", "请填写整条线路倍率（×）"],
])("keeps unsupported raw factor %s visible without posting", async (raw, error) => {
  const { writes, user, dialog, factor, save } = await editRate();
  fireEvent.change(factor, { target: { value: raw } });
  await user.click(save);
  await within(dialog).findByText(error);
  expect(factor.value).toBe(raw);
  expect(writes).toEqual([]);
});

it("requires a discard decision for raw-only changes hidden by Number rounding", async () => {
  const { writes, user, factor: rawFactor } = await editRate(false, false);
  fireEvent.change(rawFactor, { target: { value: "1.0000000000000001" } });
  await user.keyboard("{Escape}");
  const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的倍率调整？" });
  await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(rawFactor.value).toBe("1.0000000000000001");
  expect(writes).toEqual([]);
});

it("preserves exact raw input after a failed save and sends again only on explicit retry", async () => {
  const { writes, user, dialog, factor, save } = await editRate(true);
  const start = within(dialog).getByLabelText("开始时间（本机时区）") as HTMLInputElement;
  fireEvent.change(start, { target: { value: "2026-11-06T08:00" } });
  fireEvent.change(factor, { target: { value: "0.0000010" } });
  await user.click(save);
  await within(dialog).findByText("invalid rate revision");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ routeId: "route", micros: 1 });
  expect(factor.value).toBe("0.0000010");
  expect(start.value).toBe("2026-11-06T08:00");
  expect(within(dialog).getByRole("combobox", { name: "线路" }).textContent).toContain("办公线路");
  fireEvent.change(factor, { target: { value: "2e-6" } });
  await user.tab();
  expect(writes).toHaveLength(1);
  await user.click(save);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({ routeId: "route", micros: 2 });
});

it("saves the untouched legacy default factor without requiring re-entry", async () => {
  const { writes, user, factor, save } = await editRate();
  expect(factor.value).toBe("1");
  await user.click(save);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ routeId: "route", micros: 1_000_000 });
});

it("keeps factor spinbutton stepping and closes a reverted default without discarding", async () => {
  const { writes, user, dialog } = await editRate(false, false);
  const factor = within(dialog).getByRole("spinbutton", { name: "整条线路倍率（×）" }) as HTMLInputElement;
  await user.click(factor);
  await user.keyboard("{ArrowUp}");
  expect(factor.value).toBe("2");
  await user.keyboard("{ArrowDown}");
  expect(factor.value).toBe("1");
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
});

it.each(["1e", "1.0000000000000001", "0.0000004", "1" + "0".repeat(400)])(
  "does not present invalid raw factor %s as a quota example",
  async (raw) => {
    const { writes, dialog, factor } = await editRate();
    expect(within(dialog).getByText("使用 1 GB 实际流量，扣除 1 GB 额度。")).toBeTruthy();
    fireEvent.change(factor, { target: { value: raw } });
    expect(within(dialog).queryByText(/使用 1 GB 实际流量，扣除/)).toBeNull();
    expect(within(dialog).getByText("请填写有效倍率后查看扣量示例。")).toBeTruthy();
    expect(factor.value).toBe(raw);
    expect(writes).toEqual([]);
  },
);

it("normalizes an exact exponent factor in the quota example while preserving its input", async () => {
  const { writes, dialog, factor } = await editRate();
  fireEvent.change(factor, { target: { value: "1e" } });
  expect(within(dialog).queryByText(/使用 1 GB 实际流量，扣除/)).toBeNull();
  fireEvent.change(factor, { target: { value: "125e-2" } });
  expect(within(dialog).getByText("使用 1 GB 实际流量，扣除 1.25 GB 额度。")).toBeTruthy();
  expect(within(dialog).queryByText("请填写有效倍率后查看扣量示例。")).toBeNull();
  expect(factor.value).toBe("125e-2");
  expect(writes).toEqual([]);
});
