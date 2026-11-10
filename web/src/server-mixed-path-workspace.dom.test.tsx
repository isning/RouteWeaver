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
  return <ServerMixedPathWorkspace programs={draft.ir.programs} inventory={inventory} schemaVersion={draft.ir.schemaVersion}
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
async function configure(user: ReturnType<typeof userEvent.setup>, hop: number) {
  const button = screen.getByRole("button", { name: new RegExp(`^配置第 ${hop} 跳 `) });
  if (button.getAttribute("aria-expanded") !== "true") await user.click(button);
}
async function action(user: ReturnType<typeof userEvent.setup>, hop: number, label: string) {
  await user.click(screen.getByRole("button", { name: `第 ${hop} 跳更多操作` }));
  const menu = screen.getByRole("menu", { name: `第 ${hop} 跳更多操作` });
  await user.click(within(menu).getByRole("menuitem", { name: label }));
}


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

it("renders managed and external hops in actual traversal order and hides the managed bridge", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x"), external("y"), managed("b")])} />);
  const rows = within(screen.getByRole("list", { name: "代理链" })).getAllByRole("listitem");
  expect(rows).toHaveLength(4);
  for (const hop of [1, 2, 3, 4]) await configure(user, hop);
  expect(within(rows[0]).getByRole("combobox", { name: "第 1 跳端点" }).textContent).toContain("a listener");
  expect(within(rows[1]).getByRole("combobox", { name: "第 2 跳外部代理" }).textContent).toContain("x");
  expect(within(rows[2]).getByRole("combobox", { name: "第 3 跳外部代理" }).textContent).toContain("y");
  expect(within(rows[3]).getByRole("combobox", { name: "第 4 跳端点" }).textContent).toContain("b listener");
  expect(summary().textContent).toContain("a listener → x → y → b listener → 目标");
});

it("inserts an external proxy before a later managed hop rather than treating it as a separate exit", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), managed("b")])} />);
  await action(user, 1, "在第 1 跳后插入下一跳");
  await choose(user, "第 2 跳类型", "外部代理");
  await choose(user, "第 2 跳外部代理", "x");
  await waitFor(() => expect(summary().textContent).toContain("a listener → x → b listener → 目标"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /^配置第 2 跳 / })));
});

it("reorders external proxies within their owner and explains disabled cross-owner moves", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x"), external("y"), managed("b")])} />);
  await user.click(screen.getByRole("button", { name: "第 3 跳更多操作" }));
  const across = screen.getByRole("menuitem", { name: "下移第 3 跳" });
  expect(across.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(across.getAttribute("aria-describedby")!)?.textContent).toContain("不能跨服务器");
  await user.click(screen.getByRole("menuitem", { name: "上移第 3 跳" }));
  expect(summary().textContent).toContain("a listener → y → x → b listener → 目标");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /^配置第 2 跳 / })));
});

it("removes an external hop without removing its managed neighbors", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x"), managed("b")])} />);
  await action(user, 2, "移除第 2 跳");
  expect(summary().textContent).toContain("a listener → b listener → 目标");
  expect(within(screen.getByRole("list", { name: "代理链" })).getAllByRole("listitem")).toHaveLength(2);
});

it("opens connection editing for the stable connector and owning managed listener", async () => {
  const user = userEvent.setup();
  const edit = vi.fn();
  render(<Workspace initial={mixed([managed("a"), external("x")])} onEditConnector={edit} />);
  await configure(user, 2);
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
  await configure(user, 1);
  const newer = screen.getByRole("combobox", { name: "第 1 跳服务器" });
  newer.focus();
  await act(async () => { task.resolve(true); await task.promise; });
  expect(document.activeElement).toBe(newer);
  expect(summary().textContent).toContain("a listener → x → 目标");
});

it("keeps following row labels unique while a managed hop is being inserted in the middle", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), managed("b")])} />);
  await action(user, 1, "在第 1 跳后插入下一跳");
  expect(screen.getAllByRole("combobox", { name: "第 2 跳服务器" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "配置第 3 跳 b listener" })).toBeTruthy();
  await choose(user, "第 2 跳服务器", "c server");
  await choose(user, "第 2 跳端点", "c listener");
  expect(summary().textContent).toContain("a listener → c listener → b listener → 目标");
  expect(screen.getByRole("button", { name: "配置第 2 跳 c listener" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "配置第 3 跳 b listener" })).toBeTruthy();
});


