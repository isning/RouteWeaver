import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  isCancelledError,
  skipToken,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { request } from "./api";
import { dateLabel } from "./model";
import type { Output, OutputComparison } from "./types";

// Only request fences live here; observations belong to the existing account's
// QueryClient. Nothing is persisted or placed in ordinary Output metadata.
const inputSequences = new WeakMap<
  QueryClient,
  { all: number; profiles: Map<string, number> }
>();
function sequences(client: QueryClient) {
  let value = inputSequences.get(client);
  if (!value) {
    value = { all: 0, profiles: new Map() };
    inputSequences.set(client, value);
  }
  return value;
}
export function outputInputSequence(client: QueryClient, profileId: string) {
  const value = sequences(client);
  return `${value.all}:${value.profiles.get(profileId) || 0}`;
}
export const outputComparisonKey = (output: Output) =>
  [
    "output-comparisons",
    output.id,
    output.profileId,
    output.revision || "",
    output.target.adapterId,
    output.target.version,
    output.mode,
    output.status,
  ] as const;
interface Observation {
  comparison: OutputComparison;
  checkedAt: number;
  inputSequence: string;
  outdated?: boolean;
}

/** A publication changes this device, not the shared saved candidate. */
export function invalidateOutputComparison(
  client: QueryClient,
  outputId?: string,
) {
  const queryKey = outputId
    ? ["output-comparisons", outputId]
    : ["output-comparisons"];
  // Revert cancellation settles without a later error overwriting this clear.
  void client.cancelQueries({ queryKey });
  // Notify mounted read-only observers, while letting unused entries expire.
  client.setQueriesData<Observation | null>({ queryKey }, () => null);
}

/** Publication/access-lifecycle attempts can have an uncertain committed result. */
export function invalidateOutputPublication(
  client: QueryClient,
  outputId: string,
) {
  invalidateOutputComparison(client, outputId);
  const queryKey = ["outputs", outputId, "status"];
  void client.cancelQueries({ queryKey, exact: true }, { revert: false });
  void client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
}

/** Called by known input mutations, including uncertain outcomes. Never fetches. */
export function invalidateOutputInputs(
  client: QueryClient,
  profileId?: string,
) {
  const value = sequences(client);
  if (profileId)
    value.profiles.set(profileId, (value.profiles.get(profileId) || 0) + 1);
  else value.all++;
  const predicate = (query: {
    queryKey: readonly unknown[];
    state: { data?: unknown };
  }) =>
    query.queryKey[0] === "output-comparisons" &&
    (!profileId || query.queryKey[2] === profileId);
  void client.cancelQueries({ predicate }, { revert: false });
  // Generic refresh may have invalidated this query already. Change the local
  // observation itself so known input changes notify visible subscribers now.
  client.setQueriesData<Observation | null>({ predicate }, (observation) =>
    observation ? { ...observation, outdated: true } : undefined,
  );
  void client.invalidateQueries({ predicate, refetchType: "none" });
  // A delayed private detail check must not re-introduce pre-mutation evidence.
  const detail = (query: {
    queryKey: readonly unknown[];
    state: { data?: unknown };
  }) =>
    query.queryKey[0] === "outputs" &&
    query.queryKey[2] === "status" &&
    (!profileId ||
      !query.state.data ||
      (query.state.data as Output).profileId === profileId);
  void client.cancelQueries({ predicate: detail }, { revert: false });
  void client.invalidateQueries({ predicate: detail, refetchType: "none" });
}

function projectComparison(
  output: Output,
  value: OutputComparison,
): OutputComparison {
  if (
    !output.revision ||
    !value ||
    value.id !== output.id ||
    value.profileId !== output.profileId ||
    value.revision !== output.revision ||
    value.status !== output.status ||
    value.mode !== output.mode ||
    value.target?.adapterId !== output.target.adapterId ||
    value.target?.version !== output.target.version ||
    !["changed", "unchanged", "unavailable"].includes(
      value.draftComparison?.state,
    )
  )
    throw new Error("订阅信息已变化或无法核对，请重新读取订阅后再核对。");
  const { state, reason, location } = value.draftComparison;
  const knownRepair =
    state === "unavailable" &&
    reason === "missing-action-reference" &&
    ["default", "group", "rule"].includes(location || "");
  // Explicit fields also make a selected private /status result safe to remember.
  return {
    id: value.id,
    profileId: value.profileId,
    target: {
      adapterId: value.target.adapterId,
      version: value.target.version,
    },
    mode: value.mode,
    status: value.status,
    revision: value.revision,
    draftComparison: { state, ...(knownRepair ? { reason, location } : {}) },
  };
}

export function rememberOutputComparison(
  client: QueryClient,
  output: Output,
  value: OutputComparison,
  checkedAt: number,
  checkedInputs: string,
) {
  if (checkedInputs !== outputInputSequence(client, output.profileId)) return;
  try {
    client.setQueryData<Observation>(outputComparisonKey(output), {
      comparison: projectComparison(output, value),
      checkedAt,
      inputSequence: checkedInputs,
    });
  } catch {
    /* An old or incomplete selected detail is not reusable evidence. */
  }
}

