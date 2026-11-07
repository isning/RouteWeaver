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
function mount(initial: unknown[] = []) {
  const writes: unknown[] = [];
  const requests: {
    url: string;
    format: string;
    release: (response: Response) => void;
    signal?: AbortSignal | null;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url === "/api/me/resources" &&
        (!init?.method || init.method === "GET")
      )
        return json(initial);
      if (url === "/api/me/resources/inspect" && init?.method === "POST")
        return new Promise<Response>((release) =>
          requests.push({ ...JSON.parse(String(init.body)), release, signal: init.signal }),
        );
      if ((url === "/api/me/resources" && init?.method === "POST") || (url.startsWith("/api/me/resources/") && init?.method === "PUT")) {
        writes.push(JSON.parse(String(init.body)));
        return json({});
      }
      throw new Error(`Unexpected HTTP ${init?.method || "GET"} ${url}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ResourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { requests, writes, unmount: view.unmount };
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
  requests: ReturnType<typeof mount>["requests"],
) {
  const button = within(dialog).getByRole("button", {
    name: "读取文件并计算校验值",
  });
  await userEvent.click(button);
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  return button;
}

// Source-only reconstruction: all behavior checks remain UNRUN.
function fill(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: "资源名称" }), {
    target: { value: "Public rules" },
  });
  changeURL(dialog, "https://example.test/rules.yaml");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "SHA-256 校验值" }), {
    target: { value: "b".repeat(64) },
  });
}
it.each(["", "-", "1e", "59", "2592001", "60.000000000000000001", " 60 ", "6e999999999999999999"])(
  "retains invalid interval %s and prevents HTTP save until corrected",
  async (raw) => {
    const { writes } = mount();
    const dialog = await open();
    fill(dialog);
    const interval = within(dialog).getByRole("spinbutton", { name: "客户端更新间隔（秒）" });
    fireEvent.change(interval, { target: { value: raw } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(within(dialog).getByText("请输入 60 到 2592000 之间的整数")).toBeTruthy());
    expect((interval as HTMLInputElement).value).toBe(raw);
    expect(writes).toEqual([]);
    fireEvent.change(interval, { target: { value: "60" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ intervalSeconds: 60, revision: "1", digest: "b".repeat(64) });
  },
);
it.each(["86400", "6e1", "60.000", "2592000"])("saves exact integral interval %s as a number", async (raw) => {
  const { writes } = mount();
  const dialog = await open();
  fill(dialog);
  if (raw !== "86400") fireEvent.change(within(dialog).getByRole("spinbutton", { name: "客户端更新间隔（秒）" }), { target: { value: raw } });
  fireEvent.submit(dialog.querySelector("form")!);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ intervalSeconds: raw === "86400" ? 86400 : raw === "2592000" ? 2592000 : 60 });
});
it("blocks explicit and form submission while inspection owns the current draft", async () => {
  const { requests, writes } = mount();
  const dialog = await open();
  fill(dialog);
  await inspect(dialog, requests);
  expect(within(dialog).getByRole("button", { name: "保存公开引用" }).hasAttribute("disabled")).toBe(true);
  fireEvent.submit(dialog.querySelector("form")!);
  await act(async () => { await Promise.resolve(); });
  expect(writes).toEqual([]);
  await act(async () => requests[0].release(json({ digest: "a".repeat(64), entries: 3, bytes: 27 })));
  await within(dialog).findByText(/已读取 3 条记录/);
  fireEvent.submit(dialog.querySelector("form")!);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ digest: "a".repeat(64), intervalSeconds: 86400 });
});
it.each(["success", "error"])("aborts inspection and ignores stale %s after a manual digest edit", async (outcome) => {
  const { requests } = mount();
  const dialog = await open();
  fill(dialog);
  await inspect(dialog, requests);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "SHA-256 校验值" }), { target: { value: "c".repeat(64) } });
  expect(requests[0].signal?.aborted).toBe(true);
  await act(async () => requests[0].release(outcome === "success" ? json({ digest: "a".repeat(64), entries: 3, bytes: 27 }) : json({ detail: "Stale inspection" }, 422)));
  expect((within(dialog).getByRole("textbox", { name: "SHA-256 校验值" }) as HTMLInputElement).value).toBe("c".repeat(64));
  expect(within(dialog).queryByText(/已读取|Stale inspection/)).toBeNull();
});

it.each(["0", "6", "1.000000000000000001", "1e", ""])("rejects invalid sing-box format version %s without rounding", async (raw) => {
  const { writes } = mount();
  const dialog = await open();
  fill(dialog);
  await userEvent.click(within(dialog).getByRole("combobox", { name: "文件格式" }));
  await userEvent.click(await screen.findByRole("option", { name: "sing-box JSON" }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "SHA-256 校验值" }), { target: { value: "b".repeat(64) } });
  const version = within(dialog).getByRole("spinbutton", { name: "sing-box 规则格式版本" });
  fireEvent.change(version, { target: { value: raw } });
  fireEvent.submit(dialog.querySelector("form")!);
  await within(dialog).findByText("请输入 1 到 5 之间的整数");
  expect((version as HTMLInputElement).value).toBe(raw);
  expect(writes).toEqual([]);
  fireEvent.change(version, { target: { value: "5" } });
  fireEvent.submit(dialog.querySelector("form")!);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ format: "sing-box-source", formatVersion: 5, intervalSeconds: 86400 });
});
it("accepts a current inspection after unrelated resource name and interval edits", async () => {
  const { requests } = mount();
  const dialog = await open();
  fill(dialog);
  await inspect(dialog, requests);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "资源名称" }), { target: { value: "Renamed" } });
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: "客户端更新间隔（秒）" }), { target: { value: "120" } });
  expect(requests[0].signal?.aborted).toBe(false);
  await act(async () => requests[0].release(json({ digest: "a".repeat(64), entries: 3, bytes: 27 })));
  await within(dialog).findByText(/已读取 3 条记录/);
});
it("aborts active inspection when the page unmounts", async () => {
  const { requests, unmount } = mount();
  const dialog = await open();
  fill(dialog);
  await inspect(dialog, requests);
  unmount();
  expect(requests[0].signal?.aborted).toBe(true);
  await act(async () => requests[0].release(json({ detail: "Unmounted inspection" }, 422)));
  expect(screen.queryByText("Unmounted inspection")).toBeNull();
});

it("keeps resource numeric arrow controls and reports their current value", async () => {
  mount();
  const dialog = await open();
  const interval = within(dialog).getByRole("spinbutton", { name: "客户端更新间隔（秒）" });
  expect(interval.getAttribute("aria-valuenow")).toBe("86400");
  fireEvent.keyDown(interval, { key: "ArrowUp" });
  expect((interval as HTMLInputElement).value).toBe("86401");
  expect(interval.getAttribute("aria-valuenow")).toBe("86401");
  fireEvent.keyDown(interval, { key: "ArrowDown" });
  expect((interval as HTMLInputElement).value).toBe("86400");
  fireEvent.change(interval, { target: { value: "60" } });
  fireEvent.keyDown(interval, { key: "ArrowDown" });
  expect((interval as HTMLInputElement).value).toBe("60");
});

it("treats an incomplete numeric edit as unsaved and resets it only after discard", async () => {
  mount();
  const dialog = await open();
  const interval = within(dialog).getByRole("spinbutton", { name: "客户端更新间隔（秒）" });
  fireEvent.change(interval, { target: { value: "-" } });
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  let decision = await screen.findByRole("alertdialog", { name: "放弃未保存的规则资源修改？" });
  await userEvent.click(within(decision).getByRole("button", { name: "继续编辑" }));
  expect((interval as HTMLInputElement).value).toBe("-");
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  decision = await screen.findByRole("alertdialog", { name: "放弃未保存的规则资源修改？" });
  await userEvent.click(within(decision).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加公开规则引用" })).toBeNull());
  const fresh = await open();
  expect((within(fresh).getByRole("spinbutton", { name: "客户端更新间隔（秒）" }) as HTMLInputElement).value).toBe("86400");
});

it("preserves existing valid resource numbers and payload identity when saved unchanged", async () => {
  const { writes } = mount([{
    id: "existing-rules", name: "Existing rules", revision: "custom-version",
    digest: "d".repeat(64), format: "sing-box-source", formatVersion: 1,
    behavior: "domain", location: "remote", url: "https://example.test/existing.json",
    visibility: "public", updatePolicy: "follow", intervalSeconds: 2592000,
  }]);
  await userEvent.click(await screen.findByRole("button", { name: "Existing rules" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑公开规则引用" });
  fireEvent.submit(dialog.querySelector("form")!);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ id: "existing-rules", revision: "custom-version", digest: "d".repeat(64), formatVersion: 1, intervalSeconds: 2592000 });
});

it.each([
  ["", "ArrowUp", "60", null],
  ["-", "ArrowUp", "60", null],
  ["1e", "ArrowUp", "60", null],
  ["59", "ArrowUp", "60", "59"],
  ["59", "ArrowDown", "60", "59"],
  ["2592001", "ArrowDown", "2592000", "2592001"],
  ["60.5", "ArrowUp", "61.5", "60.5"],
])("preserves baseline stepping from %s with %s", async (raw, key, expected, ariaNow) => {
  mount();
  const dialog = await open();
  const interval = within(dialog).getByRole("spinbutton", { name: "客户端更新间隔（秒）" });
  fireEvent.change(interval, { target: { value: raw } });
  expect(interval.getAttribute("aria-valuenow")).toBe(ariaNow);
  fireEvent.keyDown(interval, { key });
  expect((interval as HTMLInputElement).value).toBe(expected);
  expect(interval.getAttribute("aria-valuenow")).toBe(expected);
});