it("shows the managed-entry credential edit restriction without opening a misleading edit task", async () => {
  const user = userEvent.setup();
  const edit = vi.fn();
  const initial = structuredClone(mixed([managed("a"), external("x")]));
  initial.ir.programs[0].instance.adapterId = "routeweaver/managed-xray";
  initial.ir.programs[0].instance.version = "26.3.27-rw1";
  initial.ir.programs[0].listener.connection = { protocol: "vless", host: "127.0.0.1", port: 443 };
  const ownedInventory = { ...inventory,
    instances: inventory.instances.map(instance => instance.id === "a-core" ? initial.ir.programs[0].instance : instance),
    endpoints: inventory.endpoints.map(endpoint => endpoint.id === "a" ? initial.ir.programs[0].listener : endpoint),
  };
  const state = readOrderedServerPath(initial, ownedInventory);
  if (!state.editable) throw new Error(state.reason);
  render(<ServerMixedPathWorkspace programs={initial.ir.programs} inventory={ownedInventory} schemaVersion="1.0"
    hops={state.hops} connectorChoices={state.connectorChoices} onEditConnector={edit}
    changeReason={next => orderedPathChangeReason(initial, next, ownedInventory)}
    onChangePath={async () => false} onPendingChange={() => {}} onSelectionChange={() => {}} />);
  expect(screen.queryByText("此监听关联用户入口或托管计量，连接器仅供查看。")).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑第 2 跳外部代理连接参数" })).toBeNull();
  await configure(user, 2);
  const button = screen.getByRole("button", { name: "第 2 跳连接参数只读原因" });
  await user.click(button);
  expect(screen.getByRole("dialog", { name: "第 2 跳连接参数只读原因" })).toBeTruthy();
  expect(screen.getByText("此监听关联用户入口或托管计量，连接器仅供查看。")).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(button);
  expect(screen.queryByText("此监听关联用户入口或托管计量，连接器仅供查看。")).toBeNull();
  expect(edit).not.toHaveBeenCalled();
  expect(summary().textContent).toContain("a listener → x → 目标");
});

it("presents a connected route overview before revealing each hop's configuration", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x"), external("y"), managed("b")])} />);
  expect(screen.queryByRole("combobox", { name: "第 1 跳端点" })).toBeNull();
  expect(screen.getByRole("button", { name: "配置第 1 跳 a listener" }).getAttribute("aria-expanded")).toBe("false");
  await user.click(screen.getByRole("button", { name: "配置第 1 跳 a listener" }));
  expect(screen.getByRole("combobox", { name: "第 1 跳端点" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "上移第 3 跳" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "第 3 跳更多操作" }));
  expect(screen.getByRole("menuitem", { name: "上移第 3 跳" })).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "第 3 跳更多操作" }));
});

it("keeps an unfinished server choice visible in the collapsed overview", async () => {
  const user = userEvent.setup();
  const pending = vi.fn();
  render(<Workspace onPendingChange={pending} />);
  await configure(user, 1);
  await user.click(screen.getByRole("combobox", { name: "第 1 跳服务器" }));
  await user.click(screen.getByRole("option", { name: "c server" }));
  expect(screen.getByRole("combobox", { name: "第 1 跳服务器" }).textContent).toContain("c server");
  await user.click(screen.getByRole("button", { name: "配置第 1 跳 a listener" }));
  expect(screen.getByText("待选择监听端点")).toBeTruthy();
  expect(pending).toHaveBeenCalledWith("a", true);
  await configure(user, 1);
  expect(screen.getByRole("combobox", { name: "第 1 跳服务器" }).textContent).toContain("c server");
  expect(summary().textContent).toContain("a listener → 目标");
});

it("returns to the node menu trigger when a reorder fails", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x"), external("y")])} commit={async () => false} />);
  await action(user, 3, "上移第 3 跳");
  expect(summary().textContent).toContain("a listener → x → y → 目标");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "第 3 跳更多操作" })));
});

it("focuses the new first-hop picker after removing the final managed hop", async () => {
  const user = userEvent.setup();
  const initial = structuredClone(source);
  delete initial.ir.programs[0].connectors;
  render(<Workspace initial={initial} />);
  await action(user, 1, "移除第 1 跳");
  expect(summary().textContent).toContain("选择第一跳");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "第 1 跳服务器" })));
});

function describedText(control: HTMLElement) {
  return (control.getAttribute("aria-describedby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
}
it("describes collapsed hops with safe identity and retains pending selection feedback", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={mixed([managed("a"), external("x")])} />);
  const listener = screen.getByRole("button", { name: "配置第 1 跳 a listener" });
  expect(describedText(listener)).toContain("a server");
  expect(describedText(listener)).toContain("SOCKS");
  expect(describedText(listener)).toContain("端口 1080");
  const proxy = screen.getByRole("button", { name: "配置第 2 跳 x" });
  expect(describedText(proxy)).toContain("外部代理");
  expect(describedText(proxy)).toContain("SOCKS");
  expect(describedText(proxy)).toContain("a server");
  expect(describedText(proxy)).not.toContain("private.example");
  expect(describedText(proxy)).not.toContain("private-password");
  await user.click(listener);
  await choose(user, "第 1 跳服务器", "c server");
  await user.click(listener);
  expect(describedText(listener)).toContain("待选择监听端点");
  expect(describedText(listener)).not.toContain("端口 1080");
});

it("offers a first-listener recovery direction when no endpoints are registered", () => {
  render(<ServerMixedPathWorkspace programs={[]} inventory={{ hosts: [], instances: [], endpoints: [], deployments: [], links: [] }}
    schemaVersion="1.0" hops={[]} connectorChoices={[]} onChangePath={async () => false} changeReason={() => undefined}
    onPendingChange={() => {}} onSelectionChange={() => {}} onEditConnector={() => {}} />);
  expect(screen.getByText("先在「服务器」中配置监听端点，再编排路径。")).toBeTruthy();
});
