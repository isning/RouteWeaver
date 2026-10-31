// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { useState } from "react";
import { ProfilePublicationDialog } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Output } from "./types";

const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
const output: Output = {
  id: "phone",
  name: "Phone",
  profileId: profile.id,
  target: profile.target,
  mode: "full",
  status: "published",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let requests: { path: string; method: string; body: any }[];
let readOutputs: () => Promise<Response>;

function mount(
  options: { cached?: Output[]; preferred?: Output; suspended?: boolean } = {},
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const owner = {
    refresh: () => {
      void client.invalidateQueries({ queryKey: ["outputs"] });
    },
  };
  if (options.cached) client.setQueryData(["outputs"], options.cached);
  function Task() {
    const [open, setOpen] = useState(true);
    const [suspended, setSuspended] = useState(options.suspended ?? false);
    return (
      <>
        <button
          onClick={() => client.invalidateQueries({ queryKey: ["outputs"] })}
        >
          Refresh subscriptions
        </button>
        <button onClick={() => setSuspended(false)}>Resume publication</button>
        {open && (
          <ProfilePublicationDialog
            profile={profile}
            preferredOutput={options.preferred}
            suspended={suspended}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Task />
      </UIProviders>
    </QueryClientProvider>,
  );
  return owner;
}

beforeEach(() => {
  onlineManager.setOnline(true);
  vi.stubEnv("NODE_ENV", "development");
  requests = [];
  readOutputs = async () => json([]);
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      if (path === "/api/me/outputs" && method === "GET") return readOutputs();
      if (path === "/api/me/outputs/preview")
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: "reviewed-first-subscription",
          artifacts: [{ path: "config.yaml", content: "reviewed" }],
        });
      return json({ ...body, status: "published" });
    }),
  );
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("opens the first subscription form after a fresh empty read without a target choice or write", async () => {
  mount();
  expect(
    await screen.findByRole("dialog", { name: "新增客户端订阅" }),
  ).toBeTruthy();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "value",
    "Daily",
  );
  expect(screen.getByText("创建新的客户端订阅，其他订阅不变。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "检查发布内容" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /创建并发布/ })).toBeNull();
  expect(requests).toEqual([
    { path: "/api/me/outputs", method: "GET", body: null },
  ]);
  await userEvent.click(screen.getByRole("button", { name: /取\s*消/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests).toHaveLength(1);
});

it.each([false, true])(
  "does not offer creation from a paused read (cached empty=%s)",
  async (cached) => {
    onlineManager.setOnline(false);
    let finish!: (response: Response) => void;
    readOutputs = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    mount(cached ? { cached: [] } : {});
    expect(await screen.findByText("当前离线")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
    expect(screen.getByRole("button", { name: "检查所选订阅" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(requests).toEqual([]);
    act(() => onlineManager.setOnline(true));
    await screen.findByLabelText("正在加载");
    expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
    await act(async () => finish(json([])));
    expect(
      await screen.findByRole("dialog", { name: "新增客户端订阅" }),
    ).toBeTruthy();
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  },
);

it("does not use stale empty cache while loading a nonempty list", async () => {
  let finish!: (response: Response) => void;
  readOutputs = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  mount({ cached: [] });
  await screen.findByLabelText("正在加载");
  expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
  expect(screen.getByRole("button", { name: "检查所选订阅" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => finish(json([output])));
  expect(
    await screen.findByRole("radio", { name: /更新「Phone」/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
  expect(requests).toHaveLength(1);
});

it("keeps a failed fresh empty-list read recoverable without treating cache as absence", async () => {
  readOutputs = async () =>
    json({ error: "Synthetic output read failed" }, 503);
  mount({ cached: [] });
  await screen.findByText("暂时无法加载");
  expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
  expect(screen.getByRole("button", { name: "检查所选订阅" })).toHaveProperty(
    "disabled",
    true,
  );
  readOutputs = async () => json([]);
  await userEvent.click(screen.getByRole("button", { name: /重\s*试/ }));
  expect(
    await screen.findByRole("dialog", { name: "新增客户端订阅" }),
  ).toBeTruthy();
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});

it.each(["one", "many", "revoked"])(
  "retains the explicit chooser for %s linked subscriptions",
  async (kind) => {
    readOutputs = async () =>
      json(
        kind === "many"
          ? [output, { ...output, id: "laptop", name: "Laptop" }]
          : [
              {
                ...output,
                status: kind === "revoked" ? "revoked" : "published",
              },
            ],
      );
    mount();
    expect(
      await screen.findByRole("radio", { name: /更新「Phone」/ }),
    ).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(kind === "many" ? 3 : 2);
    expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
    expect(screen.getByRole("button", { name: "检查所选订阅" })).toHaveProperty(
      "disabled",
      true,
    );
    if (kind === "revoked")
      expect(screen.getByText(/已撤销（需重新发布）/)).toBeTruthy();
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  },
);

it("never converts an unavailable preferred subscription into first creation", async () => {
  mount({ preferred: output });
  expect(
    await screen.findByText("「Phone」已不在此配置的订阅列表中"),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
  expect(screen.getByRole("button", { name: "检查所选订阅" })).toHaveProperty(
    "disabled",
    true,
  );
  await userEvent.click(
    screen.getByRole("radio", { name: "创建新的客户端订阅" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "检查所选订阅" }));
  expect(
    await screen.findByRole("dialog", { name: "新增客户端订阅" }),
  ).toBeTruthy();
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});

it("does not silently replace an explicitly selected target removed by refresh", async () => {
  readOutputs = async () => json([output]);
  const owner = mount();
  await userEvent.click(
    await screen.findByRole("radio", { name: /更新「Phone」/ }),
  );
  readOutputs = async () => json([]);
  act(() => owner.refresh());
  await waitFor(() =>
    expect(screen.queryByRole("radio", { name: /更新「Phone」/ })).toBeNull(),
  );
  expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
  expect(screen.getByRole("button", { name: "检查所选订阅" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});

it("preserves an in-progress independent subscription through pending, failed, and newly nonempty refreshes", async () => {
  const owner = mount();
  await screen.findByRole("dialog", { name: "新增客户端订阅" });
  const name = screen.getByRole("textbox", { name: "订阅名称" });
  await userEvent.clear(name);
  await userEvent.type(name, "Tablet");
  let finish!: (response: Response) => void;
  readOutputs = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  act(() => owner.refresh());
  expect(screen.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "value",
    "Tablet",
  );
  await act(async () =>
    finish(json({ error: "Synthetic refresh failed" }, 503)),
  );
  expect(screen.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "value",
    "Tablet",
  );
  readOutputs = async () => json([output]);
  act(() => owner.refresh());
  await waitFor(() =>
    expect(requests.filter(({ method }) => method === "GET")).toHaveLength(3),
  );
  expect(screen.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "value",
    "Tablet",
  );
  expect(screen.getByRole("dialog", { name: "新增客户端订阅" })).toBeTruthy();
  expect(screen.getByText("创建新的客户端订阅，其他订阅不变。")).toBeTruthy();
  expect(screen.queryByRole("radio")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  expect(
    await screen.findByRole("button", { name: "创建并发布「Tablet」" }),
  ).toBeTruthy();
  expect(requests.filter(({ method }) => method === "POST")).toEqual([
    {
      path: "/api/me/outputs/preview",
      method: "POST",
      body: {
        id: expect.stringMatching(/^output_/),
        name: "Tablet",
        profileId: profile.id,
        target: profile.target,
        mode: "full",
      },
    },
  ]);
});

it("waits until a suspended review resumes before presenting first-creation choices", async () => {
  mount({ suspended: true });
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Resume publication" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "新增客户端订阅" }),
  ).toBeTruthy();
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
});

it("never inserts the obsolete target choice during a confirmed first-subscription transition", async () => {
  let finish!: (response: Response) => void;
  readOutputs = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const exposedChoices: string[] = [];
  // Observe the public DOM throughout the read-to-form handoff, not only its
  // settled state: a passive latch must not briefly insert an obsolete choice.
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const added of record.addedNodes) {
        // The delivery-neutral footer names the same object. Watch actual
        // target choices, not unrelated text appearing in the create form.
        if (!(added instanceof Element)) continue;
        const radios = added.matches('input[type="radio"]')
          ? [added]
          : Array.from(added.querySelectorAll('input[type="radio"]'));
        for (const radio of radios)
          if (
            radio.closest("label")?.textContent?.includes("创建新的客户端订阅")
          )
            exposedChoices.push("创建新的客户端订阅");
      }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    mount();
    await screen.findByLabelText("正在加载");
    await act(async () => finish(json([])));
    expect(
      await screen.findByRole("dialog", { name: "新增客户端订阅" }),
    ).toBeTruthy();
    expect(exposedChoices).toEqual([]);
    expect(requests).toEqual([
      { path: "/api/me/outputs", method: "GET", body: null },
    ]);
  } finally {
    observer.disconnect();
  }
});

it("keeps the new-subscription check name stable and reports real busy state before during and after checking", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      if (path === "/api/me/outputs" && method === "GET") return json([]);
      if (path === "/api/me/outputs/preview")
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      throw new Error(`Unexpected request ${method} ${path}`);
    }),
  );
  mount();
  const check = await screen.findByRole("button", {
    name: "检查发布内容",
  });
  expect(check.getAttribute("aria-busy")).not.toBe("true");
  await userEvent.click(check);
  await waitFor(() => {
    const pending = screen.getByRole("button", {
      name: "检查发布内容",
    });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending).toHaveProperty("disabled", true);
  });
  await act(async () =>
    finish(json({ detail: "Synthetic compatibility failure" }, 400)),
  );
  await screen.findByText("Synthetic compatibility failure");
  const retry = screen.getByRole("button", {
    name: "检查发布内容",
  });
  expect(retry.getAttribute("aria-busy")).not.toBe("true");
  expect(retry).toHaveProperty("disabled", false);
  expect(
    screen.queryByRole("button", { name: /loading 检查发布内容/ }),
  ).toBeNull();
  expect(
    requests.filter(({ method }) => method === "POST").map(({ path }) => path),
  ).toEqual(["/api/me/outputs/preview"]);
});
