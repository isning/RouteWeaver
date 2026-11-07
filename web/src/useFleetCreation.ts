import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { APIError, request } from "./api";
import type { SessionLifecycle } from "./SessionLifecycle";
import { newID } from "./model";
import type { FleetBatch } from "./fleet-model";
import {
  fleetCreationStorageKey,
  matchFleetCreation,
  parseFleetCreation,
  type FleetCreationEnvelope,
  type FleetCreationRequest,
} from "./fleet-creation";

type State = {
  envelope: FleetCreationEnvelope | null;
  result: FleetBatch | null;
  busy: boolean;
  error: string | null;
  storageReady: boolean;
  reviewChanged: boolean;
};
const empty = (): State => ({ envelope: null, result: null, busy: false,
  error: null, storageReady: false, reviewChanged: false });
const unknown = "创建结果尚未确认，批次可能已创建。请先查询该次结果。";
const noSubscription = () => () => {};
const noSnapshot = () => null;

/** One immutable actor/tab request. Neither recovery nor retry executes a stage. */
export function useFleetCreation(lifecycle: SessionLifecycle | undefined) {
  useSyncExternalStore(lifecycle?.subscribe ?? noSubscription, lifecycle?.getSnapshot ?? noSnapshot);
  const [state, setState] = useState<State>(empty);
  const current = useRef(state);
  const alive = useRef(false), busy = useRef(false), epoch = useRef(0);
  const authority = useRef<{ actor: string | null; accountEpoch?: number; generation?: number } | null>(null);
  const publish = (value: State) => { current.current = value; setState(value); };
  const active = () => {
    const snapshot = lifecycle?.getSnapshot();
    if (snapshot?.phase !== "active" || snapshot.session?.user.role !== "admin") return null;
    try {
      lifecycle!.beforeRequest().beforeSend();
      return snapshot;
    } catch { return null; }
  };
  const load = () => {
    const owner = active();
    if (!owner) return;
    const actor = owner.session!.user.id;
    try {
      const raw = sessionStorage.getItem(fleetCreationStorageKey(actor));
      const envelope = raw !== null ? parseFleetCreation(raw) : null;
      if (raw !== null && (!envelope || envelope.actorId !== actor)) {
        publish({ ...empty(), error: "本页批次创建记录无法读取。请先核对变更历史，勿重复创建。" });
        return;
      }
      publish({ ...empty(), envelope, storageReady: true });
    } catch {
      publish({ ...empty(), error: "无法读取本页批次创建记录。请允许浏览器保存会话记录后重试。" });
    }
  };
  useLayoutEffect(() => {
    alive.current = true;
    authority.current = null;
    const changed = () => {
      const snapshot = lifecycle?.getSnapshot();
      const actor = snapshot?.session?.user.role === "admin" ? snapshot.session.user.id : null;
      const previous = authority.current;
      authority.current = { actor, accountEpoch: snapshot?.accountEpoch, generation: snapshot?.generation };
      if (!previous || previous.actor !== actor) {
        epoch.current++;
        busy.current = false;
        publish(empty());
        if (active()) load();
      } else {
        if (previous.accountEpoch !== snapshot?.accountEpoch || previous.generation !== snapshot?.generation) {
          // The old transport may never settle. Release only its local owner,
          // not the stored unknown outcome, so the renewed session can look up
          // the same identity without waiting for or replaying that transport.
          epoch.current++;
          busy.current = false;
          publish({ ...current.current, busy: false, result: null, reviewChanged: false,
            error: current.current.envelope ? unknown : current.current.error });
        }
        if (active() && !current.current.storageReady && !current.current.error) load();
      }
    };
    const unsubscribe = lifecycle?.subscribe(changed);
    changed();
    return () => { alive.current = false; epoch.current++; busy.current = false; unsubscribe?.(); };
  }, [lifecycle]);
  const stored = (envelope: FleetCreationEnvelope) =>
    sessionStorage.getItem(fleetCreationStorageKey(envelope.actorId)) === JSON.stringify(envelope);
  const remove = (envelope: FleetCreationEnvelope) => {
    if (!stored(envelope)) throw new Error("creation ownership changed");
    sessionStorage.removeItem(fleetCreationStorageKey(envelope.actorId));
  };
  const run = async (envelope: FleetCreationEnvelope, mode: "first" | "retry" | "lookup") => {
    const owner = active();
    if (!alive.current || !owner || busy.current || current.current.result ||
      owner.session!.user.id !== envelope.actorId || current.current.envelope !== envelope) return;
    const token = ++epoch.current;
    const owns = () => alive.current && epoch.current === token &&
      active()?.accountEpoch === owner.accountEpoch && active()?.generation === owner.generation &&
      active()?.session?.user.id === envelope.actorId && current.current.envelope === envelope;
    busy.current = true;
    publish({ ...current.current, busy: true, error: null, reviewChanged: false });
    try {
      // Refuse a different owner or unavailable persistence before any send.
      if (!stored(envelope)) throw new Error("creation ownership changed");
      const value = await request<unknown>(
        mode === "lookup" ? `/admin/fleet-batches/${envelope.batchId}` : "/admin/fleet-batches",
        mode === "lookup" ? {} : {
          method: "POST",
          headers: { "If-None-Match": "*" },
          body: JSON.stringify({ id: envelope.batchId, ...envelope.request }),
        },
      );
      if (!owns()) return;
      if (!stored(envelope)) throw new Error("creation ownership changed");
      const result = matchFleetCreation(value, envelope);
      if (!result) throw new Error("creation identity mismatch");
      publish({ ...current.current, result, busy: false });
    } catch (error) {
      if (!owns()) return;
      // Only a typed rejection of the first send can resolve noncreation. A
      // restored envelope, previous response loss or retry keeps uncertainty.
      if (mode === "first" && error instanceof APIError && error.status === 409 &&
        error.details && typeof error.details === "object" && "code" in error.details &&
        error.details.code === "FLEET_REVIEW_CHANGED") {
        try {
          remove(envelope);
          publish({ ...empty(), storageReady: true, reviewChanged: true,
            error: "计划需要重新核对，尚未创建批次。请重新预览后再创建。" });
          return;
        } catch { /* Keep the original envelope if cleanup cannot be verified. */ }
      }
      publish({ ...current.current, busy: false,
        error: mode === "lookup" && error instanceof APIError && error.status === 404
          ? "尚未查到该批次，创建结果仍未确认。可再次查询，或用同一份计划重试创建。" : unknown });
    } finally {
      if (alive.current && token === epoch.current) {
        busy.current = false;
        if (current.current.busy) publish({ ...current.current, busy: false });
      }
    }
  };
  const start = async (input: FleetCreationRequest) => {
    const owner = active();
    if (!alive.current || !owner || !current.current.storageReady || busy.current || current.current.envelope) return;
    const actorId = owner.session!.user.id;
    const envelope = parseFleetCreation(JSON.stringify({ version: 1, actorId,
      batchId: newID("batch"), request: input }));
    if (!envelope) {
      publish({ ...current.current, error: "创建信息无法核对，请重新预览后再创建。" });
      return;
    }
    try {
      if (sessionStorage.getItem(fleetCreationStorageKey(actorId)) !== null) { load(); return; }
      sessionStorage.setItem(fleetCreationStorageKey(actorId), JSON.stringify(envelope));
      if (!stored(envelope)) throw new Error("creation record not retained");
    } catch {
      publish({ ...current.current, storageReady: false,
        error: "无法保存本页创建记录，尚未发送。请允许浏览器保存会话记录后重试。" });
      return;
    }
    publish({ ...empty(), envelope, storageReady: true });
    await run(envelope, "first");
  };
  const prepareClear = () => {
    // Capture when the UI opens its decision, never when a delayed confirmation
    // finally resolves. A confirmation is not permission to clear another task.
    const envelope = state.envelope;
    const owner = active();
    const token = epoch.current;
    if (!alive.current || busy.current || !envelope || !owner ||
      current.current.envelope !== envelope || owner.session!.user.id !== envelope.actorId) return null;
    return () => {
      const now = active();
      if (!alive.current || busy.current || token !== epoch.current ||
        current.current.envelope !== envelope || now?.session?.user.id !== envelope.actorId ||
        now?.accountEpoch !== owner.accountEpoch || now?.generation !== owner.generation) return false;
      try {
        remove(envelope);
        epoch.current++;
        publish({ ...empty(), storageReady: true });
        return true;
      } catch {
        publish({ ...current.current, error: "无法清除本页创建记录，请重试。服务器上的批次不会因此删除。" });
        return false;
      }
    };
  };
  return {
    ...state,
    available: !!active(),
    blocked: !state.storageReady || !!state.envelope,
    start,
    lookup: () => { const e = current.current.envelope; if (e) return run(e, "lookup"); },
    retry: () => { const e = current.current.envelope; if (e) return run(e, "retry"); },
    // Capture this callback before asking to abandon an unknown result.
    prepareClear,
    resetFeedback: () => {
      if (current.current.storageReady && !current.current.envelope && !busy.current)
        publish({ ...current.current, error: null, reviewChanged: false });
    },
    retryStorage: () => { if (!current.current.envelope && !busy.current) load(); },
  };
}
