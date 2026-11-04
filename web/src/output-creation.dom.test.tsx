// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
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
import { useState } from "react";
import { PublishOutput } from "./Subscriptions";
import { RoutingSummaryView } from "./RoutingSummary";
import { emptyProfile } from "./model";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount() {
  const close = vi.fn();
  const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <PublishOutput
        profile={open ? profile : null}
        onClose={() => {
          close();
          setOpen(false);
        }}
      />
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
  return { close, profile };
}
let requests: { path: string; method: string; body: any }[];
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
        method = init?.method || "GET",
        body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: "creation-review",
          previewScope: "new-output",
          outputId: body.id,
          artifacts: [{ path: "config.yaml", content: "reviewed-config" }],
        });
      if (path.endsWith("/access"))
        return json({
          delivery: "bundle",
          downloadPath: "/download/test-config.zip",
        });
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
async function ready() {
  await waitFor(() =>
    expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
      "Daily",
    ),
  );
}

async function expandTechnicalPreview() {
  const disclosure = await screen.findByRole("button", {
    name: "技术配置（可选查看）",
  });
  if (disclosure.getAttribute("aria-expanded") !== "true")
    await userEvent.click(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
}

it("requires review of the exact new subscription identity and publishes only those reviewed fields", async () => {
  const { close } = mount();
  await ready();
  const dialog = screen.getByRole("dialog", { name: "新增客户端订阅" });
  const check = within(dialog).getByRole("button", { name: "检查发布内容" });
  expect((check as HTMLButtonElement).disabled).toBe(false);
  expect(check.getAttribute("data-variant") === "default").toBe(true);
  expect(
    within(dialog).queryByRole("button", { name: /^创建并发布「/ }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "预览此输出" }),
  ).toBeNull();
  const consequence =
    within(dialog).getByText("创建独立的客户端订阅，其他订阅保留原版本。");
  expect(consequence.closest('[data-slot="dialog-footer"]')).toBe(
    check.closest('[data-slot="dialog-footer"]'),
  );
  expect(consequence.closest('[data-slot="dialog-footer"]')).not.toBeNull();
  await userEvent.click(check);
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  const reviewed = requests[0];
  expect(reviewed).toEqual({
    path: "/api/me/outputs/preview",
    method: "POST",
    body: {
      id: expect.stringMatching(/^output_/),
      name: "Daily",
      profileId: "saved-profile",
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
    },
  });
  expect(
    requests.filter(({ path }) => path === "/api/me/outputs"),
  ).toHaveLength(0);
  expect(
    screen
      .getByRole("button", { name: "重新检查" })
      .getAttribute("data-variant") === "default",
  ).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "创建并发布「Daily」" })
      .getAttribute("data-variant") === "default",
  ).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(
    requests.find((request) => request.path === "/api/me/outputs")?.body,
  ).toEqual({ ...reviewed.body, previewDigest: "creation-review" });
});

it("invalidates a creation review when the name, client or output mode changes, retaining the stable identity", async () => {
  mount();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  const first = requests[0].body;
  fireEvent.change(screen.getByLabelText("订阅名称"), {
    target: { value: "Work" },
  });
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "检查发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.queryByText("reviewed-config")).toBeNull();
  await userEvent.click(screen.getByRole("combobox", { name: "目标客户端" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "sing-box 1.14.3" }),
  );
  await userEvent.click(screen.getByRole("combobox", { name: "输出内容" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "纯节点输出" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  expect(requests[1].body).toEqual({
    ...first,
    name: "Work",
    target: { adapterId: "sing-box", version: "1.14.3" },
    mode: "nodes-only",
  });
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await waitFor(() =>
    expect(
      requests.find((request) => request.path === "/api/me/outputs")?.body,
    ).toEqual({ ...requests[1].body, previewDigest: "creation-review" }),
  );
});

it("retains publication choices after stale creation rejection and requires a fresh review before retrying", async () => {
  const original = fetch;
  let previews = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET",
        body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/outputs/preview") {
        requests.push({ path, method, body });
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: `creation-${++previews}`,
          artifacts: [{ path: "config.yaml", content: "reviewed-config" }],
        });
      }
      if (path === "/api/me/outputs") {
        requests.push({ path, method, body });
        return method === "POST"
          ? json({ detail: "配置已变化，请重新预览。" }, 409)
          : json([]);
      }
      return original(url, init);
    }),
  );
  const { close } = mount();
  await ready();
  fireEvent.change(screen.getByLabelText("订阅名称"), {
    target: { value: "Work" },
  });
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await screen.findByText("配置已变化，请重新预览。");
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
    "Work",
  );
  expect(
    screen.getByRole("combobox", { name: "目标客户端" })?.textContent,
  ).toContain("Mihomo 1.19.32");
  expect(
    screen.getByRole("combobox", { name: "输出内容" })?.textContent,
  ).toContain("完整客户端配置");
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "检查发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  const reviews = requests.filter(
    (request) => request.path === "/api/me/outputs/preview",
  );
  expect(reviews[1].body).toEqual(reviews[0].body);
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await waitFor(() =>
    expect(
      requests.filter(
        (request) =>
          request.path === "/api/me/outputs" && request.method === "POST",
      ),
    ).toHaveLength(2),
  );
  expect(
    requests
      .filter(
        (request) =>
          request.path === "/api/me/outputs" && request.method === "POST",
      )
      .map((request) => request.body.previewDigest),
  ).toEqual(["creation-1", "creation-2"]);
});

