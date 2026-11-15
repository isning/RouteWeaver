// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OverviewOutputChecks } from "./OverviewOutputChecks";
import { invalidateOutputInputs } from "./output-comparison";
import type { Output, OutputComparison } from "./types";
vi.mock("./api", () => ({ request: vi.fn() }));
import { request } from "./api";
const output: Output = {
  id: "o",
  name: "手机",
  profileId: "p",
  target: { adapterId: "sing-box", version: "1" },
  mode: "full",
  status: "published",
  revision: "r1",
};
const result = (state: "changed" | "unchanged" | "unavailable", extra = {}) =>
  ({ ...output, draftComparison: { state, ...extra } }) as OutputComparison;
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function mount(readInventory = vi.fn().mockResolvedValue([output])) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const go = vi.fn(),
    refresh = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <OverviewOutputChecks
        targets={[{ id: "o", revision: "r1" }]}
        outputs={[output]}
        ready
        readInventory={readInventory}
        refresh={refresh}
        go={go}
      />
    </QueryClientProvider>,
  );
  return { client, go, refresh, ...view };
}
it("does not compile on mount; a manual check identifies changes and opens the exact subscription without publishing", async () => {
  vi.mocked(request).mockResolvedValue(result("changed"));
  const { go } = mount();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByText(/有未发布修改/);
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.mocked(request).mock.calls[0][0]).toBe("/me/outputs/o/comparison");
  fireEvent.click(screen.getByRole("button", { name: "检查订阅" }));
  expect(go).toHaveBeenCalledWith("#subscriptions?output=o");
});
it("keeps unchanged, missing references and unknown results distinct", async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(result("unchanged"))
    .mockResolvedValueOnce(
      result("unavailable", {
        reason: "missing-action-reference",
        location: "group",
      }),
    )
    .mockResolvedValueOnce(result("unavailable"));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByText(/与保存草稿一致/);
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await screen.findByText(/策略组成员需修复/);
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await screen.findByText(/暂时无法比较/);
  expect(screen.queryByRole("button", { name: "检查订阅" })).toBeNull();
});
it("rejects a changed publication before compiling and never reuses a mismatched response", async () => {
  const inventory = vi
    .fn()
    .mockResolvedValueOnce([{ ...output, revision: "r2" }])
    .mockResolvedValueOnce([output]);
  vi.mocked(request).mockResolvedValue({
    ...result("unchanged"),
    revision: "r2",
  });
  mount(inventory);
  fireEvent.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByRole("alert");
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByText("暂时无法比较");
  expect(screen.queryByText(/与保存草稿一致/)).toBeNull();
});
it("invalidates a manual receipt when its saved input changes, without automatically compiling again", async () => {
  vi.mocked(request).mockResolvedValue(result("unchanged"));
  const { client } = mount();
  fireEvent.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByText(/与保存草稿一致/);
  act(() => invalidateOutputInputs(client, "p"));
  await screen.findByText("需要重新检查更新");
  expect(request).toHaveBeenCalledTimes(1);
});
it("discards a delayed response after the overview target revision changes", async () => {
  let settle!: (value: OutputComparison) => void;
  vi.mocked(request).mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve as typeof settle;
      }),
  );
  const { client, rerender } = mount();
  fireEvent.click(screen.getByRole("button", { name: "检查变更" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  rerender(
    <QueryClientProvider client={client}>
      <OverviewOutputChecks
        targets={[{ id: "o", revision: "r2" }]}
        outputs={[{ ...output, revision: "r2" }]}
        ready
        readInventory={async () => [{ ...output, revision: "r2" }]}
        refresh={() => {}}
        go={() => {}}
      />
    </QueryClientProvider>,
  );
  await act(async () => settle(result("unchanged")));
  expect(screen.queryByText(/与保存草稿一致/)).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
