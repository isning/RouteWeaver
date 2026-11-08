import { canEditLegacyPath, compilePath, endpointIntent } from "./infrastructure-model";
import type { ActionRef, Connection, Infrastructure, ServerDeployment, ServerProgram } from "./types";

/** Connector identity is local to a managed program, never a subscription source. */
export type OrderedServerHop =
  | { kind: "managed"; endpointId: string }
  | { kind: "connector"; programEndpointId: string; connectorId: string };
export type ScopedConnectorChoice = {
  programEndpointId: string;
  connectorId: string;
  label: string;
};
export type OrderedServerPath =
  | { editable: true; hops: OrderedServerHop[]; connectorChoices: ScopedConnectorChoice[] }
  | { editable: false; reason: string };
type Connector = NonNullable<ServerProgram["connectors"]>[number];
type Segment = { program: ServerProgram; connectors: Connector[]; external: string[]; bridge?: string };
const unavailable = "此配置包含独立转发或用户策略，请在转发设置中编辑，避免改写其他去向。";
const invalidGraph = "连接器引用缺失、重复或形成循环，请先修正转发设置。";
const scopeChanged = "外部代理只能放在所属服务器之后，不能跨服务器移动。";
const targets: Record<string, string[]> = {
  "routeweaver/xray": ["26.3.27", "26.10.29", "26.10.31"],
  "routeweaver/sing-box": ["1.14.3", "1.14.4"],
  "routeweaver/managed-xray": ["26.3.27-rw1"],
};

export function orderedServerHopKey(hop: OrderedServerHop): string {
  return hop.kind === "managed" ? `managed:${hop.endpointId}` : `connector:${hop.programEndpointId}:${hop.connectorId}`;
}
function wire(value: unknown): string {
  return JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
}
function fail(reason = unavailable): never { throw new Error(reason); }
function validID(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}
function objects(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.every(item => item && typeof item === "object" && !Array.isArray(item)));
}
function connectionReason(program: ServerProgram, connection: Connection): string | undefined {
  if (!targets[program.instance.adapterId]?.includes(program.instance.version))
    return "此核心版本的链式转发尚未支持，请在完整配置中检查。";
  if (!connection || !["socks", "shadowsocks", "vless", "trojan", "vmess"].includes(connection.protocol))
    return "此连接器协议不支持当前核心的链式转发。";
  if (!connection.host || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)
    return "连接器地址或端口无效，请先修正转发设置。";
  if (program.instance.adapterId === "routeweaver/managed-xray" &&
    (!["socks", "shadowsocks", "vless"].includes(connection.protocol) || connection.flow || connection.packetEncoding ||
      connection.tls?.reality || (connection.transport && connection.transport.type !== "tcp")))
    return "托管入口的下一跳只支持 SOCKS、Shadowsocks 或 VLESS TCP，不支持 Vision、REALITY 或数据包封装。";
  // This is a bounded structural editor, not a replacement for native preview.
  // Do not grant a future adapter/version another adapter's known capabilities.
  return undefined;
}
function checkGraph(connectors: Connector[]): void {
  const byId = new Map<string, Connector>();
  for (const c of connectors) {
    if (!validID(c.id) || ["rw-direct", "rw-reject"].includes(c.id) || byId.has(c.id) ||
      (c.via !== undefined && typeof c.via !== "string") || !c.connection) fail(invalidGraph);
    byId.set(c.id, c);
  }
  const complete = new Set<string>();
  for (const connector of connectors) {
    const seen = new Set<string>();
    let id = connector.id;
    while (id && !complete.has(id)) {
      if (seen.has(id) || !byId.has(id)) fail(invalidGraph);
      seen.add(id);
      id = byId.get(id)!.via || "";
    }
    for (const visited of seen) complete.add(visited);
  }
}
function dial(program: ServerProgram, inventory: Infrastructure): Connection {
  const connection = program.listener.connection;
  if (!["0.0.0.0", "::"].includes(connection.host)) return connection;
  const address = inventory.hosts.find(host => host.id === program.instance.hostId)?.address;
  if (!address || ["0.0.0.0", "::"].includes(address))
    fail("下一跳监听全部地址，请先填写它所属服务器的连接地址。");
  return { ...connection, host: address };
}
function programShape(program: ServerProgram, inventory: Infrastructure): void {
  if (!program?.listener?.connection || !program.instance || !validID(program.listener.id) ||
    !validID(program.instance.id) || program.listener.instanceId !== program.instance.id) fail();
  if (!targets[program.instance.adapterId]?.includes(program.instance.version))
    fail("此核心版本的链式转发尚未支持，请在完整配置中检查。");
  for (const key of ["egress", "connectors", "rules", "resources", "principals"] as const)
    if (!objects(program[key])) fail();
  const owners = inventory.instances.filter(instance => instance.id === program.instance.id);
  const endpoints = inventory.endpoints.filter(endpoint => endpoint.id === program.listener.id);
  if (owners.length !== 1 || endpoints.length !== 1 || endpoints[0].instanceId !== program.instance.id ||
    owners[0].hostId !== program.instance.hostId || owners[0].adapterId !== program.instance.adapterId ||
    owners[0].version !== program.instance.version || inventory.hosts.filter(host => host.id === program.instance.hostId).length !== 1) fail();
  if (program.rules?.length || program.principals?.length) fail();
  const action = program.defaultAction;
  if (action && (typeof action !== "object" || Array.isArray(action) ||
    Object.keys(action).some(key => !["kind", "ref"].includes(key)) ||
    (action.ref !== undefined && typeof action.ref !== "string"))) fail();
}
function checkManagedIngress(program: ServerProgram, index: number): void {
  if (program.instance.adapterId !== "routeweaver/managed-xray") return;
  if (index !== 0) fail("托管计量入口只能作为第一跳，请为后续服务器选择普通核心监听。");
  const c = program.listener.connection;
  if (program.instance.version !== "26.3.27-rw1" || c.protocol !== "vless" || c.flow || c.packetEncoding ||
    c.tls?.reality || program.tls?.reality || (c.transport && c.transport.type !== "tcp"))
    fail("此托管入口配置不支持链式编排，请在转发设置中检查。");
}