export function useOutputComparison(output: Output) {
  const client = useQueryClient();
  // Visible rows keep their as-of receipt; unused rows retain bounded GC.
  // Only the explicit check flow may fetch, never this read-only observer.
  const query = useQuery<Observation | null>({
    queryKey: outputComparisonKey(output),
    queryFn: skipToken,
    enabled: false,
    gcTime: 5 * 60 * 1000,
  });
  if (query?.fetchStatus === "fetching")
    return { text: "正在检查更新", kind: "checking" };
  if (
    isCancelledError(query?.error) ||
    query?.data?.outdated ||
    (query?.data &&
      query.data.inputSequence !==
        outputInputSequence(client, output.profileId))
  )
    return { text: "需要重新检查更新", kind: "outdated" };
  if (query?.status === "error")
    return { text: "暂时无法比较", kind: "unavailable" };
  if (!query?.data) return { text: "未检查更新", kind: "unverified" };
  const comparison = query.data.comparison.draftComparison;
  const time = dateLabel(new Date(query.data.checkedAt).toISOString());
  const repair =
    comparison.reason === "missing-action-reference"
      ? {
          default: "默认流量需修复",
          group: "策略组成员需修复",
          rule: "规则流量需修复",
        }[comparison.location || "default"]
      : undefined;
  const outcome =
    repair ||
    (comparison.state === "changed"
      ? "有未发布修改"
      : comparison.state === "unchanged"
        ? "与保存草稿一致"
        : "暂时无法比较");
  return {
    text: `上次核对 ${time}：${outcome}`,
    checkedAtLabel: `上次核对 ${time}`,
    outcome,
    kind: repair ? "repair" : comparison.state,
  };
}

/** One explicit visible scope, at most five renders and two concurrent requests. */
export function useOutputComparisonChecks(scope: string) {
  const client = useQueryClient();
  const operation = useRef(0);
  const pending = useRef(new Map<string, Output>());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const cancel = useCallback(() => {
    operation.current++;
    for (const output of pending.current.values())
      invalidateOutputComparison(client, output.id);
    pending.current.clear();
    setPendingIds((ids) => (ids.size ? new Set() : ids));
  }, [client]);
  useLayoutEffect(() => {
    cancel();
    return cancel;
  }, [scope, cancel]);
  const run = async (
    visible: Output[],
    readInventory: () => Promise<Output[]>,
  ) => {
    cancel();
    const requested = visible
      .filter((output) => output.status === "published")
      .slice(0, 5);
    if (!requested.length) return;
    const sequence = operation.current;
    const profileId = requested[0].profileId;
    const inputs = outputInputSequence(client, profileId);
    const current = () =>
      sequence === operation.current &&
      inputs === outputInputSequence(client, profileId);
    for (const output of requested) {
      if (output.profileId !== profileId)
        throw new Error("核对范围已变化，请重新选择当前配置。");
      invalidateOutputComparison(client, output.id);
      pending.current.set(output.id, output);
    }
    setPendingIds(new Set(pending.current.keys()));
    try {
      const inventory = await readInventory();
      if (!current()) return;
      const selected = requested.flatMap((requested) => {
        const fresh = inventory.find(
          (output) =>
            output.id === requested.id &&
            output.profileId === profileId &&
            output.status === "published",
        );
        if (!fresh) return [];
        pending.current.set(fresh.id, fresh);
        return [fresh];
      });
      let next = 0;
      const worker = async () => {
        while (current() && next < selected.length) {
          const output = selected[next++];
          try {
            await client.fetchQuery({
              queryKey: outputComparisonKey(output),
              staleTime: 0,
              gcTime: 5 * 60 * 1000,
              retry: false,
              // This named user action must settle, not queue a reconnect check.
              networkMode: "always",
              queryFn: async ({ signal }): Promise<Observation> => {
                const value = await request<OutputComparison>(
                  `/me/outputs/${encodeURIComponent(output.id)}/comparison`,
                  { signal },
                );
                if (!current())
                  throw new Error("核对上下文已变化，请重新核对。");
                return {
                  comparison: projectComparison(output, value),
                  checkedAt: Date.now(),
                  inputSequence: inputs,
                };
              },
            });
          } catch {
            /* Per-device error remains visible; other selected devices can finish. */
          } finally {
            if (sequence === operation.current) {
              pending.current.delete(output.id);
              setPendingIds(new Set(pending.current.keys()));
            }
          }
        }
      };
      await Promise.all([worker(), worker()]);
    } catch (error) {
      if (current()) throw error;
    } finally {
      if (sequence === operation.current) {
        pending.current.clear();
        setPendingIds(new Set());
      }
    }
  };
  return { run, cancel, pendingIds, running: pendingIds.size > 0 };
}
