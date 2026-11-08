// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { ServerMixedPathWorkspace } from "./ServerMixedPathWorkspace";
import { compileOrderedServerPath, orderedPathChangeReason, readOrderedServerPath, type OrderedServerHop } from "./server-path-model";
import type { Infrastructure, ServerDeployment } from "./types";

afterEach(cleanup);
const inventory: Infrastructure = {
  hosts: ["a", "b", "c"].map((id) => ({ id, name: `${id} server`, address: `${id}.example.test` })),
  instances: ["a", "b", "c"].map((id) => ({ id: `${id}-core`, hostId: id, adapterId: "routeweaver/xray", version: "26.10.31" })),
  endpoints: ["a", "b", "c"].map((id) => ({ id, name: `${id} listener`, instanceId: `${id}-core`, connection: { protocol: "socks", host: "0.0.0.0", port: 1080 } })),
  deployments: [], links: [],
};
const source: ServerDeployment = {
  id: "mixed", name: "Mixed", status: "draft", diagnostics: [],
  ir: { id: "mixed", schemaVersion: "1.0", topologyRevision: "one", programs: [{
    instance: inventory.instances[0], listener: inventory.endpoints[0],
    egress: [], rules: [], resources: [], defaultAction: { kind: "direct" },
    connectors: ["x", "y"].map((id) => ({ id, connection: { protocol: "socks", host: `${id}.private.example`, port: 1080, username: "private-user", password: "private-password" } })),
  }] },
};
function Workspace({ initial = source, commit, onEditConnector = () => {}, onPendingChange = () => {} }: {
  initial?: ServerDeployment;
  commit?: (next: OrderedServerHop[]) => Promise<boolean>;
  onEditConnector?: (programEndpointId: string, connectorId: string, focusLabel: string) => void;
  onPendingChange?: (key: string, pending: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [changing, setChanging] = useState(false);
  const revision = useRef(0);
  const state = readOrderedServerPath(draft, inventory);
  if (!state.editable) throw new Error(state.reason);
  return <ServerMixedPathWorkspace programs={draft.ir.programs} inventory={inventory}
    hops={state.hops} connectorChoices={state.connectorChoices} changing={changing}
    onPendingChange={onPendingChange} onEditConnector={onEditConnector}
    changeReason={(next) => orderedPathChangeReason(draft, next, inventory)}
    onSelectionChange={() => { revision.current++; setChanging(false); }}
    onChangePath={async (next) => {
      const request = ++revision.current;
      setChanging(true);
      const accepted = commit ? await commit(next) : true;
      if (request !== revision.current) return false;
      if (accepted) setDraft((current) => compileOrderedServerPath(current, next, inventory));
      setChanging(false);
      return accepted;
    }} />;
}
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, query: string) {
  const control = screen.getByRole("combobox", { name: label });
  control.focus();
  await user.keyboard("{Enter}");
  await user.type(screen.getByRole("combobox", { name: "搜索选项" }), query);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
const summary = () => screen.getByRole("region", { name: "路径摘要" });

it("adds an existing administrator connector as an ordinary hop and never exposes its address or secrets", async () => {
  const user = userEvent.setup();
  render(<Workspace />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 2 跳类型", "外部代理");
  await choose(user, "第 2 跳外部代理", "x");
  expect(summary().textContent).toContain("a listener → x → 目标");
  expect(within(screen.getByRole("list", { name: "代理链" })).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByRole("region", { name: "最终出口" })).toBeNull();
  expect(document.body.textContent).not.toContain("private.example");
  expect(document.body.textContent).not.toContain("private-user");
  expect(document.body.textContent).not.toContain("private-password");
});

const managed = (endpointId: string): OrderedServerHop => ({ kind: "managed", endpointId });
const external = (connectorId: string): OrderedServerHop => ({ kind: "connector", programEndpointId: "a", connectorId });
const mixed = (hops: OrderedServerHop[]) => compileOrderedServerPath(source, hops, inventory);
function deferred() {
  let resolve!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

it("renders managed and external hops in actual traversal order and hides the managed bridge", () => {
  render(<Workspace initial={mixed([managed("a"), external("x"), external("y"), managed("b")])} />);
  const rows = within(screen.getByRole("list", { name: "代理链" })).getAllByRole("listitem");
  expect(rows).toHaveLength(4);
  expect(within(rows[0]).getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("a listener");
  expect(within(rows[1]).getByRole("combobox", { name: "第 2 跳外部代理" }).textContent).toContain("x");
  expect(within(rows[2]).getByRole("combobox", { name: "第 3 跳外部代理" }).textContent).toContain("y");
  expect(within(rows[3]).getByRole("combobox", { name: "第 4 跳端点" }).textContent).toContain("b listener");
  expect(summary().textContent).toContain("a listener → x → y → b listener → 目标");
});

it("inserts an external proxy before a later managed hop rather than treating it as a separate exit", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), managed("b")])} />);
  await user.click(screen.getByRole("button", { name: "在第 1 跳后插入下一跳" }));
  await choose(user, "第 2 跳类型", "外部代理");
  await choose(user, "第 2 跳外部代理", "x");
  await waitFor(() => expect(summary().textContent).toContain("a listener → x → b listener → 目标"));
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 2 跳外部代理" }));
});