/** Requires the owner's revealed draft for editing. No inventory credentials are
 * read for existing listeners: their saved snapshots are the source of truth.
 * Reads the actual fallback/Via chain, never array order or unused connectors.
 */
function inspect(draft: ServerDeployment, inventory: Infrastructure): { segments: Segment[]; hops: OrderedServerHop[]; connectorChoices: ScopedConnectorChoice[] } {
  if (draft?.ir?.schemaVersion !== "1.0" || !Array.isArray(draft.ir.programs) || draft.ir.programs.length > 32) fail();
  const ids = new Set<string>(), instances = new Set<string>();
  const segments: Segment[] = [], hops: OrderedServerHop[] = [], connectorChoices: ScopedConnectorChoice[] = [];
  for (const [index, program] of draft.ir.programs.entries()) {
    programShape(program, inventory);
    checkManagedIngress(program, index);
    if (ids.has(program.listener.id) || instances.has(program.instance.id)) fail();
    ids.add(program.listener.id); instances.add(program.instance.id);
    const legacy = program.egress || [];
    if (legacy.length && program.connectors?.length) fail();
    // Legacy compatibility is deliberately exact. Rich ordered egress is not
    // inferred as editable external intent or silently converted.
    if (legacy.length > 1) fail();
    const connectors = legacy.length ? [{ id: "egress-1", connection: legacy[0] }] : program.connectors || [];
    checkGraph(connectors);
    for (const connector of program.connectors || []) {
      const reason = connectionReason(program, connector.connection);
      if (reason) fail(reason);
    }
    let action: ActionRef = program.defaultAction || { kind: "" };
    if (!action.kind) {
      if (action.ref || (!legacy.length && connectors.length)) fail();
      action = legacy.length ? { kind: "forward", ref: "egress-1" } : { kind: "direct" };
    }
    if (!["direct", "forward"].includes(action.kind) || (action.kind === "direct" && action.ref)) fail();
    const byId = new Map(connectors.map(connector => [connector.id, connector]));
    const path: string[] = [];
    let current = action.kind === "forward" ? action.ref : undefined;
    if (action.kind === "forward" && !current) fail();
    while (current) {
      const connector = byId.get(current);
      if (!connector) fail();
      path.push(current); current = connector.via;
    }
    path.reverse();
    const next = draft.ir.programs[index + 1];
    let bridge: string | undefined;
    if (next) {
      if (!next.listener?.connection || !next.instance) fail();
      const expected = dial(next, inventory);
      bridge = path[path.length - 1];
      if (!bridge || wire(byId.get(bridge)!.connection) !== wire(expected)) fail();
      const last = byId.get(bridge)!;
      if (connectors.filter(c => (c.via || "") === (last.via || "") && wire(c.connection) === wire(expected)).length !== 1) fail();
      path.pop();
    } else if (legacy.length) fail();
    hops.push({ kind: "managed", endpointId: program.listener.id }, ...path.map(connectorId => ({ kind: "connector" as const, programEndpointId: program.listener.id, connectorId })));
    for (const connector of program.connectors || []) if (connector.id !== bridge)
      connectorChoices.push({ programEndpointId: program.listener.id, connectorId: connector.id, label: connector.id });
    segments.push({ program, connectors, external: path, bridge });
  }
  if (hops.length > 64) fail("代理链最多包含 64 跳和 32 个服务器。");
  return { segments, hops, connectorChoices };
}

