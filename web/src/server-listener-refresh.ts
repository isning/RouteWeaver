import type {
  Connection,
  Infrastructure,
  ManagedEndpoint,
  ServerDeployment,
} from "./types";
import { canEditLegacyPath } from "./infrastructure-model";

export type ListenerRefreshPlan = {
  status: "unchanged" | "ready" | "blocked";
  reason?: string;
  changes: { label: string; before?: string; after?: string }[];
  incoming?: { name: string; before: string; after: string };
  independent?: boolean;
  next?: ServerDeployment;
};
export function sameSnapshot(a: unknown, b: unknown) {
  const stringify = (value: unknown) =>
    JSON.stringify(value, (_key, child) =>
      child && typeof child === "object" && !Array.isArray(child)
        ? Object.fromEntries(
            Object.entries(child).sort(([a], [b]) => a.localeCompare(b)),
          )
        : child,
    );
  return stringify(a) === stringify(b);
}
export function listenerAddress(connection: Connection) {
  const host = connection.host.includes(":")
    ? `[${connection.host}]`
    : connection.host;
  return `${host}:${connection.port}`;
}
export function planListenerRefresh(
  draft: ServerDeployment,
  inventory: Infrastructure,
  endpointId: string,
  current: ManagedEndpoint,
): ListenerRefreshPlan {
  const matches = draft.ir.programs.filter(
    (program) => program.listener.id === endpointId,
  );
  const blocked = (reason: string): ListenerRefreshPlan => ({
    status: "blocked",
    reason,
    changes: [],
  });
  if (matches.length !== 1 || current.id !== endpointId)
    return blocked("无法确认同一个监听端点。草稿中的设置已保留。");
  const program = matches[0],
    old = program.listener;
  const owner = inventory.instances.find(
    (instance) => instance.id === program.instance.id,
  );
  if (!sameSnapshot(program.instance, owner))
    return blocked(
      "核心实例设置已变化，不能仅更新监听。请先核对核心实例；此操作不会替换实例设置。",
    );
  if (
    current.instanceId !== old.instanceId ||
    old.instanceId !== program.instance.id
  )
    return blocked(
      "监听端点已移至其他核心实例，不能仅更新监听。草稿中的设置已保留。",
    );
  if (!inventory.hosts.some((host) => host.id === owner?.hostId))
    return blocked("监听所属服务器已不可用。草稿中的设置已保留。");
  if ((current.authentication || "") !== (old.authentication || ""))
    return blocked(
      "监听的认证方式已变化，不能直接更新。请核对用户入口与认证设置。",
    );
  if (current.connection.protocol !== old.connection.protocol)
    return blocked(
      "监听协议已变化，不能直接更新。请核对协议及服务端安全设置。",
    );
  if (sameSnapshot(old, current)) return { status: "unchanged", changes: [] };
  const changes: ListenerRefreshPlan["changes"] = [];
  if (old.name !== current.name)
    changes.push({ label: "监听名称", before: old.name, after: current.name });
  if (
    old.connection.host !== current.connection.host ||
    old.connection.port !== current.connection.port
  )
    changes.push({
      label: "监听地址",
      before: listenerAddress(old.connection),
      after: listenerAddress(current.connection),
    });
  const credentials = (c: Connection) => ({
    username: c.username,
    password: c.password,
    uuid: c.uuid,
  });
  if (
    !sameSnapshot(credentials(old.connection), credentials(current.connection))
  )
    changes.push({ label: "认证信息已变更" });
  // Private/opaque transport and security parameters are never rendered as diff values.
  if (!sameSnapshot(old.connection.tls, current.connection.tls))
    changes.push({ label: "TLS 连接设置已变更" });
  if (!sameSnapshot(old.connection.transport, current.connection.transport))
    changes.push({ label: "传输设置已变更" });
  const other = (c: Connection) => {
    const {
      host: _host,
      port: _port,
      username: _user,
      password: _password,
      uuid: _uuid,
      tls: _tls,
      transport: _transport,
      ...rest
    } = c;
    return rest;
  };
  if (!sameSnapshot(other(old.connection), other(current.connection)))
    changes.push({ label: "其他连接设置已变更" });
  if (!changes.length) changes.push({ label: "监听设置已变更" });
  const legacy = canEditLegacyPath(draft, inventory);
  const index = draft.ir.programs.indexOf(program);
  let target = current.connection;
  if (legacy && index > 0 && ["0.0.0.0", "::"].includes(target.host)) {
    const host = inventory.hosts.find(
      (host) => host.id === program.instance.hostId,
    );
    if (!host?.address)
      return blocked(
        "此监听绑定全部地址，但服务器没有连接地址。请先核对服务器设置。",
      );
    target = { ...target, host: host.address };
  }
  const next: ServerDeployment = {
    ...draft,
    ir: {
      ...draft.ir,
      programs: draft.ir.programs.map((p, i) =>
        i === index
          ? { ...p, listener: current }
          : legacy && i === index - 1
            ? { ...p, egress: [{ ...target }] }
            : p,
      ),
    },
  };
  return {
    status: "ready",
    changes,
    next,
    independent: !legacy,
    ...(legacy && index > 0
      ? {
          incoming: {
            name: draft.ir.programs[index - 1].listener.name,
            before: listenerAddress(draft.ir.programs[index - 1].egress[0]),
            after: listenerAddress(target),
          },
        }
      : {}),
  };
}
