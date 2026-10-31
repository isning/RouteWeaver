// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { Suspense, useState, type ReactNode } from "react";
import { PageBoundary, lazyPage } from "./PageBoundary";
import { useUnsavedChanges } from "./navigation";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(children: ReactNode) {
  return render(<UIProviders>{children}</UIProviders>);
}
it("contains a rejected lazy page import, keeps navigation available and only refreshes on request", async () => {
  const reload = vi.fn();
  const FailedPage = lazyPage(async () => {
    throw new TypeError(
      "Failed to fetch dynamically imported module: /assets/private-path.js",
    );
  });
  function Workspace() {
    const [page, setPage] = useState("broken");
    return (
      <>
        <nav>
          <button onClick={() => setPage("working")}>打开其他页面</button>
        </nav>
        <PageBoundary key={page} reload={reload}>
          <Suspense fallback="正在打开页面">
            {page === "broken" ? <FailedPage /> : <p>可用页面</p>}
          </Suspense>
        </PageBoundary>
      </>
    );
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  mount(<Workspace />);
  await screen.findByText("页面资源未能加载");
  expect(screen.queryByText(/private-path/)).toBeNull();
  expect(reload).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "刷新工作空间" }));
  expect(reload).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "打开其他页面" }));
  expect(screen.getByText("可用页面")).toBeTruthy();
});

it("distinguishes render failures, retries locally and does not expose exception details", async () => {
  let broken = true;
  const reload = vi.fn();
  function Page() {
    if (broken) throw new Error("private render stack");
    return <p>恢复后的页面</p>;
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  mount(
    <PageBoundary reload={reload}>
      <Page />
    </PageBoundary>,
  );
  await screen.findByText("这个页面暂时无法显示");
  expect(screen.queryByText("页面资源未能加载")).toBeNull();
  expect(screen.queryByText(/private render stack/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "重新打开页面" }));
  expect(screen.getByText("这个页面暂时无法显示")).toBeTruthy();
  expect(reload).not.toHaveBeenCalled();
  broken = false;
  await userEvent.click(screen.getByRole("button", { name: "重新打开页面" }));
  expect(screen.getByText("恢复后的页面")).toBeTruthy();
});

it.each(["重新打开页面", "刷新工作空间"])(
  "requires safe-default approval for %s after a dirty page crashes",
  async (action) => {
    const reload = vi.fn();
    function EditingPage() {
      const [value, setValue] = useState("");
      const [crash, setCrash] = useState(false);
      useUnsavedChanges(!!value);
      if (crash) throw new Error("private data");
      return (
        <>
          <input
            aria-label="草稿"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button onClick={() => setCrash(true)}>触发页面异常</button>
        </>
      );
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    mount(
      <PageBoundary reload={reload}>
        <EditingPage />
      </PageBoundary>,
    );
    fireEvent.change(screen.getByLabelText("草稿"), {
      target: { value: "important unsaved draft" },
    });
    await userEvent.click(screen.getByRole("button", { name: "触发页面异常" }));
    await screen.findByText("页面出现异常，未保存的编辑可能无法恢复。");
    await userEvent.click(screen.getByRole("button", { name: action }));
    const cancel = await screen.findByRole("button", { name: "暂不操作" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await userEvent.keyboard("{Enter}");
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("这个页面暂时无法显示")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: action }));
    await userEvent.click(
      await screen.findByRole("button", { name: "放弃修改并继续" }),
    );
    if (action === "刷新工作空间") expect(reload).toHaveBeenCalledOnce();
    else expect(screen.getByLabelText("草稿")).toBeTruthy();
  },
);

it("does not discard a still-mounted shell draft when a page import fails", async () => {
  const reload = vi.fn();
  const FailedPage = lazyPage(async () => {
    throw new TypeError("network failure");
  });
  function Shell() {
    const [value, setValue] = useState("");
    const [open, setOpen] = useState(false);
    useUnsavedChanges(!!value);
    return (
      <>
        <input
          aria-label="工作空间草稿"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button onClick={() => setOpen(true)}>打开页面</button>
        {open && (
          <PageBoundary reload={reload}>
            <Suspense fallback="loading">
              <FailedPage />
            </Suspense>
          </PageBoundary>
        )}
      </>
    );
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  mount(<Shell />);
  fireEvent.change(screen.getByLabelText("工作空间草稿"), {
    target: { value: "keep me" },
  });
  await userEvent.click(screen.getByRole("button", { name: "打开页面" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "刷新工作空间" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "暂不操作" }),
  );
  expect(
    (screen.getByLabelText("工作空间草稿") as HTMLInputElement).value,
  ).toBe("keep me");
  expect(reload).not.toHaveBeenCalled();
});