it("reorders external proxies within their owner and explains disabled cross-owner moves", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x"), external("y"), managed("b")])} />);
  const across = screen.getByRole("button", { name: "下移第 3 跳" }) as HTMLButtonElement;
  expect(across.disabled).toBe(true);
  expect(document.getElementById(across.getAttribute("aria-describedby")!)?.textContent).toContain("不能跨服务器");
  await user.click(screen.getByRole("button", { name: "上移第 3 跳" }));
  expect(summary().textContent).toContain("a listener → y → x → b listener → 目标");
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 2 跳外部代理" }));
});

it("removes an external hop without removing its managed neighbors", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x"), managed("b")])} />);
  await user.click(screen.getByRole("button", { name: "移除第 2 跳" }));
  expect(summary().textContent).toContain("a listener → b listener → 目标");
  expect(within(screen.getByRole("list", { name: "代理链" })).getAllByRole("listitem")).toHaveLength(2);
});

it("opens connection editing for the stable connector and owning managed listener", async () => {
  const user = userEvent.setup();
  const edit = vi.fn();
  render(<Workspace initial={mixed([managed("a"), external("x")])} onEditConnector={edit} />);
  await user.click(screen.getByRole("button", { name: "编辑第 2 跳外部代理连接参数" }));
  expect(edit).toHaveBeenCalledWith("a", "x", "编辑第 2 跳外部代理连接参数");
});

it("never offers another managed program's external proxies at the end of the chain", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), managed("b")])} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  expect(screen.queryByRole("combobox", { name: "第 3 跳类型" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "第 3 跳外部代理" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "第 3 跳服务器" })).toBeTruthy();
});

it("cancels a pending external choice, restores focus, and ignores the late result", async () => {
  const user = userEvent.setup();
  const task = deferred();
  const pending = vi.fn();
  render(<Workspace commit={() => task.promise} onPendingChange={pending} />);
  const add = screen.getByRole("button", { name: "添加下一跳" });
  await user.click(add);
  expect(pending).toHaveBeenCalledWith("ordered-add", true);
  await choose(user, "第 2 跳类型", "外部代理");
  await choose(user, "第 2 跳外部代理", "x");
  await user.click(screen.getByRole("button", { name: "取消添加" }));
  expect(document.activeElement).toBe(add);
  expect(pending).toHaveBeenCalledWith("ordered-add", false);
  await act(async () => { task.resolve(true); await task.promise; });
  expect(summary().textContent).toContain("a listener → 目标");
  expect(screen.queryByRole("combobox", { name: "第 2 跳外部代理" })).toBeNull();
});

it("retains the attempted external choice after failure without changing the committed chain", async () => {
  const user = userEvent.setup();
  render(<Workspace commit={async () => false} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 2 跳类型", "外部代理");
  await choose(user, "第 2 跳外部代理", "x");
  expect(screen.getByRole("combobox", { name: "第 2 跳外部代理" }).textContent).toContain("x");
  expect(summary().textContent).toContain("a listener → 第 2 跳（待选择） → 目标");
  expect(screen.getByRole("button", { name: "取消添加" })).toBeTruthy();
});

it("does not steal a newer field's focus when a pending insertion completes", async () => {
  const user = userEvent.setup();
  const task = deferred();
  render(<Workspace commit={() => task.promise} />);
  await user.click(screen.getByRole("button", { name: "添加下一跳" }));
  await choose(user, "第 2 跳类型", "外部代理");
  await choose(user, "第 2 跳外部代理", "x");
  const newer = screen.getByRole("combobox", { name: "第 1 跳服务器" });
  newer.focus();
  await act(async () => { task.resolve(true); await task.promise; });
  expect(document.activeElement).toBe(newer);
  expect(summary().textContent).toContain("a listener → x → 目标");
});

it("keeps following row labels unique while a managed hop is being inserted in the middle", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), managed("b")])} />);
  await user.click(screen.getByRole("button", { name: "在第 1 跳后插入下一跳" }));
  expect(screen.getAllByRole("combobox", { name: "第 2 跳服务器" })).toHaveLength(1);
  expect(screen.getByRole("combobox", { name: "第 3 跳端点" }).textContent).toContain("b listener");
  await choose(user, "第 2 跳服务器", "c server");
  await choose(user, "第 2 跳端点", "c listener");
  expect(summary().textContent).toContain("a listener → c listener → b listener → 目标");
  expect(screen.getByRole("combobox", { name: "第 2 跳端点" }).textContent).toContain("c listener");
  expect(screen.getByRole("combobox", { name: "第 3 跳端点" }).textContent).toContain("b listener");
});
