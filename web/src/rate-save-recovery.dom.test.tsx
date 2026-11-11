// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";

const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["failed", "stale", "mismatched"])("preserves confirmed rate saves and recovers %s responses in the actual workspace", async (followUp) => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#services");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const writes: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  let recovered = false;
  let rateReads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url === "/api/rates" && method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return json(followUp === "mismatched" ? { ...body, id: "unrelated-rate" } : body, 201);
    }
    if (method !== "GET") {
      unexpected.push(`${method} ${url}`);
      throw new Error("Unexpected write");
    }
    if (url === "/api/auth/me") return json({ user: { id: "admin-reader", name: "Admin", role: "admin" }, csrfToken: "fixture" });
    if (url === "/api/state") return json({ nodes: [], users: [], routes: [], revisions: [], capabilities: [] });
    if (url === "/api/settings") return json({ name: "Read-only fixture", registration: "invite" });
    if (url === "/api/published-routes") return json([{ id: "office-route", name: "办公线路", status: "published" }]);
    if (url === "/api/services") return json([]);
    if (url === "/api/rates") {
      rateReads++;
      if (!writes.length) return json([]);
      return recovered ? json(writes) : followUp === "failed" ? json({ message: "倍率记录暂时无法刷新" }, 503) : json([]);
    }
    unexpected.push(`${method} ${url}`);
    throw new Error(`Unexpected request ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15000 },
    mutations: { retry: false },
  } });
  clients.push(client);
  render(<UIProviders><QueryClientProvider client={client}><App /></QueryClientProvider></UIProviders>);
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "服务方案", level: 1 });
  await user.click(await screen.findByRole("button", { name: "调整倍率" }));
  const dialog = screen.getByRole("dialog", { name: "调整线路扣量倍率" });
  await user.click(within(dialog).getByRole("combobox", { name: "线路" }));
  await user.click(screen.getByRole("option", { name: "办公线路" }));
  fireEvent.change(within(dialog).getByLabelText("整条线路倍率（×）"), { target: { value: "2" } });
  await user.click(within(dialog).getByRole("button", { name: "保存倍率版本" }));
  if (followUp === "mismatched") {
    await within(dialog).findByText("保存结果无法核对，请检查倍率记录，避免重复保存。");
    expect(within(dialog).getByRole("button", { name: "保存倍率版本" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("线路倍率版本已保存")).toBeNull();
    // Native hash navigation uses the workspace's real departure confirmation.
    window.location.hash = "#nodes";
    const departure = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
    expect(departure.textContent).toContain("倍率保存结果尚未核对。离开不会撤销已提交的保存，请返回倍率记录核对，避免重复保存。");
    expect(departure.textContent).not.toContain("当前编辑尚未保存。离开会放弃尚未保存的内容。");
    await user.click(within(departure).getByRole("button", { name: "留在当前页面" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    recovered = true;
    await user.click(within(dialog).getByRole("button", { name: "关闭并检查记录" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("row", { name: /办公线路.*2×/ })).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(unexpected).toEqual([]);
    return;
  }
  await waitFor(() => expect(rateReads).toBeGreaterThanOrEqual(2));
  if (followUp === "failed") await screen.findByText("倍率记录暂时无法刷新");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ routeId: "office-route", micros: 2_000_000 });
  expect(unexpected).toEqual([]);
  // A completed save remains reviewable even though the independent list read failed.
  expect(screen.getByRole("row", { name: /办公线路.*2×/ })).toBeTruthy();
  // Reopening and canceling a fresh editor must not erase the earlier receipt.
  await user.click(screen.getByRole("button", { name: "调整倍率" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("row", { name: /办公线路.*2×/ })).toBeTruthy();
  recovered = true;
  const beforeRecovery = rateReads;
  if (followUp === "failed") await user.click(screen.getByRole("button", { name: "重试" }));
  else fireEvent.focus(window);
  await waitFor(() => expect(rateReads).toBeGreaterThan(beforeRecovery));
  await waitFor(() => expect(screen.queryByText("倍率记录暂时无法刷新")).toBeNull());
  expect(screen.getAllByRole("row", { name: /办公线路.*2×/ })).toHaveLength(1);
  expect(writes).toHaveLength(1);
  expect(unexpected).toEqual([]);
});
