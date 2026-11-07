// @vitest-environment jsdom
// Source-only reconstruction: these regression sources have NOT been executed.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RuleFileImport } from "./RuleFileImport";
import { installSessionTransport } from "./api";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const clients: QueryClient[] = [];
const reads: ControlledReader[] = [];
const transportCleanups: (() => void)[] = [];
// Only the browser file boundary is controlled; form, dialog and mutation are real.
class ControlledReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL() { reads.push(this); }
  abort() { this.onabort?.(); }
  succeed(text: string) {
    this.result = `data:application/octet-stream;base64,${btoa(text)}`;
    this.onload?.();
  }
  fail() { this.onerror?.(); }
}
beforeEach(() => {
  reads.length = 0;
  vi.stubGlobal("FileReader", ControlledReader);
  vi.stubGlobal("ResizeObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    media: "", onchange: null,
  }));
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup();
  transportCleanups.splice(0).forEach((remove) => remove());
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  clients.push(client);
  return { ...render(
    <QueryClientProvider client={client}>
      <UIProviders><RuleFileImport onClose={onClose} /></UIProviders>
    </QueryClientProvider>,
  ), onClose };
}
const saveButton = () => screen.getByRole("button", { name: "导入并保存文件" });
async function choose(name = "rules.yaml") {
  fireEvent.change(screen.getByLabelText("导入资源名称"), { target: { value: "Private rules" } });
  await userEvent.upload(screen.getByLabelText("选择规则文件"), new File(["rules"], name));
}

it("keeps a rejected selection dirty until explicit discard or clearing the selection", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { onClose } = mount();
  await userEvent.upload(screen.getByLabelText("选择规则文件"), new File([], "empty.yaml"));
  await screen.findByText("规则文件必须为 1 字节至 8 MiB。");
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await screen.findByRole("alertdialog", { name: "放弃未保存的规则文件修改？" });
  await userEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "清除文件选择" }));
  expect(screen.queryByText("规则文件必须为 1 字节至 8 MiB。")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(fetcher).not.toHaveBeenCalled();
});

it("can explicitly discard a rejected file selection without uploading", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { onClose } = mount();
  await userEvent.upload(screen.getByLabelText("选择规则文件"), new File([], "empty.yaml"));
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await screen.findByRole("alertdialog");
  await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(fetcher).not.toHaveBeenCalled();
});

it("retries the same file after a read error and keeps the draft while reading", async () => {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    writes.push(JSON.parse(init.body));
    return json({ ...writes[0].resource, acceptedVersion: "accepted" }, 201);
  }));
  const { onClose } = mount();
  const file = new File(["rules"], "rules.yaml");
  fireEvent.change(screen.getByLabelText("导入资源名称"), { target: { value: "Private rules" } });
  await userEvent.upload(screen.getByLabelText("选择规则文件"), file);
  await userEvent.click(saveButton());
  await waitFor(() => expect(reads).toHaveLength(1));
  expect((screen.getByLabelText("选择规则文件") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(saveButton());
  expect(reads).toHaveLength(1);
  expect(writes).toEqual([]);
  await act(async () => reads[0].fail());
  await screen.findByText("文件读取失败，请重新选择。");
  expect((screen.getByLabelText("导入资源名称") as HTMLInputElement).value).toBe("Private rules");
  await userEvent.upload(screen.getByLabelText("选择规则文件"), file);
  expect(screen.queryByText("文件读取失败，请重新选择。")).toBeNull();
  await userEvent.click(saveButton());
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => reads[1].succeed("payload:\n  - example.test\n"));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(1);
  expect(atob(writes[0].contentBase64)).toBe("payload:\n  - example.test\n");
});

