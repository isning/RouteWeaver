// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishOutput, UpdateOutput } from "./Subscriptions";
import { emptyProfile } from "./model";

const profile = { ...emptyProfile(), id: "rules-profile", name: "Rule files" };
const notice = "发布后仅提供配置与规则文件包，请下载并导入客户端。";
const clients: QueryClient[] = [];
beforeEach(() => {
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  [
    "accepted local file",
    [
      {
        id: "accepted-rules",
        location: "local",
        acceptedVersion: "accepted-v1",
      },
    ],
    true,
  ],
  [
    "remote reference",
    [
      {
        id: "remote-rules",
        location: "remote",
        acceptedVersion: "accepted-v1",
      },
    ],
    false,
  ],
  ["unaccepted local file", [{ id: "local-rules", location: "local" }], false],
  ["no rule file", [], false],
])(
  "discloses bundle delivery for %s before the separate create decision",
  async (_label, resources, shown) => {
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(input) !== "/api/me/outputs/preview") {
          writes.push(body);
          throw new Error("Unexpected publication");
        }
        return new Response(
          JSON.stringify({
            valid: true,
            previewScope: "new-output",
            outputId: body.id,
            previewDigest: "reviewed-digest",
            resources,
            artifacts: [{ path: "config.yaml", content: "reviewed" }],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <PublishOutput profile={profile} onClose={() => {}} />
        </UIProviders>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
        "value",
        "Rule files",
      ),
    );
    expect(screen.queryByText(notice)).toBeNull();
    expect(screen.getByText("创建新的客户端订阅，其他订阅保留原版本。")).toBeTruthy();
    expect(screen.queryByText("新建独立链接，其他订阅保留原版本。")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await screen.findByText("兼容检查通过。");
    if (shown) {
      const disclosure = screen.getByText(notice);
      const consequence = screen.getByText("新建订阅，其他订阅保留原版本。");
      expect(disclosure.closest("[data-slot=dialog-footer]")).toBe(
        consequence.closest("[data-slot=dialog-footer]"),
      );
      expect(disclosure.closest("[data-slot=dialog-footer]")).not.toBeNull();
      expect(screen.queryByText("新建独立链接，其他订阅保留原版本。")).toBeNull();
    } else {
      expect(screen.queryByText(notice)).toBeNull();
      expect(screen.getByText("新建独立链接，其他订阅保留原版本。")).toBeTruthy();
    }
    expect(
      screen.getByRole("button", { name: "创建并发布「Rule files」" }),
    ).toHaveProperty("disabled", false);
    expect(writes).toHaveLength(0);
    await userEvent.clear(screen.getByRole("textbox", { name: "订阅名称" }));
    expect(screen.queryByText(notice)).toBeNull();
    expect(screen.queryByText("新建订阅，其他订阅保留原版本。")).toBeNull();
    expect(screen.queryByText("新建独立链接，其他订阅保留原版本。")).toBeNull();
    expect(screen.getByText("创建新的客户端订阅，其他订阅保留原版本。")).toBeTruthy();
  },
);

it.each(["preserve", "replace"] as const)(
  "uses bundle-safe selected-update consequences while preserving the %s approval effect",
  async (link) => {
    const output = {
      id: "bundle-phone",
      name: "Phone",
      profileId: "rules-profile",
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
      status: "published",
      delivery: "feed" as const,
    };
    const published = { ...output, delivery: "bundle" as const };
    const writes: { path: string; body: unknown }[] = [];
    const onPublished = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const path = String(input),
          body = JSON.parse(String(init?.body));
        if (path.endsWith("/publish")) writes.push({ path, body });
        return new Response(
          JSON.stringify(
            path.endsWith("/publish")
              ? published
              : {
                  valid: true,
                  outputId: output.id,
                  previewScope: "output-update",
                  previewDigest: "a".repeat(64),
                  publicationEffect: { version: 1, link },
                  resources: [
                    {
                      id: "accepted-rules",
                      location: "local",
                      acceptedVersion: "accepted-v1",
                    },
                  ],
                  artifacts: [{ path: "config.json", content: "reviewed" }],
                },
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <UpdateOutput
            output={output}
            onClose={() => {}}
            onPublished={onPublished}
          />
        </UIProviders>
      </QueryClientProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "预览此订阅更新" }),
    );
    await screen.findByText("兼容检查通过。");
    const decision = within(screen.getByRole("group", { name: "更新确认" }));
    expect(
      decision.getByText(
        /发布后仅提供配置与规则文件包，请下载并导入客户端。其他订阅保留原状。/,
      ),
    ).toBeTruthy();
    expect(decision.queryByText("沿用当前链接，其他订阅保留原状。")).toBeNull();
    expect(
      decision.queryByText("发布后请在客户端换用新链接，其他订阅保留原状。"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "重新发布并生成新链接「Phone」" }),
    ).toBeNull();
    if (link === "replace")
      expect(decision.getByText(/重新发布将更换访问凭据。/)).toBeTruthy();
    const confirm = decision.getByRole("button", {
      name:
        link === "replace" ? "重新发布配置包「Phone」" : "确认更新「Phone」",
    });
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(onPublished).toHaveBeenCalledWith(published, link === "replace"),
    );
    expect(writes).toEqual([
      {
        path: "/api/me/outputs/bundle-phone/publish",
        body: { previewDigest: "a".repeat(64) },
      },
    ]);
  },
);

it("expires bundle consequences during recheck and uses the next checked delivery", async () => {
  const output = {
    id: "rechecked-phone",
    name: "Phone",
    profileId: "rules-profile",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    status: "published",
  };
  const preview = {
    valid: true,
    outputId: output.id,
    previewScope: "output-update",
    previewDigest: "a".repeat(64),
    publicationEffect: { version: 1, link: "replace" },
    artifacts: [{ path: "config.json", content: "reviewed" }],
  };
  let resolve!: (response: Response) => void;
  const next = new Promise<Response>((done) => {
    resolve = done;
  });
  let calls = 0;
  const response = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ++calls === 1
        ? response({
            ...preview,
            resources: [
              { id: "local", location: "local", acceptedVersion: "v1" },
            ],
          })
        : next,
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <UpdateOutput output={output} onClose={() => {}} />
      </UIProviders>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await screen.findByRole("button", { name: "重新发布配置包「Phone」" });
  await userEvent.click(screen.getByRole("button", { name: "重新检查" }));
  expect(screen.queryByText(/发布后请下载配置与规则文件包/)).toBeNull();
  expect(screen.queryByText(/重新发布将更换访问凭据/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "重新发布配置包「Phone」" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「Phone」" }),
  ).toHaveProperty("disabled", true);
  await act(async () =>
    resolve(
      response({
        ...preview,
        previewDigest: "b".repeat(64),
        publicationEffect: { version: 1, link: "preserve" },
        resources: [
          { id: "remote", location: "remote", acceptedVersion: "v1" },
        ],
      }),
    ),
  );
  expect(await screen.findByText("沿用当前链接，其他订阅保留原状。")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "确认更新「Phone」" }),
  ).toHaveProperty("disabled", false);
  expect(screen.queryByText(/发布后请下载配置与规则文件包/)).toBeNull();
  expect(calls).toBe(2);
});
