// @vitest-environment jsdom
// Real resource controls with synthetic HTTP responses; no browser geometry claim.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "@/ui-patterns/providers";
import { ResourcesPage } from "@/Resources";
import { setCSRF, setToken } from "@/api";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
const inspected = {
  digest: `sha256:${"a".repeat(64)}`,
  format: "mihomo-yaml",
  formatVersion: 0,
  bytes: 27,
  entries: 3,
  inspection: "bounded-yaml-envelope",
  nativeChecked: false,
};
const invalidInspection = "无法确认规则文件检查结果。原有输入已保留，请重新读取文件。";
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
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
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/me/resources" && (!init?.method || init.method === "GET")) return json([]);
    if (url === "/api/me/resources/inspect" && init?.method === "POST") {
      return new Promise<Response>((release) => requests.push({ ...JSON.parse(String(init.body)), release }));
    }
    if (url === "/api/me/resources" && init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return json({});
    }
    throw new Error(`Unexpected HTTP ${init?.method || "GET"} ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><ResourcesPage /></UIProviders></QueryClientProvider>);
  return { requests, writes };
}
async function open() {
  await screen.findByText("暂无规则资源");
  await userEvent.click(screen.getByRole("button", { name: "添加公开引用" }));
  const dialog = await screen.findByRole("dialog", { name: "添加公开规则引用" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "资源名称" }), { target: { value: "Public rules" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "规则文件 URL" }), { target: { value: "https://example.test/rules" } });
  return dialog;
}
const digestInput = (dialog: HTMLElement) => within(dialog).getByRole("textbox", { name: "SHA-256 校验值" }) as HTMLInputElement;
const inspectButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "读取文件并计算校验值" });
async function inspect(dialog: HTMLElement, requests: ReturnType<typeof mount>["requests"]) {
  const previous = requests.length;
  await userEvent.click(inspectButton(dialog));
  await waitFor(() => expect(requests).toHaveLength(previous + 1));
  return requests[previous];
}
async function settle(request: ReturnType<typeof mount>["requests"][number], value: unknown) {
  await act(async () => {
    request.release(json(value));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("rejects an inspection for another format without changing trusted input and can retry", async () => {
  const { requests, writes } = mount();
  const dialog = await open();
  fireEvent.change(digestInput(dialog), { target: { value: "b".repeat(64) } });
  const first = await inspect(dialog, requests);
  expect(first.format).toBe("mihomo-yaml");
  await settle(first, { ...inspected, format: "sing-box-source", formatVersion: 5, inspection: "bounded-json-envelope" });
  await within(dialog).findByText(invalidInspection);
  expect(digestInput(dialog).value).toBe("b".repeat(64));
  expect(within(dialog).queryByText(/已读取/)).toBeNull();
  expect(writes).toEqual([]);
  const retry = await inspect(dialog, requests);
  expect(retry.url).toBe(first.url);
  expect(retry.format).toBe(first.format);
  await settle(retry, inspected);
  await within(dialog).findByText(/已读取 3 条记录，共 27 B/);
  expect(within(dialog).queryByText(invalidInspection)).toBeNull();
  expect(digestInput(dialog).value).toBe(inspected.digest);
  expect(writes).toEqual([]);
  await userEvent.click(within(dialog).getByRole("button", { name: "保存公开引用" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ format: "mihomo-yaml", digest: inspected.digest, url: first.url });
  expect(writes[0]).not.toHaveProperty("formatVersion");
});

it.each([
  ["null", null],
  ["array", []],
  ["empty object", {}],
  ["object entry count", { ...inspected, entries: { count: 3 } }],
  ["negative entry count", { ...inspected, entries: -1 }],
  ["fractional entry count", { ...inspected, entries: 0.5 }],
  ["excessive entry count", { ...inspected, entries: 100001 }],
  ["string byte count", { ...inspected, bytes: "27" }],
  ["empty file", { ...inspected, bytes: 0 }],
  ["excessive byte count", { ...inspected, bytes: 8388609 }],
  ["object digest", { ...inspected, digest: { sha256: "a".repeat(64) } }],
  ["invalid digest", { ...inspected, digest: "not-a-checksum" }],
  ["digest newline", { ...inspected, digest: `${inspected.digest}\n` }],
  ["missing format", { ...inspected, format: undefined }],
  ["missing version", { ...inspected, formatVersion: undefined }],
  ["unexpected YAML version", { ...inspected, formatVersion: 1 }],
  ["invalid inspection level", { ...inspected, inspection: {} }],
  ["native-validation claim", { ...inspected, nativeChecked: true }],
])("rejects malformed current inspection with %s without filling or saving the draft", async (_label, value) => {
  const { requests, writes } = mount();
  const dialog = await open();
  await settle(await inspect(dialog, requests), value);
  await within(dialog).findByText(invalidInspection);
  expect(digestInput(dialog).value).toBe("");
  expect(within(dialog).queryByText(/已读取/)).toBeNull();
  expect(inspectButton(dialog).hasAttribute("disabled")).toBe(false);
  expect((within(dialog).getByRole("textbox", { name: "资源名称" }) as HTMLInputElement).value).toBe("Public rules");
  expect((within(dialog).getByRole("textbox", { name: "规则文件 URL" }) as HTMLInputElement).value).toBe("https://example.test/rules");
  await userEvent.click(within(dialog).getByRole("button", { name: "保存公开引用" }));
  await within(dialog).findByText("请先读取文件或填写可信文件的 SHA-256 校验值");
  expect(writes).toEqual([]);
});

async function selectSingBox(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("combobox", { name: "文件格式" }));
  await userEvent.click(await screen.findByRole("option", { name: "sing-box JSON" }));
  return within(dialog).getByRole("spinbutton", { name: "sing-box 规则格式版本" }) as HTMLInputElement;
}
it.each([undefined, null, "3", 0, 6, 2.5])("keeps trusted digest and version when sing-box inspection has invalid version %s", async (formatVersion) => {
  const { requests, writes } = mount();
  const dialog = await open();
  const version = await selectSingBox(dialog);
  fireEvent.change(version, { target: { value: "2" } });
  fireEvent.change(digestInput(dialog), { target: { value: "b".repeat(64) } });
  await settle(await inspect(dialog, requests), {
    ...inspected, format: "sing-box-source", formatVersion, inspection: "bounded-json-envelope",
  });
  await within(dialog).findByText(invalidInspection);
  expect(digestInput(dialog).value).toBe("b".repeat(64));
  expect(version.value).toBe("2");
  expect(within(dialog).queryByText(/已读取/)).toBeNull();
  expect(writes).toEqual([]);
  // Inspection remains optional for a user-supplied trusted checksum/version.
  await userEvent.click(within(dialog).getByRole("button", { name: "保存公开引用" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ digest: "b".repeat(64), formatVersion: 2, format: "sing-box-source" });
});

it.each([1, 5])("accepts sing-box version %s with zero rules and only saves after an explicit action", async (formatVersion) => {
  const { requests, writes } = mount();
  const dialog = await open();
  const version = await selectSingBox(dialog);
  const pending = await inspect(dialog, requests);
  expect(pending.format).toBe("sing-box-source");
  await settle(pending, {
    ...inspected, format: "sing-box-source", formatVersion, entries: 0, bytes: 24, inspection: "bounded-json-envelope",
  });
  await within(dialog).findByText(/已读取 0 条记录，共 24 B/);
  expect(digestInput(dialog).value).toBe(inspected.digest);
  expect(version.value).toBe(String(formatVersion));
  expect(writes).toEqual([]);
  await userEvent.click(within(dialog).getByRole("button", { name: "保存公开引用" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ digest: inspected.digest, formatVersion, format: "sing-box-source", url: pending.url });
});

it("does not attribute a stale malformed response to a newer pending source inspection", async () => {
  const { requests, writes } = mount();
  const dialog = await open();
  const old = await inspect(dialog, requests);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "规则文件 URL" }), { target: { value: "https://new.example.test/rules" } });
  const current = await inspect(dialog, requests);
  await settle(old, { ...inspected, entries: { count: 3 } });
  expect(within(dialog).queryByText(invalidInspection)).toBeNull();
  expect(within(dialog).queryByText(/已读取/)).toBeNull();
  expect(digestInput(dialog).value).toBe("");
  expect(inspectButton(dialog).hasAttribute("disabled")).toBe(true);
  expect(within(dialog).getByRole("button", { name: "保存公开引用" }).hasAttribute("disabled")).toBe(true);
  expect(writes).toEqual([]);
  await settle(current, { ...inspected, digest: "c".repeat(64) });
  await within(dialog).findByText(/已读取 3 条记录，共 27 B/);
  expect(digestInput(dialog).value).toBe("c".repeat(64));
  expect(within(dialog).queryByText(invalidInspection)).toBeNull();
});

it("does not replace a manually revised sing-box version with a late inspection", async () => {
  const { requests, writes } = mount();
  const dialog = await open();
  const version = await selectSingBox(dialog);
  fireEvent.change(digestInput(dialog), { target: { value: "b".repeat(64) } });
  const pending = await inspect(dialog, requests);
  fireEvent.change(version, { target: { value: "2" } });
  await settle(pending, { ...inspected, format: "sing-box-source", formatVersion: 5, inspection: "bounded-json-envelope" });
  expect(version.value).toBe("2");
  expect(digestInput(dialog).value).toBe("b".repeat(64));
  expect(within(dialog).queryByText(/已读取/)).toBeNull();
  expect(within(dialog).queryByText(invalidInspection)).toBeNull();
  expect(writes).toEqual([]);
});
