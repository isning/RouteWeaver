import { useLayoutEffect, useRef, useState } from "react";
import { APIError, post, request } from "./api";
import { useOptionalSessionAccess } from "./SessionBoundary";
import type { DiagnosticJob, DiagnosticKind } from "./diagnostics-model";

export type DiagnosticRequest = {
  id: string;
  targetId: string;
  instanceId: string;
  pathMode: "node_direct" | "managed_route";
  publishedRouteId?: string;
  kind: DiagnosticKind;
  maxBytes: number;
  timeoutSeconds: number;
};
type Envelope = { version: 1; actorId: string; request: DiagnosticRequest };
type State = { envelope: Envelope | null; corrupt: boolean; unavailable: boolean; busy: boolean; error: string | null };
const empty = (): State => ({ envelope: null, corrupt: false, unavailable: false, busy: false, error: null });
const storageKey = (actor: string) => `routeweaver.diagnostic-request.v1.${encodeURIComponent(actor)}`;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
function parse(raw: string): Envelope | null {
  try {
    if (raw.length > 2048) return null;
    const e = JSON.parse(raw), r = e?.request;
    if (!e || e.version !== 1 || !id(e.actorId) || Object.keys(e).sort().join() !== "actorId,request,version" || !r) return null;
    const keys = ["id", "targetId", "instanceId", "pathMode", "kind", "maxBytes", "timeoutSeconds"];
    if (r.pathMode === "managed_route") keys.push("publishedRouteId");
    if (Object.keys(r).sort().join() !== keys.sort().join() || !id(r.id) || !id(r.targetId) || !id(r.instanceId) ||
      !["node_direct", "managed_route"].includes(r.pathMode) || (r.pathMode === "managed_route" && !id(r.publishedRouteId)) ||
      !["connectivity", "download", "upload"].includes(r.kind) || !Number.isSafeInteger(r.maxBytes) ||
      r.maxBytes > 16777216 || (r.kind === "connectivity" ? r.maxBytes !== 0 : r.maxBytes < 1024) ||
      !Number.isInteger(r.timeoutSeconds) || r.timeoutSeconds < 1 || r.timeoutSeconds > 30) return null;
    return e as Envelope;
  } catch { return null; }
}
function matches(value: unknown, e: Envelope): value is DiagnosticJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.requestedBy === e.actorId && Object.entries(e.request).every(([k, x]) => v[k] === x) &&
    (v.publishedRouteId ?? "") === (e.request.publishedRouteId ?? "") &&
    ["queued", "running", "cancel_requested", "succeeded", "failed", "not_run", "cancelled", "unknown"].includes(String(v.status));
}
/** Only request identity/limits are persisted. Never credentials, URLs or runtime paths. */
export function useDiagnosticRequest(onCreated: (job: DiagnosticJob) => void) {
  const access = useOptionalSessionAccess();
  const lifecycle = access?.lifecycle;
  const [state, setState] = useState<State>(empty);
  const current = useRef(state);
  const alive = useRef(false);
  const epoch = useRef(0);
  const rawRecord = useRef<string | null>(null);
  const loadedActor = useRef<string | null>(null);
  const loadedGeneration = useRef<number | null>(null);
  const publish = (next: State) => { current.current = next; setState(next); };
  const active = () => {
    const s = lifecycle?.getSnapshot();
    return s?.phase === "active" && s.session?.user.role === "admin" ? s : null;
  };
  const load = (actor: string) => {
    try {
      const raw = sessionStorage.getItem(storageKey(actor));
      rawRecord.current = raw;
      const e = raw === null ? null : parse(raw);
      publish({ ...empty(), envelope: e?.actorId === actor ? e : null, corrupt: raw !== null && (!e || e.actorId !== actor) });
    } catch {
      publish({ ...empty(), unavailable: true, error: "无法读取本页测试提交记录。请允许浏览器保存会话记录后重试。" });
    }
  };
  useLayoutEffect(() => {
    alive.current = true;
    const changed = () => {
      const s = lifecycle?.getSnapshot();
      const actor = s?.session?.user.role === "admin" ? s.session.user.id : null;
      if (loadedGeneration.current !== s?.generation) {
        loadedGeneration.current = s?.generation ?? null;
        epoch.current++;
        if (current.current.busy) publish({ ...current.current, busy: false });
      }
      if (actor !== loadedActor.current) {
        epoch.current++;
        loadedActor.current = actor;
        rawRecord.current = null;
        publish(empty());
        // Preserve another actor's nonsecret record; never silently lose unknown traffic.
        if (actor) load(actor);
      }
    };
    const unsubscribe = lifecycle?.subscribe(changed);
    changed();
    return () => { alive.current = false; epoch.current++; unsubscribe?.(); };
  }, [lifecycle]);
  const run = async (e: Envelope, send: boolean) => {
    const owner = active(), token = epoch.current;
    if (!owner || !alive.current || current.current.busy || owner.session!.user.id !== e.actorId) return;
    const generation = owner.generation;
    const stillOwner = () => alive.current && token === epoch.current &&
      active()?.generation === generation && active()?.accountEpoch === owner.accountEpoch &&
      active()?.session?.user.id === e.actorId && current.current.envelope?.request.id === e.request.id;
    publish({ ...current.current, busy: true, error: null });
    try {
      const value = send ? await post<unknown>("/admin/diagnostic-jobs", e.request) :
        await request<unknown>(`/admin/diagnostic-jobs/${encodeURIComponent(e.request.id)}`);
      if (!stillOwner()) return;
      if (!matches(value, e)) throw new Error("mismatched diagnostic receipt");
      // Do not erase a newer same-tab owner. Cleanup failure leaves recovery blocked.
      if (sessionStorage.getItem(storageKey(e.actorId)) !== rawRecord.current) throw new Error("changed record");
      sessionStorage.removeItem(storageKey(e.actorId));
      rawRecord.current = null;
      publish(empty());
      onCreated(value);
    } catch (error) {
      if (!stillOwner()) return;
      publish({ ...current.current, busy: false, error: !send && error instanceof APIError && error.status === 404
        ? "尚未查到该次测试，提交结果仍未确认。" : "测试提交结果未确认。请核对上次提交，避免重复产生流量。" });
    } finally {
      // An invalidated response never changes identity-owned data, but release this UI spinner.
      if (alive.current && token === epoch.current && current.current.busy)
        publish({ ...current.current, busy: false });
    }
  };
  const start = async (input: DiagnosticRequest) => {
    const owner = active();
    if (!owner || !alive.current || current.current.busy || current.current.envelope || current.current.corrupt || current.current.unavailable) return;
    const actor = owner.session!.user.id;
    const e: Envelope = { version: 1, actorId: actor, request: { ...input } };
    const raw = JSON.stringify(e);
    if (!parse(raw)) { publish({ ...empty(), error: "请检查测试目标、路径和测试上限。" }); return; }
    try {
      // Recheck persisted ownership before writing. No await before dispatch.
      if (sessionStorage.getItem(storageKey(actor)) !== null) { load(actor); return; }
      sessionStorage.setItem(storageKey(actor), raw);
      rawRecord.current = raw;
    } catch {
      publish({ ...empty(), unavailable: true, error: "无法保存本页测试提交记录，尚未发送。请允许浏览器保存会话记录后重试。" });
      return;
    }
    publish({ ...empty(), envelope: e });
    await run(e, true);
  };
  const prepareDiscard = () => {
    const owner = active();
    const token = epoch.current;
    const raw = rawRecord.current;
    if (!owner || (!current.current.corrupt && !current.current.envelope) || current.current.busy) return () => false;
    const actor = owner.session!.user.id;
    return () => {
      const now = active();
      if (!alive.current || token !== epoch.current || now?.generation !== owner.generation ||
        now?.accountEpoch !== owner.accountEpoch || now?.session?.user.id !== actor ||
        (!current.current.corrupt && !current.current.envelope) || current.current.busy || rawRecord.current !== raw) return false;
      try {
        if (sessionStorage.getItem(storageKey(actor)) !== raw) { load(actor); return false; }
        sessionStorage.removeItem(storageKey(actor));
        load(actor);
        return true;
      } catch { publish({ ...current.current, error: "无法清除本页记录，请检查浏览器的会话存储设置。" }); }
      return false;
    };
  };
  return { ...state, available: !!active(), start,
    reconcile: () => { const e = current.current.envelope; if (e) void run(e, false); },
    retryStorage: () => { const s = active(); if (s && !current.current.busy) load(s.session!.user.id); },
    prepareDiscard,
  };
}