it("retains publication choices after a failed review and does not enable publication", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ detail: "所选客户端不支持这份配置。" }, 422)),
  );
  mount();
  await ready();
  fireEvent.change(screen.getByLabelText("订阅名称"), {
    target: { value: "Work" },
  });
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await screen.findByText("所选客户端不支持这份配置。");
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
    "Work",
  );
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "检查发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.queryByText("待发布内容")).toBeNull();
});

it.each([
  ["matching creation", {}, true],
  ["missing receipt", { creationReviewDigest: undefined }, false],
  [
    "different review receipt",
    { creationReviewDigest: "unrelated-review" },
    false,
  ],
  ["different output", { id: "unrelated-output" }, false],
  ["different profile", { profileId: "unrelated-profile" }, false],
  ["unpublished output", { status: "revoked" }, false],
])(
  "reconciles a lost publication response only with its exact reviewed receipt: %s",
  async (_case, mismatch, accepted) => {
    const original = fetch;
    let existing: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url) === "/api/me/outputs") {
          const method = init?.method || "GET",
            body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ path: String(url), method, body });
          if (method === "POST") {
            existing = {
              ...body,
              status: "published",
              creationReviewDigest: body.previewDigest,
              ...mismatch,
            };
            throw new TypeError("Lost response");
          }
          return json([existing]);
        }
        return original(url, init);
      }),
    );
    const { close } = mount();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await expandTechnicalPreview();
    await screen.findByText("reviewed-config");
    await userEvent.click(
      screen.getByRole("button", { name: /^创建并发布「/ }),
    );
    if (accepted) {
      await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      await screen.findByText("获取「Daily」");
    } else {
      await screen.findByText(
        "无法连接服务。请检查网络后重试，当前输入已保留。",
      );
      expect(close).not.toHaveBeenCalled();
      expect(
        (screen.getByLabelText("订阅名称") as HTMLInputElement).value,
      ).toBe("Daily");
      expect(
        (
          screen.getByRole("button", {
            name: "重试上次发布",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    }
    expect(
      requests.filter(
        (request) =>
          request.path === "/api/me/outputs" && request.method === "POST",
      ),
    ).toHaveLength(1);
  },
);

it("retries the same reviewed creation when its response and first authoritative lookup are unavailable", async () => {
  const original = fetch;
  let existing: any;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/me/outputs") {
        const method = init?.method || "GET",
          body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: String(url), method, body });
        if (method === "POST") {
          if (existing) return json({ detail: "Output already exists" }, 409);
          existing = {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          };
          throw new TypeError("Lost creation response");
        }
        if (++reads === 1) throw new TypeError("Lookup unavailable");
        return json([existing]);
      }
      return original(url, init);
    }),
  );
  const { close } = mount();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await screen.findByRole("alert");
  expect(close).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "重试上次发布" });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(retry);
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  const attempts = requests.filter(
    (request) =>
      request.path === "/api/me/outputs" && request.method === "POST",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1].body).toEqual(attempts[0].body);
  expect(
    requests.filter((request) => request.path === "/api/me/outputs/preview"),
  ).toHaveLength(1);
});

it("keeps a definite stale-review rejection distinct from a failed lookup", async () => {
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/me/outputs") {
        if (init?.method === "POST")
          return json({ detail: "Review is stale; preview again" }, 409);
        throw new TypeError("Lookup unavailable");
      }
      return original(url, init);
    }),
  );
  mount();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("Review is stale");
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "检查发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("keeps an unresolved creation recoverable after a duplicate rejection and repeated unavailable or empty lookups", async () => {
  const original = fetch;
  let existing: any;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/me/outputs") {
        const method = init?.method || "GET",
          body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: String(url), method, body });
        if (method === "POST") {
          if (existing) return json({ error: "output id already exists" }, 409);
          existing = {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          };
          throw new TypeError("Lost response");
        }
        if (++reads <= 2) throw new TypeError("Lookup unavailable");
        return json(reads === 3 ? [] : [existing]);
      }
      return original(url, init);
    }),
  );
  const { close } = mount();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "重试上次发布" }));
  await screen.findByText("output id already exists");
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: "重试上次发布" })).toHaveLength(
    1,
  );
  expect(screen.getByRole("button", { name: "重试上次发布" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(screen.queryByRole("button", { name: "检查发布内容" })).toBeNull();
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).disabled).toBe(
    true,
  );
  expect(close).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "核对上次发布结果" }),
  );
  await screen.findByText("尚未确认上次发布结果，请稍后继续核对。");
  expect(close).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "核对上次发布结果" }),
  );
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  const attempts = requests.filter(
    (request) =>
      request.path === "/api/me/outputs" && request.method === "POST",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1].body).toEqual(attempts[0].body);
  expect(
    requests.filter((request) => request.path === "/api/me/outputs/preview"),
  ).toHaveLength(1);
});

