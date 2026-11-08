// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { compilePath } from "./infrastructure-model";
import { ServerPathWorkspace } from "./ServerPathWorkspace";
import type { Infrastructure, ServerDeployment } from "./types";

afterEach(cleanup);
const inventory: Infrastructure = {
  hosts: ["entry", "relay", "exit"].map((id) => ({
    id, name: `${id} server`, address: `${id}.example.test`,
  })),
  instances: ["entry", "relay", "exit"].map((id) => ({
    id: `${id}-core`, hostId: id, adapterId: "routeweaver/xray", version: "26.10.31",
  })),
  endpoints: ["entry", "relay", "exit"].map((id) => ({
    id, name: `${id} endpoint`, instanceId: `${id}-core`,
    connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
  })),
  deployments: [], links: [],
};
const empty: ServerDeployment = {
  id: "path", name: "Path", status: "draft", diagnostics: [],
  ir: { id: "path", schemaVersion: "1.0", topologyRevision: "one", programs: [] },
};
function Workspace({ ids = [], commit }: { ids?: string[]; commit?: () => Promise<boolean> }) {
  const [draft, setDraft] = useState(() => compilePath(empty, ids, inventory));
  const [changing, setChanging] = useState(false);
  return <ServerPathWorkspace
    programs={draft.ir.programs}
    inventory={inventory}
    onPendingChange={() => undefined}
    changing={changing}
    onChangePath={async (next) => {
      setChanging(true);
      const accepted = commit ? await commit() : true;
      if (accepted) setDraft((current) => compilePath(current, next, inventory));
      setChanging(false);
      return accepted;
    }}
  />;
}

it("shows entry, optional intermediate, and final exit before an endpoint exists", () => {
  render(<Workspace />);
  expect(screen.getByRole("region", { name: "入口", exact: true })).toBeTruthy();
  expect(screen.getByRole("region", { name: "中转", exact: true })).toBeTruthy();
  const exit = screen.getByRole("region", { name: "最终出口", exact: true });
  expect(within(exit).getByText("选择入口后，默认从入口服务器直接访问目标。")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "入口服务器", exact: true })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "添加中转", exact: true })).toBeNull();
});

it("makes a one-server path's direct final exit explicit without creating another endpoint", () => {
  render(<Workspace ids={["entry"]} />);
  const exit = screen.getByRole("region", { name: "最终出口", exact: true });
  expect(within(exit).getByText("entry server")).toBeTruthy();
  expect(within(exit).getByText("从入口服务器直接访问目标")).toBeTruthy();
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → 目标");
  expect(screen.queryByRole("combobox", { name: "第 2 跳端点", exact: true })).toBeNull();
});

it("removes an intermediate without silently replacing the final exit", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit"]} />);
  const intermediates = screen.getByRole("region", { name: "中转", exact: true });
  await user.click(within(intermediates).getByText("顺序与移除"));
  await user.click(screen.getByRole("button", { name: "移除第 2 跳", exact: true }));
  expect(within(screen.getByRole("region", { name: "最终出口", exact: true }))
    .getByRole("combobox", { name: "第 2 跳端点", exact: true }).textContent).toContain("exit endpoint");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → exit endpoint → 目标");
});

it("shows the next final exit at removal and updates the resulting path", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit"]} />);
  const exit = screen.getByRole("region", { name: "最终出口", exact: true });
  await user.click(within(exit).getByText("顺序与移除"));
  expect(within(exit).getByText("移除后，从 relay server 直接访问目标。")).toBeTruthy();
  await user.click(within(exit).getByRole("button", { name: "移除第 3 跳", exact: true }));
  expect(within(exit).getByRole("combobox", { name: "第 2 跳端点", exact: true }).textContent).toContain("relay endpoint");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → relay endpoint → 目标");
});

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, query: string) {
  const control = screen.getByRole("combobox", { name: label, exact: true });
  control.focus();
  await user.keyboard("{Enter}");
  const search = screen.getByRole("combobox", { name: "搜索选项", exact: true });
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

it("adds an intermediate by keyboard before the chosen exit and returns focus to the added hop", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "exit"]} />);
  const add = screen.getByRole("button", { name: "添加中转", exact: true });
  add.focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "中转服务器", exact: true }));
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 2 跳端点", exact: true })));
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → relay endpoint → exit endpoint → 目标");
  expect(screen.queryByRole("combobox", { name: "中转服务器", exact: true })).toBeNull();
});

it("keeps the selected server and unchanged final exit after a delayed endpoint read fails", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  await user.click(screen.getByRole("button", { name: "添加中转", exact: true }));
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  expect((screen.getByRole("button", { name: "取消添加中转", exact: true }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve(false));
  expect(screen.getByRole("combobox", { name: "中转服务器", exact: true }).textContent).toContain("relay server");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → exit endpoint → 目标");
  await user.click(screen.getByRole("button", { name: "取消添加中转", exact: true }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "添加中转", exact: true }));
  await user.keyboard("{Enter}");
  expect(screen.getByRole("combobox", { name: "中转服务器", exact: true }).textContent).toBe("选择服务器");
});

it("does not steal newer field focus when an earlier intermediate selection finishes", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  await user.click(screen.getByRole("button", { name: "添加中转", exact: true }));
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  const newer = screen.getByRole("combobox", { name: "第 1 跳服务器", exact: true });
  newer.focus();
  await act(async () => pending.resolve(true));
  expect(document.activeElement).toBe(newer);
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → relay endpoint → exit endpoint → 目标");
});

it("does not close a newer add task when an earlier selection succeeds", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  const add = screen.getByRole("button", { name: "添加中转", exact: true });
  await user.click(add);
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  await user.click(add);
  await act(async () => pending.resolve(true));
  expect(add.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("combobox", { name: "中转服务器", exact: true })).toBeTruthy();
  expect(document.activeElement).toBe(add);
});

it("reorders through the disclosed controls and names the new entry and exit", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "exit"]} />);
  const exit = screen.getByRole("region", { name: "最终出口", exact: true });
  await user.click(within(exit).getByText("顺序与移除"));
  await user.click(within(exit).getByRole("button", { name: "上移第 2 跳", exact: true }));
  expect(within(screen.getByRole("region", { name: "入口", exact: true }))
    .getByRole("combobox", { name: "第 1 跳端点", exact: true }).textContent).toContain("exit endpoint");
  expect(within(exit).getByRole("combobox", { name: "第 2 跳端点", exact: true }).textContent).toContain("entry endpoint");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("exit endpoint → entry endpoint → 目标");
});