export function readOrderedServerPath(draft: ServerDeployment, inventory: Infrastructure): OrderedServerPath {
  try {
    const { hops, connectorChoices } = inspect(draft, inventory);
    return { editable: true, hops, connectorChoices };
  } catch (error) { return { editable: false, reason: error instanceof Error ? error.message : unavailable }; }
}

/** Selection checks use the same pure compiler as the eventual mutation. */
export function orderedPathChangeReason(draft: ServerDeployment, hops: OrderedServerHop[], inventory: Infrastructure): string | undefined {
  try { compileOrderedServerPath(draft, hops, inventory); return undefined; }
  catch (error) { return error instanceof Error ? error.message : unavailable; }
}

/** Lossless draft-only edit. The owner still controls reveal, revision conflicts,
 * preview and save. Removing a hop does not delete its connector or credentials.
 * Rich rule/principal programs must continue through the explicit policy editor.
 */
export function compileOrderedServerPath(draft: ServerDeployment, hops: OrderedServerHop[], inventory: Infrastructure): ServerDeployment {
  const before = inspect(draft, inventory);
  if (!Array.isArray(hops) || hops.length > 64) fail("代理链最多包含 64 跳和 32 个服务器。");
  const wanted: { endpointId: string; external: string[] }[] = [];
  const seen = new Set<string>();
  for (const hop of hops) {
    if (!hop || !["managed", "connector"].includes(hop.kind)) fail();
    if (hop.kind === "managed") {
      if (!validID(hop.endpointId) || Object.keys(hop).some(key => !["kind", "endpointId"].includes(key))) fail();
      if (seen.has(hop.endpointId)) fail("线路不能重复经过同一端点。");
      seen.add(hop.endpointId);
      wanted.push({ endpointId: hop.endpointId, external: [] });
    } else {
      if (!validID(hop.programEndpointId) || !validID(hop.connectorId) ||
        Object.keys(hop).some(key => !["kind", "programEndpointId", "connectorId"].includes(key))) fail();
      const owner = wanted[wanted.length - 1];
      if (!owner || owner.endpointId !== hop.programEndpointId) fail(scopeChanged);
      if (owner.external.includes(hop.connectorId)) fail("同一服务器之后不能重复经过同一连接器。");
      if (!before.connectorChoices.some(choice => choice.programEndpointId === owner.endpointId && choice.connectorId === hop.connectorId))
        fail("连接器不在此服务器的可选列表中，请重新选择。");
      owner.external.push(hop.connectorId);
    }
  }
  if (wanted.length > 32) fail("代理链最多包含 64 跳和 32 个服务器。");
  if (wire(hops) === wire(before.hops)) return draft;
  for (const segment of before.segments) {
    if (!seen.has(segment.program.listener.id) && (segment.program.connectors?.length || segment.program.resources?.length || segment.program.destinationPolicy ||
      Object.keys(segment.program).some(key => !["instance", "listener", "egress", "rules", "resources", "tls", "defaultAction", "connectors", "principals", "destinationPolicy"].includes(key))))
      fail("此服务器仍保存连接器或独立设置，请先在转发设置中处理，再移除服务器。");
  }
  const selected = wanted.map(({ endpointId }) => {
    const prior = before.segments.find(segment => segment.program.listener.id === endpointId)?.program;
    if (prior) return prior;
    const endpoints = inventory.endpoints.filter(endpoint => endpoint.id === endpointId);
    if (endpoints.length !== 1) fail("路径中的端点已被移除，请重新选择。");
    const endpoint = endpoints[0];
    const instances = inventory.instances.filter(instance => instance.id === endpoint.instanceId);
    if (instances.length !== 1) fail("端点所属的核心实例不存在。");
    return { instance: instances[0], listener: endpointIntent(endpoint), egress: [], rules: [], resources: [] } satisfies ServerProgram;
  });
  if (new Set(selected.map(program => program.instance.id)).size !== selected.length)
    fail("当前每个核心实例只支持一个入口，请选择另一个核心实例的端点。");
  for (const [index, program] of selected.entries()) {
    programShape(program, inventory);
    checkManagedIngress(program, index);
    const next = selected[index + 1];
    if (next) {
      const reason = connectionReason(program, dial(next, inventory));
      if (reason) fail(reason);
    }
  }
  // Preserve legacy serialization only after the same capability and ownership
  // guards have run. Otherwise an empty legacy draft could bypass those checks.
  if (!hops.some(hop => hop.kind === "connector") && canEditLegacyPath(draft, inventory))
    return compilePath(draft, wanted.map(segment => segment.endpointId), inventory);

  const programs = selected.map((program, index) => {
    programShape(program, inventory);
    checkManagedIngress(program, index);
    const segment = before.segments.find(item => item.program.listener.id === program.listener.id);
    const oldIndex = draft.ir.programs.findIndex(item => item.listener.id === program.listener.id);
    const next = selected[index + 1];
    const oldNext = oldIndex < 0 ? undefined : draft.ir.programs[oldIndex + 1];
    const external = wanted[index].external;
    if (segment && wire(segment.external) === wire(external) && oldNext?.listener.id === next?.listener.id)
      return program;
    if (!targets[program.instance.adapterId]?.includes(program.instance.version))
      fail("此核心版本的链式转发尚未支持，请在完整配置中检查。");
    let connectors = [...(segment?.connectors || [])];
    let previous = "";
    for (const id of external) {
      const connector = connectors.find(item => item.id === id);
      if (!connector) fail(scopeChanged);
      const reason = connectionReason(program, connector.connection);
      if (reason) fail(reason);
      connectors = connectors.map(item => item.id === id ? withVia(item, previous) : item);
      previous = id;
    }
    if (next) {
      const connection = dial(next, inventory);
      const reason = connectionReason(program, connection);
      if (reason) fail(reason);
      const candidates = connectors.filter(connector => !external.includes(connector.id) && wire(connector.connection) === wire(connection));
      if (candidates.length > 1) fail("下一跳对应多个连接器，请在转发设置中明确选择。");
      let bridge = candidates[0];
      if (!bridge) {
        const base = `path-${next.listener.id}`.slice(0, 60);
        let id = base, suffix = 1;
        while (connectors.some(connector => connector.id === id)) id = `${base}-${suffix++}`;
        bridge = { id, connection: { ...connection } };
        connectors.push(bridge);
      }
      connectors = connectors.map(item => item.id === bridge.id ? withVia(item, previous) : item);
      previous = bridge.id;
    }
    checkGraph(connectors);
    const defaultAction: ActionRef = previous ? { kind: "forward", ref: previous } : { kind: "direct" };
    return { ...program, egress: [], connectors,
      defaultAction: wire(program.defaultAction) === wire(defaultAction) ? program.defaultAction : defaultAction };
  });
  const result = { ...draft, ir: { ...draft.ir, programs } };
  // A rewrite is accepted only when the emitted IR proves the exact requested
  // physical path, including all native Via hops and the hidden managed bridge.
  if (wire(inspect(result, inventory).hops) !== wire(hops)) fail();
  return result;
}
function withVia(connector: Connector, via: string): Connector {
  if ((connector.via || "") === via) return connector;
  const result = { ...connector };
  if (via) result.via = via;
  else delete result.via;
  return result;
}
