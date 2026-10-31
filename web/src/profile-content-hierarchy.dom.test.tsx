// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { ClientNode, Output, Profile, Source } from "./types";

const node = (id: string, name: string): ClientNode => ({
  id,
  name,
  origin: "imported",
  connection: { protocol: "socks", host: `${id}.example.test`, port: 1080 },
});
const effective = [
  node("tokyo", "Tokyo accepted"),
  node("london", "London accepted"),
];
const source: Source = {
  id: "travel-source",
  name: "Travel source",
  kind: "text",
  enabled: true,
  snapshot: {
    endpoints: [...effective, node("filtered", "Raw filtered node")],
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "/");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture() {
  const profile = {
    ...emptyProfile(),
    id: "intent-profile",
    name: "Travel configuration",
    sourceIds: [source.id],
  };
  profile.ir.name = profile.name;
  return profile;
}
function mount(
  profile: Profile = fixture(),
  options: {
    output?: Output;
    inputFailure?: boolean;
    isNew?: boolean;
    saveResponse?: () => Promise<Response>;
  } = {},
) {
  const writes: { path: string; body: any }[] = [];
  const savedSources = [source];
  const onClose = vi.fn();
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/me/collections/preview")
      return options.inputFailure
        ? json({ detail: "Accepted source is unavailable" }, 503)
        : json({ endpoints: effective, stages: [] });
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === "/api/me/sources") {
        const savedSource = { ...body, snapshot: { endpoints: effective } };
        savedSources.push(savedSource);
        return json(savedSource);
      }
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: "checked-phone",
          outputId: options.output?.id,
          artifacts: [{ path: "config.json", content: "checked exact client" }],
        });
      if (path.startsWith("/api/me/profiles") && options.saveResponse)
        return options.saveResponse();
      return json(body);
    }
    return json(
      path.endsWith("/sources")
        ? savedSources
        : path.endsWith("/outputs") && options.output
          ? [options.output]
          : [],
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor
          initial={profile}
          isNew={options.isNew ?? false}
          output={options.output}
          onClose={onClose}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, fetcher, onClose };
}

it("offers one strategy-group action in an empty panel and retains it after adding", async () => {
  mount();
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "策略组" }));
  expect(screen.getByText("暂无策略组")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "添加策略组" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "添加策略组" }));
  expect(screen.queryByText("暂无策略组")).toBeNull();
  expect(screen.getByRole("textbox", { name: "策略组名称" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "添加策略组" })).toHaveLength(1);
});

it("names save-before-inspection, preserves direct intent, and cancels only the review", async () => {
  const { writes } = mount(fixture(), { isNew: true });
  await screen.findByText("2 个有效连接");
  expect(screen.getByText("已导入的连接尚未用于分流。")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "保存并检查" }));
  const review = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  expect(
    writes.filter((write) => write.path === "/api/me/profiles"),
  ).toHaveLength(1);
  expect(
    writes.find((write) => write.path === "/api/me/profiles")?.body.ir
      .defaultAction,
  ).toEqual({ kind: "direct" });
  await userEvent.click(
    within(review).getByRole("button", { name: /^取\s*消$/ }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "检查发布" })).toBeTruthy();
  expect(screen.getByText("草稿已保存")).toBeTruthy();
  expect(writes.some((write) => write.path.includes("/outputs"))).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Changed draft" },
  });
  expect(screen.getByRole("button", { name: "保存并检查" })).toBeTruthy();
});

it("opens inspection of a saved profile without saving or publishing again", async () => {
  const { writes } = mount();
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("button", { name: "检查发布" }));
  const review = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  await userEvent.click(
    within(review).getByRole("button", { name: /^取\s*消$/ }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
  expect(screen.getByRole("button", { name: "检查发布" })).toBeTruthy();
});

it("keeps one saved state with the save actions through repeated saves and the next edit", async () => {
  const { writes } = mount();
  await screen.findByText("2 个有效连接");
  const actions = screen.getByRole("group", { name: "保存与检查配置" });
  expect(within(actions).getByRole("status").textContent).toBe("已保存草稿");
  const save = within(actions).getByRole("button", {
    name: "保存草稿",
  });
  await userEvent.click(save);
  await waitFor(() =>
    expect(within(actions).getByRole("status").textContent).toBe("草稿已保存"),
  );
  await userEvent.click(save);
  await waitFor(() =>
    expect(
      writes.filter((w) => w.path === "/api/me/profiles/intent-profile"),
    ).toHaveLength(2),
  );
  expect(screen.getAllByText("草稿已保存")).toHaveLength(1);
  expect(screen.queryByText("配置草稿已保存")).toBeNull();
  expect((save as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Edited name" },
  });
  expect(within(actions).getByRole("status").textContent).toBe("草稿尚未保存");
  expect(
    within(actions).getByRole("button", { name: "保存并检查" }),
  ).toBeTruthy();
});

it("keeps dirty input and error on failed save while pending actions stay busy", async () => {
  let resolveSave!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  mount(fixture(), { saveResponse: () => pending });
  await screen.findByText("2 个有效连接");
  const name = screen.getByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Unsaved retained name" } });
  const actions = screen.getByRole("group", { name: "保存与检查配置" });
  const save = within(actions).getByRole("button", {
    name: "保存草稿",
  });
  await userEvent.click(save);
  const check = within(actions).getByRole("button", {
    name: "保存并检查",
  });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(check.getAttribute("aria-busy")).toBe("true");
  expect(within(actions).getByRole("status").textContent).toBe("草稿尚未保存");
  resolveSave(json({ detail: "Draft save unavailable" }, 503));
  await screen.findByText("Draft save unavailable");
  expect((name as HTMLInputElement).value).toBe("Unsaved retained name");
  expect(within(actions).getByRole("status").textContent).toBe("草稿尚未保存");
  expect((save as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText("配置草稿已保存")).toBeNull();
});
