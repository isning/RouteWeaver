// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { PublishOutput } from "./Subscriptions";
import { emptyProfile } from "./model";

// Drive the actual rendered animation event; form defaults must not depend on it.
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
let requests: { path: string; body: any }[];
beforeEach(() => {
  requests = [];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, body });
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: "reviewed-input",
          artifacts: [{ path: "config.yaml", content: "reviewed" }],
        });
      if (path.endsWith("/access")) return json({ feedPath: "/feed/created" });
      return json({
        ...body,
        status: "published",
        creationReviewDigest: body.previewDigest,
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
  let owner!: {
    refresh(): void;
    suspend(): void;
    restore(): void;
    leave(): void;
  };
  function Harness() {
    const [open, setOpen] = useState(true);
    const [currentProfile, setCurrentProfile] = useState(profile);
    const [suspended, setSuspended] = useState(false);
    owner = {
      refresh: () => setCurrentProfile({ ...profile }),
      suspend: () => setSuspended(true),
      restore: () => setSuspended(false),
      leave: () => setOpen(false),
    };
    return (
      <>
        <button onClick={() => setOpen(true)}>Reopen subscription</button>
        <button onClick={() => setOpen(false)}>Leave subscription</button>
        <button onClick={() => setSuspended(true)}>Suspend for repair</button>
        <button onClick={() => setSuspended(false)}>
          Restore after repair
        </button>
        <button onClick={() => setCurrentProfile({ ...profile })}>
          Refresh saved profile
        </button>
        <PublishOutput
          profile={open ? currentProfile : null}
          suspended={suspended}
          onClose={() => setOpen(false)}
        />
      </>
    );
  }
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <UIProviders>
        <Harness />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { change: (action: keyof typeof owner) => act(() => owner[action]()) };
}
async function select(label: string, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}
const reviews = () => requests.filter(({ path }) => path.endsWith("/preview"));

it("preserves user input when the opening animation finishes late and publishes exactly that review", async () => {
  const owner = mount();
  fireEvent.change(await screen.findByLabelText("订阅名称"), {
    target: { value: "Personal phone" },
  });
  await select("目标客户端", "sing-box 1.14.3");
  await select("输出内容", "纯节点输出");
  fireEvent.animationEnd(
    screen.getByRole("dialog", { name: "新增客户端订阅" }),
  );
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
    "Personal phone",
  );
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await screen.findByText("兼容检查通过。");
  expect(reviews()[0].body).toEqual({
    id: expect.stringMatching(/^output_/),
    name: "Personal phone",
    profileId: "saved-profile",
    target: { adapterId: "sing-box", version: "1.14.3" },
    mode: "nodes-only",
  });
  // External owner change, not an interaction with modal-inert background.
  owner.change("refresh");
  fireEvent.animationEnd(
    screen.getByRole("dialog", { name: "新增客户端订阅" }),
  );
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
    "Personal phone",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "创建并发布「Personal phone」" }),
  );
  await waitFor(() =>
    expect(
      requests.find(({ path }) => path === "/api/me/outputs")?.body,
    ).toEqual({ ...reviews()[0].body, previewDigest: "reviewed-input" }),
  );
});

it("provides defaults before animation completion and starts a fresh review identity after cancel and reopen", async () => {
  const owner = mount();
  expect(
    ((await screen.findByLabelText("订阅名称")) as HTMLInputElement).value,
  ).toBe("Daily");
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await screen.findByText("兼容检查通过。");
  expect(reviews()[0].body).toMatchObject({
    name: "Daily",
    mode: "full",
    target: { adapterId: "mihomo" },
  });
  fireEvent.change(screen.getByLabelText("订阅名称"), {
    target: { value: "Canceled choice" },
  });
  await userEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
  await userEvent.click(
    screen.getByRole("button", { name: "Reopen subscription" }),
  );
  expect(
    ((await screen.findByLabelText("订阅名称")) as HTMLInputElement).value,
  ).toBe("Daily");
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "检查发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await screen.findByText("兼容检查通过。");
  expect(reviews()[1].body).toMatchObject({
    name: "Daily",
    mode: "full",
    target: { adapterId: "mihomo" },
  });
  expect(reviews()[1].body.id).not.toBe(reviews()[0].body.id);
  expect(requests.some(({ path }) => path === "/api/me/outputs")).toBe(false);
});

