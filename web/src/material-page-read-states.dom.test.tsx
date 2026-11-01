// @vitest-environment jsdom
// Real workspace routing and page components; synthetic HTTP, not backend authorization.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
beforeAll(async () => {
  // The cases assert HTTP loading, not the development server's module compilation.
  await Promise.all([import("./Sources"), import("./Templates")]);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});
for (const role of ["user", "admin"]) {
  it.each([
    ["sources", "/api/me/sources", "订阅来源", "暂无订阅来源"],
    ["resources", "/api/me/resources", "规则资源", "暂无规则资源"],
    ["collections", "/api/me/collections", "节点集合", "暂无节点集合"],
    ["templates", "/api/templates", "模板与预设", "暂无可用模板"],
  ])(`allows ${role} into #%s and distinguishes pending, failed and authoritative empty reads`, async (hash, endpoint, heading, empty) => {
    history.replaceState(null, "", `/#${hash}`);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    let release!: (response: Response) => void;
    let reads = 0;
    const unexpected: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        unexpected.push(`${init.method} ${url}`);
        throw new Error("No mutation is authorized by this read-state case");
      }
      if (url === "/api/auth/me") return json({ user: { id: `reader-${role}`, name: "Reader", role }, csrfToken: "synthetic" });
      if (url === endpoint) {
        reads++;
        if (reads === 1) return new Promise<Response>((resolve) => { release = resolve; });
        return json([]);
      }
      if (["/api/me/sources", "/api/me/template-bindings", "/api/me/profiles", "/api/me/collections", "/api/me/platform-entries"].includes(url)) return json([]);
      unexpected.push(url);
      throw new Error(`Unexpected read ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
    const main = await screen.findByRole("main");
    await within(main).findByRole("heading", { name: heading, level: 1 });
    expect(within(main).getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
    expect(within(main).queryByText(empty)).toBeNull();
    expect(screen.queryByText("需要管理员权限")).toBeNull();
    await act(async () => { release(json({ message: `${heading}读取失败，请重试` }, 503)); });
    await within(main).findByText(`${heading}读取失败，请重试`);
    expect(within(main).queryByText(empty)).toBeNull();
    expect(within(main).queryByLabelText("正在加载")).toBeNull();
    await userEvent.click(within(main).getByRole("button", { name: "重试" }));
    await within(main).findByText(empty);
    expect(within(main).queryByText(`${heading}读取失败，请重试`)).toBeNull();
    expect(reads).toBe(2);
    expect(unexpected).toEqual([]);
  });
}
