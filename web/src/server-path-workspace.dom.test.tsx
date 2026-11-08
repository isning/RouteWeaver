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

it("starts with the route summary and asks for entry before offering optional transit", () => {
  render(<Workspace />);
  expect(screen.getByRole("region", { name: "入口" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "中转" })).toBeNull();
  const summary = screen.getByRole("region", { name: "路径摘要" });
  expect(summary.textContent).toContain("客户端 → 选择入口服务器 → 目标");
  expect(summary.compareDocumentPosition(screen.getByRole("region", { name: "入口" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const exit = screen.getByRole("region", { name: "最终出口" });
  expect(within(exit).getByText("选择入口后，默认从入口服务器直接访问目标。")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "入口服务器" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "添加中转" })).toBeNull();
});

it("makes a one-server path's direct final exit explicit without creating another endpoint", () => {
  render(<Workspace ids={["entry"]} />);
  const exit = screen.getByRole("region", { name: "最终出口" });
  expect(within(exit).getByText("entry server")).toBeTruthy();
  expect(within(exit).getByText("从入口服务器直接访问目标")).toBeTruthy();
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → 目标");
  expect(screen.queryByRole("combobox", { name: "第 2 跳端点" })).toBeNull();
});

it("removes an intermediate without silently replacing the final exit", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit"]} />);
  const intermediates = screen.getByRole("region", { name: "中转" });
  await user.click(within(intermediates).getByText("顺序与移除"));
  await user.click(screen.getByRole("button", { name: "移除第 2 跳" }));
  expect(within(screen.getByRole("region", { name: "最终出口" }))
    .getByRole("combobox", { name: "第 2 跳端点" }).textContent).toContain("exit endpoint");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → exit endpoint → 目标");
});

it("shows the next final exit at removal and updates the resulting path", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit"]} />);
  const exit = screen.getByRole("region", { name: "最终出口" });
  await user.click(within(exit).getByText("顺序与移除"));
  expect(within(exit).getByText("移除后，从 relay server 直接访问目标。")).toBeTruthy();
  await user.click(within(exit).getByRole("button", { name: "移除第 3 跳" }));
  expect(within(exit).getByRole("combobox", { name: "第 2 跳端点" }).textContent).toContain("relay endpoint");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → relay endpoint → 目标");
});

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

it("adds an intermediate by keyboard before the chosen exit and returns focus to the added hop", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "exit"]} />);
  const add = screen.getByRole("button", { name: "添加中转" });
  add.focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "中转服务器" }));
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 2 跳端点" })));
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → relay endpoint → exit endpoint → 目标");
  expect(screen.queryByRole("combobox", { name: "中转服务器" })).toBeNull();
});

it("keeps the selected server and unchanged final exit after a delayed endpoint read fails", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  await user.click(screen.getByRole("button", { name: "添加中转" }));
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  expect((screen.getByRole("button", { name: "取消添加中转" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve(false));
  expect(screen.getByRole("combobox", { name: "中转服务器" }).textContent).toContain("relay server");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → exit endpoint → 目标");
  await user.click(screen.getByRole("button", { name: "取消添加中转" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "添加中转" }));
  await user.keyboard("{Enter}");
  expect(screen.getByRole("combobox", { name: "中转服务器" }).textContent).toBe("选择服务器");
});

it("does not steal newer field focus when an earlier intermediate selection finishes", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  await user.click(screen.getByRole("button", { name: "添加中转" }));
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  const newer = screen.getByRole("combobox", { name: "第 1 跳服务器" });
  newer.focus();
  await act(async () => pending.resolve(true));
  expect(document.activeElement).toBe(newer);
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → relay endpoint → exit endpoint → 目标");
});

it("does not close a newer add task when an earlier selection succeeds", async () => {
  const user = userEvent.setup();
  const pending = deferred();
  render(<Workspace ids={["entry", "exit"]} commit={() => pending.promise} />);
  const add = screen.getByRole("button", { name: "添加中转" });
  await user.click(add);
  await choose(user, "中转服务器", "relay server");
  await choose(user, "中转端点", "relay endpoint");
  await user.click(add);
  await act(async () => pending.resolve(true));
  expect(add.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("combobox", { name: "中转服务器" })).toBeTruthy();
  expect(document.activeElement).toBe(add);
});

it("reorders through the disclosed controls and names the new entry and exit", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "exit"]} />);
  const exit = screen.getByRole("region", { name: "最终出口" });
  await user.click(within(exit).getByText("顺序与移除"));
  await user.click(within(exit).getByRole("button", { name: "上移第 2 跳" }));
  expect(within(screen.getByRole("region", { name: "入口" }))
    .getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("exit endpoint");
  expect(within(exit).getByRole("combobox", { name: "第 2 跳端点" }).textContent).toContain("entry endpoint");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("exit endpoint → entry endpoint → 目标");
});


it("places final exit before optional transit so decisions follow their dependencies", () => {
  render(<Workspace ids={["entry", "exit"]} />);
  const exit = screen.getByRole("region", { name: "最终出口" });
  const middle = screen.getByRole("region", { name: "中转" });
  expect(exit.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(exit).getByText("服务器")).toBeTruthy();
  expect(within(exit).getByText("监听端点")).toBeTruthy();
});

it("chooses independent exit deliberately and can cancel a partial selection without changing the route", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry"]} />);
  expect(screen.queryByRole("combobox", { name: "下一跳服务器" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "使用另一台服务器出口" }));
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "下一跳服务器" }));
  await choose(user, "下一跳服务器", "exit server");
  await user.click(screen.getByRole("button", { name: "从入口直接访问" }));
  expect(screen.queryByRole("combobox", { name: "下一跳端点" })).toBeNull();
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → 目标");
});

it("requires reviewing removed intermediate and exit before changing an existing path to direct", async () => {
  const user = userEvent.setup();
  render(<Workspace ids={["entry", "relay", "exit"]} />);
  await user.click(screen.getByRole("button", { name: "从入口直接访问" }));
  const review = screen.getByRole("region", { name: "确认改为入口直出" });
  expect(review.textContent).toContain("relay endpoint");
  expect(review.textContent).toContain("exit endpoint");
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → relay endpoint → exit endpoint → 目标");
  await user.click(screen.getByRole("button", { name: "保留当前路径" }));
  expect(screen.queryByRole("region", { name: "确认改为入口直出" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "从入口直接访问" }));
  await user.click(screen.getByRole("button", { name: "移除并改为直出" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "中转" })).toBeNull());
  expect(screen.getByRole("region", { name: "路径摘要" }).textContent).toContain("entry endpoint → 目标");
});