it("retries the exact frozen creation after request loss before acceptance and an empty lookup", async () => {
  const original = fetch;
  const attempts: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/me/outputs") {
        if (init?.method !== "POST") return json([]);
        const body = JSON.parse(String(init.body));
        attempts.push(body);
        if (attempts.length === 1)
          throw new TypeError("Request never accepted");
        return json(
          {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          },
          201,
        );
      }
      return original(url, init);
    }),
  );
  const { close } = mount();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await screen.findByRole("alert");
  await userEvent.click(
    screen.getByRole("button", { name: "核对上次发布结果" }),
  );
  await screen.findByText("尚未确认上次发布结果，请稍后继续核对。");
  expect(close).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "重试上次发布" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});

it("unlocks a rejected unresolved creation for a fresh review without replacing its output identity", async () => {
  const original = fetch;
  const attempts: any[] = [];
  let previews = 0;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/outputs/preview")
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: `creation-${++previews}`,
          artifacts: [{ path: "config.yaml", content: "reviewed-config" }],
        });
      if (path === "/api/me/outputs") {
        if (init?.method !== "POST") {
          if (++reads === 1) throw new TypeError("Lookup unavailable");
          return json([]);
        }
        attempts.push(body);
        if (attempts.length === 1)
          throw new TypeError("Creation outcome unknown");
        if (attempts.length === 2)
          return json({ detail: "Review is stale; preview again" }, 409);
        return json(
          {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          },
          201,
        );
      }
      return original(url, init);
    }),
  );
  const { close } = mount();
  await ready();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "重试上次发布" }));
  await screen.findByText("Review is stale; preview again");
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).disabled).toBe(
    false,
  );
  expect(screen.queryByRole("button", { name: "重试上次发布" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "检查发布内容" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("订阅名称"), {
    target: { value: "Revised daily" },
  });
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await expandTechnicalPreview();
  await screen.findByText("reviewed-config");
  await userEvent.click(screen.getByRole("button", { name: /^创建并发布「/ }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(attempts).toHaveLength(3);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual({
    ...attempts[0],
    name: "Revised daily",
    previewDigest: "creation-2",
  });
});

it("keeps the pending check separate from publication and states the pure-node consequence once", async () => {
  const original = fetch;
  let completeCheck!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) !== "/api/me/outputs/preview") return original(url, init);
      const body = JSON.parse(String(init?.body));
      requests.push({ path: String(url), method: init?.method || "GET", body });
      return new Promise<Response>((resolve) => {
        completeCheck = resolve;
      });
    }),
  );
  mount();
  await ready();
  await userEvent.click(screen.getByRole("combobox", { name: "输出内容" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "纯节点输出" }),
  );
  const dialog = screen.getByRole("dialog", { name: "新增客户端订阅" });
  expect(
    within(dialog).getAllByText("仅包含节点连接。"),
  ).toHaveLength(1);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "检查发布内容" }),
  );
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(
    (
      within(dialog).getByRole("button", {
        name: /检查发布内容/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (within(dialog).getByLabelText("订阅名称") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    within(dialog).queryByRole("button", { name: /^创建并发布「/ }),
  ).toBeNull();
  expect(within(dialog).queryByText("兼容检查通过。")).toBeNull();
  await act(async () =>
    completeCheck(
      json({
        valid: true,
        previewDigest: "node-review",
        previewScope: "new-output",
        outputId: requests[0].body.id,
        routingSummary: { version: 1, kind: "nodes-only" },
        diagnostics: ["所选客户端的节点格式已检查。"],
        artifacts: [{ path: "nodes.yaml", content: "checked-nodes" }],
      }),
    ),
  );
  await screen.findByText("兼容检查通过。");
  expect(
    within(dialog).getAllByText("仅包含节点连接。"),
  ).toHaveLength(1);
  expect(within(dialog).queryByText("纯节点订阅，仅交付连接。")).toBeNull();
  expect(within(dialog).getByText("所选客户端的节点格式已检查。")).toBeTruthy();
  const technicalPanel = within(dialog)
    .getByText("checked-nodes")
    .closest('[data-slot="accordion-content"]')!;
  expect(technicalPanel.getAttribute("data-state")).toBe("closed");
  // jsdom does not load Tailwind; browser geometry verifies that closed content is hidden.
  expect(technicalPanel.classList.contains("data-[state=closed]:hidden")).toBe(
    true,
  );
  await expandTechnicalPreview();
  expect(within(dialog).getByText("checked-nodes")).toBeTruthy();
  expect(
    within(dialog).getAllByText("新建独立链接，其他订阅保留原版本。"),
  ).toHaveLength(1);
  expect(
    within(dialog)
      .getByText("新建独立链接，其他订阅保留原版本。")
      .closest('[data-slot="dialog-footer"]'),
  ).not.toBeNull();
  expect(
    within(dialog).queryByText(/已部署|客户端已生效|客户端已加载/),
  ).toBeNull();
  expect(requests).toHaveLength(1);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "重新检查" }),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(
    within(dialog).queryByRole("button", { name: /^创建并发布「/ }),
  ).toBeNull();
  expect(requests.every(({ path }) => path === "/api/me/outputs/preview")).toBe(
    true,
  );
  await act(async () =>
    completeCheck(
      json({
        valid: true,
        previewDigest: "node-recheck",
        previewScope: "new-output",
        outputId: requests[1].body.id,
        routingSummary: { version: 1, kind: "nodes-only" },
        artifacts: [{ path: "nodes.yaml", content: "rechecked-nodes" }],
      }),
    ),
  );
  await screen.findByText("兼容检查通过。");
  expect(requests).toHaveLength(2);
  expect(requests[1].body).toEqual(requests[0].body);
});

