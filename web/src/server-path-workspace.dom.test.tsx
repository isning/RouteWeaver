// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import userEvent from "@testing-library/user-event";
import { compilePath } from "./infrastructure-model";
import { ServerPathWorkspace } from "./ServerPathWorkspace";
import type { Infrastructure, ServerDeployment } from "./types";

afterEach(cleanup);
const ids = ["entry", "relay", "exit", "fourth", "spare"];
const inventory: Infrastructure = {
  hosts: ids.map((id) => ({ id, name: `${id} server`, address: `${id}.example.test` })),
  instances: ids.map((id) => ({
    id: `${id}-core`, hostId: id, adapterId: "routeweaver/xray", version: "26.10.31",
  })),
  endpoints: ids.map((id) => ({
    id, name: `${id} endpoint`, instanceId: `${id}-core`,
    connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
  })),
  deployments: [], links: [],
};
const empty: ServerDeployment = {
  id: "path", name: "Path", status: "draft", diagnostics: [],
  ir: { id: "path", schemaVersion: "1.0", topologyRevision: "one", programs: [] },
};
function Workspace({ ids = [], commit, splitCommit = false, onPendingChange = () => undefined }: {
  ids?: string[];
  commit?: (next: string[]) => Promise<boolean>;
  splitCommit?: boolean;
  onPendingChange?: (key: string, pending: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => compilePath(empty, ids, inventory));
  const [changing, setChanging] = useState(false);
  const revision = useRef(0);
  return <ServerPathWorkspace
    programs={draft.ir.programs}
    inventory={inventory}
    onPendingChange={onPendingChange}
    changing={changing}
    onSelectionChange={() => { revision.current++; setChanging(false); }}
    onChangePath={async (next) => {
      const request = ++revision.current;
      setChanging(true);
      const accepted = commit ? await commit(next) : true;
      if (request !== revision.current) return false;
      if (accepted) {
        const apply = () => setDraft((current) => compilePath(current, next, inventory));
        if (splitCommit) flushSync(apply);
        else apply();
      }
      setChanging(false);
      return accepted;
    }}
  />;
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, query: string) {
  const control = screen.getByRole("combobox", { name: label });
  control.focus();
  await user.keyboard("{Enter}");
  const search = screen.getByRole("combobox", { name: "搜索选项" });
  await user.type(search, query);
  expect(screen.getAllByRole("option")).toHaveLength(1);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
function deferred() {
  let resolve!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}
const summary = () => screen.getByRole("region", { name: "路径摘要" });

it("shows one ordered chain with the first numbered hop and no separate exit workflow", () => {
  render(<Workspace />);
  expect(screen.getByRole("list", { name: "代理链" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "第 1 跳服务器" })).toBeTruthy();
  expect(summary().textContent).toContain("客户端 → 选择第一跳 → 目标");
  expect(screen.queryByRole("region", { name: "最终出口" })).toBeNull();
  expect(screen.queryByRole("region", { name: "中转" })).toBeNull();
  expect(screen.queryByRole("button", { name: "选择独立出口" })).toBeNull();
  expect(screen.queryByRole("button", { name: "添加下一跳" })).toBeNull();
});

it("ends a one-hop chain at the destination without a second endpoint or exit choice", () => {
  render(<Workspace ids={["entry"]} />);
  expect(summary().textContent).toContain("客户端 → entry endpoint → 目标");
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("entry endpoint");
  expect(screen.queryByRole("combobox", { name: "第 2 跳端点" })).toBeNull();
  expect(screen.getByRole("button", { name: "添加下一跳" })).toBeTruthy();
});

it("renders four supported hops in traversal order instead of grouping them by role", () => {
  render(<Workspace ids={["entry", "relay", "exit", "fourth"]} />);
  const hops = within(screen.getByRole("list", { name: "代理链" })).getAllByRole("listitem");
  expect(hops).toHaveLength(4);
  for (const [index, name] of ["entry", "relay", "exit", "fourth"].entries()) {
    expect(within(hops[index]).getByRole("heading", { name: `第 ${index + 1} 跳` })).toBeTruthy();
    expect(within(hops[index]).getByRole("combobox", { name: `第 ${index + 1} 跳端点` }).textContent).toContain(`${name} endpoint`);
    expect(within(hops[index]).getByRole("button", { name: `移除第 ${index + 1} 跳` })).toBeTruthy();
  }
  expect(summary().textContent).toContain("entry endpoint → relay endpoint → exit endpoint → fourth endpoint → 目标");
});

it("appends a fourth hop by keyboard after the previous last hop and returns focus to it", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit"]} />);
  screen.getByRole("button", { name: "添加下一跳" }).focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 4 跳服务器" }));
  await choose(user, "第 4 跳服务器", "fourth server");
  await choose(user, "第 4 跳端点", "fourth endpoint");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 4 跳端点" })));
  expect(summary().textContent).toContain("entry endpoint → relay endpoint → exit endpoint → fourth endpoint → 目标");
  expect(screen.queryByRole("button", { name: "取消添加" })).toBeNull();
});

it("clears the new append key when the parent commits before the selection promise settles", async () => {
  const user = userEvent.setup();
  const pending = vi.fn();
  render(<Workspace ids={["entry"]} splitCommit onPendingChange={pending} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 2 跳服务器", "relay server");
  await choose(user, "第 2 跳端点", "relay endpoint");
  await waitFor(() => expect(screen.queryByRole("button", { name: "取消添加" })).toBeNull());
  const nextKeyChanges = pending.mock.calls.filter(([key]) => key === "add-entry/relay");
  expect(nextKeyChanges.at(-1)).toEqual(["add-entry/relay", false]);
  expect(summary().textContent).toContain("entry endpoint → relay endpoint → 目标");
});

it("marks an opened append as pending before any server is picked and restores the chain on cancel", async () => {
  const user = userEvent.setup();
  const pending = vi.fn();
  render(<Workspace ids={["entry"]} onPendingChange={pending} />);
  const add = screen.getByRole("button", { name: "添加下一跳" });
  await user.click(add);
  expect(pending).toHaveBeenCalledWith("add-entry", true);
  expect(summary().textContent).toContain("entry endpoint → 第 2 跳（待选择） → 目标");
  await choose(user, "第 2 跳服务器", "relay server");
  await user.click(screen.getByRole("button", { name: "取消添加" }));
  expect(pending).toHaveBeenCalledWith("add-entry", false);
  expect(summary().textContent).toContain("entry endpoint → 目标");
  expect(document.activeElement).toBe(add);
  await user.keyboard("{Enter}");
  expect(screen.getByRole("combobox", { name: "第 2 跳服务器" }).textContent).toBe("选择服务器");
});

it("keeps an append explicitly pending until the selected listener has been read", async () => {
  const user = userEvent.setup();
  const task = deferred();
  render(<Workspace ids={["entry"]} commit={() => task.promise} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 2 跳服务器", "relay server");
  await choose(user, "第 2 跳端点", "relay endpoint");
  expect(summary().textContent).toContain("entry endpoint → 第 2 跳（正在读取） → 目标");
  expect(summary().textContent).not.toContain("entry endpoint → relay endpoint → 目标");
  expect((screen.getByRole("button", { name: "取消添加" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("button", { name: "移除第 1 跳" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { task.resolve(true); await task.promise; });
  await waitFor(() => expect(summary().textContent).toContain("entry endpoint → relay endpoint → 目标"));
  expect(summary().textContent).not.toContain("正在读取");
});

it("cancels an append while its read is pending and ignores the late result", async () => {
  const user = userEvent.setup();
  const task = deferred();
  const pending = vi.fn();
  render(<Workspace ids={["entry"]} commit={() => task.promise} onPendingChange={pending} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 2 跳服务器", "relay server");
  await choose(user, "第 2 跳端点", "relay endpoint");
  expect(summary().textContent).toContain("第 2 跳（正在读取）");
  await user.click(screen.getByRole("button", { name: "取消添加" }));
  expect(pending).toHaveBeenCalledWith("add-entry", false);
  const add = screen.getByRole("button", { name: "添加下一跳" });
  expect(document.activeElement).toBe(add);
  expect(summary().textContent).toContain("entry endpoint → 目标");
  await user.keyboard("{Enter}");
  await choose(user, "第 2 跳服务器", "fourth server");
  const newer = screen.getByRole("combobox", { name: "第 2 跳服务器" });
  newer.focus();
  await act(async () => { task.resolve(true); await task.promise; });
  expect(newer.textContent).toContain("fourth server");
  expect(document.activeElement).toBe(newer);
  expect(summary().textContent).toContain("entry endpoint → 第 2 跳（待选择） → 目标");
  expect(summary().textContent).not.toContain("relay endpoint");
});

it("retains the partial append and original chain when the listener read fails", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 3 跳服务器", "relay server");
  await choose(user, "第 3 跳端点", "relay endpoint");
  await act(async () => pending.resolve(false));
  expect(screen.getByRole("combobox", { name: "第 3 跳服务器" }).textContent).toContain("relay server");
  expect(summary().textContent).toContain("entry endpoint → exit endpoint → 第 3 跳（待选择） → 目标");
  await user.click(screen.getByRole("button", { name: "取消添加" }));
  expect(summary().textContent).toContain("entry endpoint → exit endpoint → 目标");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "添加下一跳" }));
});

it("does not steal newer field focus when an earlier append finishes", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 3 跳服务器", "relay server");
  await choose(user, "第 3 跳端点", "relay endpoint");
  const newer = screen.getByRole("combobox", { name: "第 1 跳服务器" });
  newer.focus();
  await act(async () => pending.resolve(true));
  expect(document.activeElement).toBe(newer);
  expect(summary().textContent).toContain("entry endpoint → exit endpoint → relay endpoint → 目标");
});

it("does not close a newer server selection or commit an invalidated append", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 3 跳服务器", "relay server");
  await choose(user, "第 3 跳端点", "relay endpoint");
  const newer = screen.getByRole("combobox", { name: "第 3 跳服务器" });
  await user.click(newer);
  await user.type(screen.getByRole("combobox", { name: "搜索选项" }), "fourth server");
  // A previously selected server also exposes the intentional clear action.
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "清除选择", "fourth server",
  ]);
  await user.click(screen.getByRole("option", { name: "fourth server" }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  newer.focus();
  await act(async () => pending.resolve(true));
  expect(screen.getByRole("button", { name: "添加下一跳" }).getAttribute("aria-expanded")).toBe("true");
  expect(newer.textContent).toContain("fourth server");
  expect(document.activeElement).toBe(newer);
  expect(summary().textContent).toContain("entry endpoint → exit endpoint → 第 3 跳（待选择） → 目标");
});

it("reorders any hop with visible controls and updates the summary and endpoint ordinals together", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit", "fourth"]} />);
  await user.click(screen.getByRole("button", { name: "上移第 4 跳" }));
  expect(summary().textContent).toContain("entry endpoint → relay endpoint → fourth endpoint → exit endpoint → 目标");
  expect(screen.getByRole("combobox", { name: "第 3 跳端点" }).textContent).toContain("fourth endpoint");
  await user.click(screen.getByRole("button", { name: "下移第 1 跳" }));
  expect(summary().textContent).toContain("relay endpoint → entry endpoint → fourth endpoint → exit endpoint → 目标");
  expect(screen.getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("relay endpoint");
});

it.each([
  [1, "relay endpoint → exit endpoint → fourth endpoint → 目标"],
  [2, "entry endpoint → exit endpoint → fourth endpoint → 目标"],
  [3, "entry endpoint → relay endpoint → fourth endpoint → 目标"],
  [4, "entry endpoint → relay endpoint → exit endpoint → 目标"],
])("removes hop %s from a four-hop chain without changing the remaining order", async (hop, expected) => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit", "fourth"]} />);
  await user.click(screen.getByRole("button", { name: `移除第 ${hop} 跳` }));
  expect(summary().textContent).toContain(expected);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

it("removes the only hop and returns focus to the first-hop picker", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry"]} />);
  await user.click(screen.getByRole("button", { name: "移除第 1 跳" }));
  expect(summary().textContent).toContain("客户端 → 选择第一跳 → 目标");
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 1 跳服务器" }));
  expect(screen.queryByRole("button", { name: "添加下一跳" })).toBeNull();
});
