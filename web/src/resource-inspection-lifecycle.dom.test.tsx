// @vitest-environment jsdom
// Actual task controls and synthetic HTTP responses; no browser geometry claim.
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "@/ui-patterns/providers";
import { ResourcesPage } from "@/Resources";
import { setCSRF, setToken } from "@/api";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function mount() {
  const requests: {
    url: string;
    format: string;
    release: (response: Response) => void;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url === "/api/me/resources" &&
        (!init?.method || init.method === "GET")
      )
        return json([]);
      if (url === "/api/me/resources/inspect" && init?.method === "POST")
        return new Promise<Response>((release) =>
          requests.push({ ...JSON.parse(String(init.body)), release }),
        );
      throw new Error(`Unexpected HTTP ${init?.method || "GET"} ${url}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ResourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  return requests;
}
async function open() {
  await screen.findByText("暂无规则资源");
  await userEvent.click(screen.getByRole("button", { name: "添加公开引用" }));
  return screen.findByRole("dialog", { name: "添加公开规则引用" });
}
function changeURL(dialog: HTMLElement, value: string) {
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "规则文件 URL" }),
    { target: { value } },
  );
}
async function inspect(
  dialog: HTMLElement,
  requests: ReturnType<typeof mount>,
) {
  const button = within(dialog).getByRole("button", {
    name: "读取文件并计算校验值",
  });
  await userEvent.click(button);
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  return button;
}
it("does not attribute a late inspection failure to a different current URL", async () => {
  const requests = mount();
  const dialog = await open();
  changeURL(dialog, "https://old.example.test/rules.yaml");
  const button = await inspect(dialog, requests);
  expect(requests[0].url).toBe("https://old.example.test/rules.yaml");
  changeURL(dialog, "https://new.example.test/rules.yaml");
  await act(async () =>
    requests[0].release(json({ detail: "Old rules inspection failed" }, 422)),
  );
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "规则文件 URL",
      }) as HTMLInputElement
    ).value,
  ).toBe("https://new.example.test/rules.yaml");
  expect(within(dialog).queryByText("Old rules inspection failed")).toBeNull();
});
const inspected = {
  digest: "a".repeat(64),
  format: "mihomo-yaml",
  formatVersion: 0,
  bytes: 27,
  entries: 3,
  inspection: "bounded-yaml-envelope",
  nativeChecked: false,
};
async function settle(
  request: ReturnType<typeof mount>[number],
  response: Response,
) {
  await act(async () => {
    request.release(response);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function discard(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: "放弃未保存的规则资源修改？",
  });
  await userEvent.click(
    within(confirm).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "添加公开规则引用" }),
    ).toBeNull(),
  );
}
it("keeps a new URL empty when the previous URL inspection succeeds late", async () => {
  const requests = mount();
  const dialog = await open();
  changeURL(dialog, "https://old.example.test/rules.yaml");
  const button = await inspect(dialog, requests);
  changeURL(dialog, "https://new.example.test/rules.yaml");
  await settle(requests[0], json(inspected));
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "SHA-256 校验值",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  expect(within(dialog).queryByText(/已读取/)).toBeNull();
});
it.each(["success", "error"] as const)(
  "does not carry the previous dialog inspection %s into a reopened draft",
  async (outcome) => {
    const requests = mount();
    const first = await open();
    changeURL(first, "https://old.example.test/rules.yaml");
    await inspect(first, requests);
    await discard(first);
    const second = await open();
    changeURL(second, "https://new.example.test/rules.yaml");
    await settle(
      requests[0],
      outcome === "success"
        ? json(inspected)
        : json({ detail: "Old rules inspection failed" }, 422),
    );
    expect(
      (
        within(second).getByRole("textbox", {
          name: "SHA-256 校验值",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(within(second).queryByText(/已读取/)).toBeNull();
    expect(
      within(second).queryByText("Old rules inspection failed"),
    ).toBeNull();
  },
);
it("clears an existing inspection error when the URL is corrected", async () => {
  const requests = mount();
  const dialog = await open();
  changeURL(dialog, "https://old.example.test/rules.yaml");
  await inspect(dialog, requests);
  await settle(
    requests[0],
    json({ detail: "Old rules inspection failed" }, 422),
  );
  await within(dialog).findByText("Old rules inspection failed");
  changeURL(dialog, "https://new.example.test/rules.yaml");
  expect(within(dialog).queryByText("Old rules inspection failed")).toBeNull();
});
it("does not attribute a late inspection error to a different current format", async () => {
  const requests = mount();
  const dialog = await open();
  changeURL(dialog, "https://same.example.test/rules");
  const button = await inspect(dialog, requests);
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "文件格式" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "sing-box JSON" }),
  );
  await settle(
    requests[0],
    json({ detail: "Old format inspection failed" }, 422),
  );
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  expect(
    within(dialog).getByRole("combobox", { name: "文件格式" }).textContent,
  ).toBe("sing-box JSON");
  expect(within(dialog).queryByText("Old format inspection failed")).toBeNull();
});
it("shows a current inspection failure and allows successful retry with the same URL", async () => {
  const requests = mount();
  const dialog = await open();
  changeURL(dialog, "https://same.example.test/rules.yaml");
  const button = await inspect(dialog, requests);
  await settle(
    requests[0],
    json({ detail: "Current rules inspection failed" }, 422),
  );
  await within(dialog).findByText("Current rules inspection failed");
  await userEvent.click(button);
  await waitFor(() => expect(requests.length).toBe(2));
  await settle(requests[1], json(inspected));
  await within(dialog).findByText(/已读取 3 条记录，共 27 B/);
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "SHA-256 校验值",
      }) as HTMLInputElement
    ).value,
  ).toBe("a".repeat(64));
  expect(
    within(dialog).queryByText("Current rules inspection failed"),
  ).toBeNull();
});

it.each(["success", "error"] as const)(
  "keeps replacement request B after stale request A returns %s",
  async (outcome) => {
    const requests = mount();
    const dialog = await open();
    changeURL(dialog, "https://old.example.test/rules.yaml");
    await inspect(dialog, requests);
    changeURL(dialog, "https://new.example.test/rules.yaml");
    const button = within(dialog).getByRole("button", {
      name: "读取文件并计算校验值",
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    await userEvent.click(button);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].url).toBe("https://new.example.test/rules.yaml");
    await settle(
      requests[1],
      json({ ...inspected, digest: "b".repeat(64), entries: 7 }),
    );
    await within(dialog).findByText(/已读取 7 条记录，共 27 B/);
    await settle(
      requests[0],
      outcome === "success"
        ? json(inspected)
        : json({ detail: "Stale A inspection failed" }, 422),
    );
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "SHA-256 校验值",
        }) as HTMLInputElement
      ).value,
    ).toBe("b".repeat(64));
    expect(within(dialog).getByText(/已读取 7 条记录，共 27 B/)).toBeTruthy();
    expect(within(dialog).queryByText("Stale A inspection failed")).toBeNull();
    expect(button.hasAttribute("disabled")).toBe(false);
  },
);

it("keeps a current inspection error when only the display name changes", async () => {
  const requests = mount();
  const dialog = await open();
  changeURL(dialog, "https://same.example.test/rules.yaml");
  await inspect(dialog, requests);
  await settle(
    requests[0],
    json({ detail: "Current rules inspection failed" }, 422),
  );
  await within(dialog).findByText("Current rules inspection failed");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "资源名称" }), {
    target: { value: "Renamed rules" },
  });
  expect(
    within(dialog).getByText("Current rules inspection failed"),
  ).toBeTruthy();
});