it("does not reuse a prior valid file after an invalid replacement and preserves a canceled picker", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  mount();
  await choose("first.yaml");
  fireEvent.change(screen.getByLabelText("选择规则文件"), { target: { files: [] } });
  expect(screen.getByText("first.yaml")).toBeTruthy();
  await userEvent.upload(screen.getByLabelText("选择规则文件"), new File([], "empty.yaml"));
  expect(screen.queryByText("first.yaml")).toBeNull();
  await userEvent.click(saveButton());
  await screen.findByText("请选择要导入的规则文件。");
  expect(reads).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["success", "error"] as const)(
  "never uploads or changes a new dialog after an old file read completes with %s",
  async (outcome) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const old = mount();
    await choose("old.yaml");
    await userEvent.click(saveButton());
    await waitFor(() => expect(reads).toHaveLength(1));
    old.unmount();
    const current = mount();
    await choose("current.yaml");
    await act(async () => {
      if (outcome === "success") reads[0].succeed("old bytes");
      else reads[0].fail();
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByText("current.yaml")).toBeTruthy();
    expect(screen.queryByText("文件读取失败，请重新选择。")).toBeNull();
    expect(screen.getByRole("dialog", { name: "导入规则文件" })).toBeTruthy();
    expect(old.onClose).not.toHaveBeenCalled();
    expect(current.onClose).not.toHaveBeenCalled();
  },
);

it.each([201, 422])("does not close or show old network feedback in a new dialog (%s)", async (status) => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const old = mount();
  await choose("old.yaml");
  await userEvent.click(saveButton());
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => reads[0].succeed("old bytes"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  old.unmount();
  const current = mount();
  await choose("current.yaml");
  await act(async () => finish(json(status === 201
    ? { id: "old", acceptedVersion: "old" }
    : { error: "Old import rejected" }, status)));
  expect(screen.queryByText("Old import rejected")).toBeNull();
  expect(screen.queryByText("规则文件已接纳，发布配置时会一并打包")).toBeNull();
  expect(screen.getByText("current.yaml")).toBeTruthy();
  expect(old.onClose).not.toHaveBeenCalled();
  expect(current.onClose).not.toHaveBeenCalled();
});


it("does not upload an abandoned import after its session wait resumes", async () => {
  let release!: () => void;
  let waiting = false;
  const sessionWait = new Promise<void>((resolve) => { release = resolve; });
  transportCleanups.push(installSessionTransport({
    beforeRequest: () => ({
      waitForResponse: () => {
        waiting = true;
        return sessionWait;
      },
      beforeSend: () => {},
    }),
    failed: () => {},
  }));
  const fetcher = vi.fn(async () => json({ id: "old", acceptedVersion: "old" }, 201));
  vi.stubGlobal("fetch", fetcher);
  const old = mount();
  await choose("old.yaml");
  await userEvent.click(saveButton());
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => reads[0].succeed("old bytes"));
  // The read has completed; the HTTP boundary is still waiting for authority.
  await waitFor(() => expect(waiting).toBe(true));
  expect(fetcher).not.toHaveBeenCalled();
  old.unmount();
  const current = mount();
  await choose("current.yaml");
  await act(async () => {
    release();
    await sessionWait;
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByText("current.yaml")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "导入规则文件" })).toBeTruthy();
  expect(screen.queryByText("文件导入已取消，请重新选择文件。")).toBeNull();
  expect(screen.queryByText("规则文件已接纳，发布配置时会一并打包")).toBeNull();
  expect(old.onClose).not.toHaveBeenCalled();
  expect(current.onClose).not.toHaveBeenCalled();
});

it("recovers from a synchronous browser read failure without losing the selected draft", async () => {
  vi.spyOn(ControlledReader.prototype, "readAsDataURL").mockImplementationOnce(() => {
    throw new DOMException("Synthetic file access failure", "NotReadableError");
  });
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    writes.push(JSON.parse(init.body));
    return json({ ...writes[0].resource, acceptedVersion: "accepted" }, 201);
  }));
  const { onClose } = mount();
  await choose();
  await userEvent.click(saveButton());
  await screen.findByText("文件读取失败，请重新选择。");
  expect(writes).toEqual([]);
  expect(screen.getByText("rules.yaml")).toBeTruthy();
  expect((screen.getByLabelText("导入资源名称") as HTMLInputElement).value).toBe("Private rules");
  await userEvent.click(saveButton());
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => reads[0].succeed("retried bytes"));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(1);
  expect(atob(writes[0].contentBase64)).toBe("retried bytes");
});