it.each(["reviewed", "pending"])(
  "restores %s creation choices after repair without reusing a digest or publishing",
  async (state) => {
    const original = fetch;
    let completeCheck!: (response: Response) => void;
    let checks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (
          String(url) !== "/api/me/outputs/preview" ||
          state !== "pending" ||
          checks++ > 0
        )
          return original(url, init);
        requests.push({
          path: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Promise<Response>((resolve) => {
          completeCheck = resolve;
        });
      }),
    );
    const owner = mount();
    fireEvent.change(await screen.findByLabelText("订阅名称"), {
      target: { value: "Saved repair choices" },
    });
    await select("目标客户端", "sing-box 1.14.3");
    await select("输出内容", "纯节点输出");
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await waitFor(() => expect(reviews()).toHaveLength(1));
    if (state === "reviewed") await screen.findByText("兼容检查通过。");
    const first = reviews()[0].body;
    // External owner change, not an interaction with modal-inert background.
    owner.change("suspend");
    expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
    // External owner change, not an interaction with modal-inert background.
    owner.change("restore");
    expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
      "Saved repair choices",
    );
    expect(
      screen.getByRole("combobox", { name: "目标客户端" })?.textContent,
    ).toContain("sing-box 1.14.3");
    expect(
      screen.getByRole("combobox", { name: "输出内容" })?.textContent,
    ).toContain("纯节点输出");
    expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
    expect(screen.queryByText("兼容检查通过。")).toBeNull();
    screen.getByLabelText("订阅名称").focus();
    if (state === "pending") {
      await act(async () =>
        completeCheck(
          json({
            valid: true,
            previewScope: "new-output",
            outputId: first.id,
            previewDigest: "old-repair-review",
            artifacts: [
              { path: "config.yaml", content: "stale repair content" },
            ],
          }),
        ),
      );
      expect(document.activeElement).toBe(screen.getByLabelText("订阅名称"));
      expect(screen.queryByText("兼容检查通过。")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /^创建并发布「/ }),
      ).toBeNull();
    }
    expect(requests.some(({ path }) => path === "/api/me/outputs")).toBe(false);
    expect(reviews()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await screen.findByText("兼容检查通过。");
    expect(reviews()[1].body).toEqual(first);
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(requests.some(({ path }) => path === "/api/me/outputs")).toBe(false);
    await userEvent.click(
      screen.getByRole("button", {
        name: "创建并发布「Saved repair choices」",
      }),
    );
    await waitFor(() =>
      expect(
        requests.find(({ path }) => path === "/api/me/outputs")?.body,
      ).toEqual({ ...first, previewDigest: "reviewed-input" }),
    );
  },
);

it("does not let a late check restore or focus a closed creation session", async () => {
  let completeCheck!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      requests.push({
        path: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Promise<Response>((resolve) => {
        completeCheck = resolve;
      });
    }),
  );
  const owner = mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "检查发布内容" }),
  );
  await waitFor(() => expect(reviews()).toHaveLength(1));
  const first = reviews()[0].body;
  // External owner change, not an interaction with modal-inert background.
  owner.change("leave");
  const returnAction = screen.getByRole("button", {
    name: "Reopen subscription",
  });
  returnAction.focus();
  await act(async () =>
    completeCheck(
      json({
        valid: true,
        previewScope: "new-output",
        outputId: first.id,
        previewDigest: "closed-review",
        artifacts: [{ path: "config.yaml", content: "closed content" }],
      }),
    ),
  );
  expect(document.activeElement).toBe(returnAction);
  expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
  await userEvent.click(returnAction);
  expect(screen.queryByText("兼容检查通过。")).toBeNull();
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "检查发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(requests).toHaveLength(1);
});