it("retains the pure-node explanation in standalone summaries without a mode field", () => {
  render(<RoutingSummaryView summary={{ version: 1, kind: "nodes-only" }} />);
  expect(screen.getByText("纯节点订阅，仅交付连接。")).toBeTruthy();
});

it.each([
  ["invalid result", { valid: false }],
  ["missing digest", { previewDigest: undefined }],
  ["wrong review scope", { previewScope: "existing-output" }],
  ["different output identity", { outputId: "other-output" }],
  ["missing rendered content", { artifacts: [] }],
])(
  "keeps %s unreviewed without offering or creating a subscription",
  async (_name, invalid) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({
          path: String(url),
          method: init?.method || "GET",
          body,
        });
        return json({
          valid: true,
          previewDigest: "not-accepted",
          previewScope: "new-output",
          outputId: body.id,
          artifacts: [{ path: "config.yaml", content: "unchecked" }],
          ...invalid,
        });
      }),
    );
    mount();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await screen.findByText("这份订阅未通过检查，请检查配置和客户端选择。");
    expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "检查发布内容",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText("兼容检查通过。")).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/api/me/outputs/preview");
  },
);

it.each(["name", "client", "mode"])(
  "returns to checking when only the reviewed %s changes",
  async (field) => {
    mount();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await screen.findByText("兼容检查通过。");
    if (field === "name")
      fireEvent.change(screen.getByLabelText("订阅名称"), {
        target: { value: "Changed name" },
      });
    else {
      await userEvent.click(
        screen.getByRole("combobox", {
          name: field === "client" ? "目标客户端" : "输出内容",
        }),
      );
      await userEvent.click(
        await screen.findByRole("option", {
          name: field === "client" ? "sing-box 1.14.3" : "纯节点输出",
        }),
      );
    }
    expect(screen.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
    const check = screen.getByRole("button", { name: "检查发布内容" });
    expect((check as HTMLButtonElement).disabled).toBe(false);
    expect(check.getAttribute("data-variant") === "default").toBe(true);
    expect(screen.queryByText("兼容检查通过。")).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe("/api/me/outputs/preview");
  },
);

it.each(["double click", "held Enter"])(
  "does not treat a check's %s continuation as explicit publication",
  async (gesture) => {
    mount();
    await ready();
    const check = screen.getByRole("button", { name: "检查发布内容" });
    if (gesture === "double click") await userEvent.dblClick(check);
    else {
      check.focus();
      await userEvent.keyboard("{Enter>3/}");
    }
    await screen.findByText("兼容检查通过。");
    expect(
      requests.filter(({ path }) => path === "/api/me/outputs"),
    ).toHaveLength(0);
    expect(
      requests.filter(({ path }) => path === "/api/me/outputs/preview"),
    ).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("button", { name: "创建并发布「Daily」" }),
    );
    await waitFor(() =>
      expect(
        requests.filter(({ path }) => path === "/api/me/outputs"),
      ).toHaveLength(1),
    );
  },
);
