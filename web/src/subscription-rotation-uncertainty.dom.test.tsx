// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Output } from "./types";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
function mount(node: ReactNode, staleTime = 0) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
// Source-authored regression; execution intentionally UNRUN in recovery workspace.
it.each(["lost response", "malformed JSON", "wrong target", "empty success", "conflict", "body read failure"])(
  "keeps %s rotation uncertain while explicit current-access reads never replay it",
  async (failure) => {
    const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
    const output: Output = {
      id: "phone", name: "Phone", profileId: profile.id,
      target: profile.target, mode: "full", status: "published",
    };
    const writes: string[] = [], reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST") {
        writes.push(path);
        if (failure === "conflict") return json({ error: "conflict" }, 409);
        if (failure === "body read failure") {
          const response = json(output);
          response.text = async () => { throw new Error("body interrupted"); };
          return response;
        }
        if (failure === "lost response") throw new Error("connection lost");
        if (failure === "malformed JSON") return new Response("{", { status: 200 });
        return json(failure === "wrong target" ? { ...output, id: "laptop" } : {});
      }
      if (path.endsWith("/access")) {
        reads.push(path);
        return reads.length === 1
          ? json({ error: "unavailable" }, 503)
          : json({ delivery: "feed", feedPath: "/feed/current-phone" });
      }
      if (path.endsWith("/outputs")) return json([output]);
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/status")) return json(output);
      return json([]);
    }));
    mount(<SubscriptionsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "查看订阅 Phone" }));
    await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "更换订阅链接" }));
    const decision = await screen.findByRole("alertdialog", { name: "更换「Phone」的订阅链接？" });
    await userEvent.click(within(decision).getByRole("button", { name: "更换链接" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("链接更换结果尚未确认")).toBeTruthy();
    expect(reads).toEqual([]);
    expect(screen.queryByText(/订阅链接已更新|旧链接已失效/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "查看当前访问方式" }));
    const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
    await userEvent.click(await within(access).findByRole("button", { name: /重试/ }));
    expect((await within(access).findByRole("textbox", { name: "订阅链接" }) as HTMLInputElement).value).toContain("/feed/current-phone");
    expect(within(access).getByText(/不能确认上次更换是否完成/)).toBeTruthy();
    expect(within(access).queryByText(/旧链接已失效|新链接已生成/)).toBeNull();
    await userEvent.click(within(access).getByRole("button", { name: "关闭" }));
    await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    expect((await screen.findByRole("menuitem", { name: "更换订阅链接" })).getAttribute("data-disabled")).not.toBeNull();
    expect(writes).toEqual(["/api/me/outputs/phone/rotate"]);
    expect(reads).toEqual(["/api/me/outputs/phone/access", "/api/me/outputs/phone/access"]);
  },
);

function rotationFixture() {
  const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
  const output: Output = {
    id: "phone", name: "Phone", profileId: profile.id,
    target: profile.target, mode: "full", status: "published",
  };
  const writes: string[] = [];
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (init?.method === "POST") {
      writes.push(path);
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    if (path.endsWith("/outputs")) return json([output]);
    if (path.endsWith("/profiles")) return json([profile]);
    if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
    if (path.endsWith("/status")) return json(output);
    throw new Error(`Unexpected read ${path}`);
  }));
  return { writes, finish: (response: Response) => finish(response) };
}
async function openRotation() {
  await userEvent.click(await screen.findByRole("button", { name: "查看订阅 Phone" }));
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "更换订阅链接" }));
  return screen.findByRole("alertdialog", { name: "更换「Phone」的订阅链接？" });
}

it("does not dispatch a retained confirmation after its page owner unmounts", async () => {
  const fixture = rotationFixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (visible: boolean) => (
    <QueryClientProvider client={client}>
      <UIProviders>{visible ? <SubscriptionsPage /> : <p>Other page</p>}</UIProviders>
    </QueryClientProvider>
  );
  const rendered = render(view(true));
  const decision = await openRotation();
  rendered.rerender(view(false));
  await userEvent.click(within(decision).getByRole("button", { name: "更换链接" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(fixture.writes).toEqual([]);
});

it("retains uncertainty across page remounts but isolates another actor's query client", async () => {
  const fixture = rotationFixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (visible: boolean, actor = client) => (
    <QueryClientProvider client={actor}>
      <UIProviders>{visible ? <SubscriptionsPage key={actor === client ? "first" : "second"} /> : null}</UIProviders>
    </QueryClientProvider>
  );
  const rendered = render(view(true));
  const decision = await openRotation();
  await userEvent.click(within(decision).getByRole("button", { name: "更换链接" }));
  await waitFor(() => expect(fixture.writes).toEqual(["/api/me/outputs/phone/rotate"]));
  rendered.rerender(view(false));
  await act(async () => fixture.finish(json({}, 503)));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  rendered.rerender(view(true));
  expect(await screen.findByText("链接更换结果尚未确认")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "获取「Phone」" })).toBeNull();
  const other = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rendered.rerender(view(true, other));
  await screen.findByRole("dialog", { name: "Phone 的订阅详情" });
  expect(screen.queryByText("链接更换结果尚未确认")).toBeNull();
  expect(fixture.writes).toEqual(["/api/me/outputs/phone/rotate"]);
});
