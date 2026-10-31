import type {
  CoreInstance,
  ManagedEndpoint,
  Infrastructure,
  ServerDeployment,
  ServerProgram,
} from "./types";
/** Only an exact, policy-free legacy chain may be rewritten by ordered controls.
 * This proof needs a revealed draft; redacted summaries are not editable intent.
 */
export function canEditLegacyPath(
  draft: ServerDeployment,
  inventory: Infrastructure,
): boolean {
  if (draft.ir.schemaVersion !== "1.0") return false;
  const programs = draft.ir.programs;
  const listeners = new Set<string>();
  const instances = new Set<string>();
  for (const [index, program] of programs.entries()) {
    if (!program?.listener?.connection || !program.instance?.id) return false;
    const { listener, instance } = program;
    const owner = inventory.instances.find((item) => item.id === instance.id);
    const registered = inventory.endpoints.find(
      (item) => item.id === listener.id,
    );
    if (
      !listener.id ||
      listeners.has(listener.id) ||
      instances.has(instance.id) ||
      listener.instanceId !== instance.id ||
      !owner ||
      owner.hostId !== instance.hostId ||
      owner.adapterId !== instance.adapterId ||
      owner.version !== instance.version ||
      !registered ||
      registered.instanceId !== instance.id ||
      !inventory.hosts.some((host) => host.id === instance.hostId)
    )
      return false;
    listeners.add(listener.id);
    instances.add(instance.id);
    // Go's zero ActionRef is serialized as {kind:""}; it has no explicit policy.
    const action = program.defaultAction;
    if (
      program.connectors?.length ||
      program.rules?.length ||
      program.principals?.length ||
      program.resources?.length ||
      (action &&
        (action.kind ||
          action.ref ||
          Object.keys(action).some((key) => !["kind", "ref"].includes(key))))
    )
      return false;
    const egress = program.egress || [];
    const next = programs[index + 1];
    if (!next) {
      if (egress.length) return false;
      continue;
    }
    if (egress.length !== 1 || !next.listener?.connection) return false;
    let expected = next.listener.connection;
    if (["0.0.0.0", "::"].includes(expected.host)) {
      const address = inventory.hosts.find(
        (host) => host.id === next.instance?.hostId,
      )?.address;
      if (!address) return false;
      expected = { ...expected, host: address };
    }
    if (semanticJSON(egress[0]) !== semanticJSON(expected)) return false;
  }
  return true;
}
function semanticJSON(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([a], [b]) => a.localeCompare(b)),
        )
      : child,
  );
}
export const pathRewriteUnavailable =
  "当前监听有独立转发设置，不能按端点顺序改写。请编辑转发设置。";

export function compilePath(
  draft: ServerDeployment,
  ids: string[],
  inventory: Infrastructure,
): ServerDeployment {
  if (!canEditLegacyPath(draft, inventory))
    throw new Error(pathRewriteUnavailable);
  if (new Set(ids).size !== ids.length)
    throw new Error("线路不能重复经过同一端点。");
  const selected = ids.map((id) => {
    const endpoint = inventory.endpoints.find((e) => e.id === id);
    if (!endpoint) throw new Error("路径中的端点已被移除，请重新选择。");
    // Reordering retains the saved, revealed listener snapshot. Inventory may
    // have changed since this draft was saved; only an explicit new/replaced
    // endpoint adopts the freshly resolved inventory connection.
    return (
      draft.ir.programs.find((p) => p.listener.id === id)?.listener || endpoint
    );
  });
  const instances = new Set<string>();
  const programs: ServerProgram[] = selected.map((endpoint, index) => {
    if (instances.has(endpoint.instanceId))
      throw new Error(
        "当前每个核心实例只支持一个入口，请选择另一个核心实例的端点。",
      );
    instances.add(endpoint.instanceId);
    const instance = inventory.instances.find(
      (i) => i.id === endpoint.instanceId,
    );
    if (!instance) throw new Error("端点所属的核心实例不存在。");
    const prior = draft.ir.programs.find((p) => p.listener.id === endpoint.id);
    let next = selected[index + 1]?.connection;
    if (next && ["0.0.0.0", "::"].includes(next.host)) {
      const nextInstance = inventory.instances.find(
        (i) => i.id === selected[index + 1].instanceId,
      );
      const host = inventory.hosts.find((h) => h.id === nextInstance?.hostId);
      if (!host?.address)
        throw new Error("下一跳监听全部地址，请先填写它所属服务器的连接地址。");
      next = { ...next, host: host.address };
    }
    return {
      ...prior,
      instance: prior?.instance || instance,
      listener: endpoint,
      egress: next ? [{ ...next }] : [],
      rules: prior?.rules || [],
      resources: prior?.resources || [],
      ...(prior?.tls ? { tls: prior.tls } : {}),
    };
  });
  return { ...draft, ir: { ...draft.ir, programs } };
}
export const phaseLabel = (phase: string) =>
  ({
    unregistered: "尚未接入",
    queued: "等待实例接收",
    accepted: "已接收",
    native_validated: "核心校验通过",
    applying: "正在应用",
    applied_unobserved: "等待状态确认",
    observed_conformant: "已确认生效",
    validation_failed: "核心校验失败",
    apply_failed: "应用失败",
    unknown: "正在确认状态",
    blocked: "访问已受限",
    "pending-new-generation": "等待最新配置",
    stopped: "已停止",
  })[phase] || phase;

/** Go nil slices are JSON null; preserve optional intent while normalizing collection containers. */
export function normalizeDeployment(value: ServerDeployment): ServerDeployment {
  return {
    ...value,
    diagnostics: value.diagnostics || [],
    ir: {
      ...value.ir,
      programs: (value.ir.programs || []).map((program) => ({
        ...program,
        egress: program.egress || [],
        rules: program.rules || [],
        resources: program.resources || [],
      })),
    },
  };
}

/** Inventory metadata edits are not deployment approval. Only an unchanged,
 * revealed existing listener may retain an unsupported target protocol. */
export function isUnchangedEndpointDraft(
  original: { endpoint: ManagedEndpoint; instance?: CoreInstance },
  draft: ManagedEndpoint,
  instance?: CoreInstance,
): boolean {
  const stableWireValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableWireValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stableWireValue(child)]),
      );
    return value;
  };
  const identity = (core?: CoreInstance) =>
    core && {
      id: core.id,
      hostId: core.hostId,
      adapterId: core.adapterId,
      version: core.version,
    };
  return (
    !!original.instance &&
    !!instance &&
    original.endpoint.id === draft.id &&
    original.endpoint.instanceId === draft.instanceId &&
    original.endpoint.authentication === draft.authentication &&
    JSON.stringify(stableWireValue(original.endpoint.connection)) ===
      JSON.stringify(stableWireValue(draft.connection)) &&
    JSON.stringify(stableWireValue(identity(original.instance))) ===
      JSON.stringify(stableWireValue(identity(instance)))
  );
}
