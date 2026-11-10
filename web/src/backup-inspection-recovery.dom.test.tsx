// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackupSettings } from "./Backup";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const preview = {
  manifest: { schemaVersion: 2, createdAt: "2026-10-01T00:00:00Z" },
  digest: "fixture",
  counts: { records: 1 },
  restoreAvailable: true,
};
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <BackupSettings />
      </UIProviders>
    </QueryClientProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
// Synthetic HTTP boundary only: no archive leaves this process.
it.each([
  ["success", "before"], ["failure", "before"],
  ["success", "after"], ["failure", "after"],
])("can inspect a replacement after clearing a pending inspection with old %s settling %s replacement", async (outcome, order) => {
  let finishOld!: (response: Response) => void;
  let finishNew!: (response: Response) => void;
  const inspections: FormData[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (!String(url).endsWith("/preview")) return json({});
    inspections.push(init.body);
    if (inspections.length === 1) return new Promise<Response>(resolve => { finishOld = resolve; });
    return new Promise<Response>(resolve => { finishNew = resolve; });
  }));
  mount();
  const choose = (name: string, password: string) => {
    fireEvent.change(screen.getByLabelText("选择加密备份"), { target: { files: [new File(["synthetic"], name)] } });
    fireEvent.change(screen.getByLabelText("备份密码"), { target: { value: password } });
  };
  choose("old.age", "old-password");
  const inspect = () => screen.getByRole("button", { name: "校验备份并查看影响" });
  fireEvent.click(inspect());
  await waitFor(() => expect(inspections).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "清空备份输入" }));
  choose("replacement.age", "replacement-password");
  expect((inspect() as HTMLButtonElement).disabled).toBe(false);
  expect(inspections).toHaveLength(1);
  fireEvent.click(inspect());
  fireEvent.click(inspect());
  await waitFor(() => expect(inspections).toHaveLength(2));
  const settleOld = () => act(async () => {
    finishOld(outcome === "success" ? json({ ...preview, restoreAvailable: false }) : json({ detail: "Obsolete inspection failed" }, 422));
  });
  if (order === "before") await settleOld();
  expect(screen.queryByText("文件校验通过")).toBeNull();
  expect(screen.queryByText("Obsolete inspection failed")).toBeNull();
  expect(screen.queryByRole("button", { name: "恢复到新数据库" })).toBeNull();
  expect(inspect().getAttribute("aria-busy")).toBe("true");
  expect((inspect() as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finishNew(json({ ...preview, digest: "replacement" })); });
  await screen.findByText("文件校验通过");
  if (order === "after") await settleOld();
  expect((inspections[1].get("archive") as File).name).toBe("replacement.age");
  expect(JSON.parse(String(inspections[1].get("metadata"))).password).toBe("replacement-password");
  expect(screen.queryByText("Obsolete inspection failed")).toBeNull();
  expect(screen.getByText("文件校验通过")).toBeTruthy();
  expect((screen.getByRole("button", { name: "恢复到新数据库" }) as HTMLButtonElement).disabled).toBe(true);
  expect(inspections).toHaveLength(2);
  expect((screen.getByLabelText("输入“恢复到新数据库”以确认") as HTMLInputElement).value).toBe("");
});
