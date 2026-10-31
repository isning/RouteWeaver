import { useLayoutEffect, useRef, useState } from "react";
import { APIError, post, request } from "./api";
import type { SessionLifecycle, SessionSnapshot } from "./SessionLifecycle";
import { newID } from "./model";
import {
  parsePublicationEnvelope,
  publicationStorageKey,
  validatePublicationLookup,
  validatePublicationResult,
  type PublicationEnvelope,
  type PublicationRequest,
  type PublicationResult,
} from "./publication-request";

type State = {
  envelope: PublicationEnvelope | null;
  result: PublicationResult | null;
  busy: boolean;
  absent: boolean;
  error: string | null;
  cleanupError: boolean;
  cleared: boolean;
};
const empty = (): State => ({
  envelope: null,
  result: null,
  busy: false,
  absent: false,
  error: null,
  cleanupError: false,
  cleared: false,
});
export type PublicationOwner = ReturnType<typeof usePublicationRequest>;
/** One actor/tab-owned request; a receipt is historical acknowledgement, not runtime state. */
export function usePublicationRequest(
  lifecycle: SessionLifecycle,
  snapshot: SessionSnapshot,
) {
  const [state, setState] = useState<State>(empty);
  const current = useRef(state);
  const alive = useRef(false);
  const busy = useRef(false);
  const loadedActor = useRef<string | null>(null);
  const storageReady = useRef(false);
  const refreshStorage = useRef<() => void>(() => {});
  const epoch = useRef(0);
  const publish = (next: State) => {
    current.current = next;
    setState(next);
  };
  const active = () => {
    const s = lifecycle.getSnapshot();
    return s.phase === "active" && s.session?.user.role === "admin" ? s : null;
  };
  const clearStoredActor = (actorId: string) => {
    try {
      const raw = sessionStorage.getItem(publicationStorageKey);
      const old = raw ? parsePublicationEnvelope(raw) : null;
      if (!raw || !old || old.actorId === actorId)
        sessionStorage.removeItem(publicationStorageKey);
    } catch {
      /* Identity gates still hide any inaccessible old bytes. */
    }
  };
  useLayoutEffect(() => {
    alive.current = true;
    const reconcileIdentity = () => {
      const s = lifecycle.getSnapshot();
      const actor = s.session?.user.id;
      if (
        loadedActor.current &&
        (actor !== loadedActor.current || s.session?.user.role !== "admin")
      ) {
        clearStoredActor(loadedActor.current);
        loadedActor.current = null;
        storageReady.current = false;
        epoch.current++;
        busy.current = false;
        publish(empty());
      }
      if (s.phase !== "active" || !actor) return;
      if (s.session?.user.role !== "admin") {
        try {
          sessionStorage.removeItem(publicationStorageKey);
        } catch {
          /* No permission, no restore. */
        }
        return;
      }
      if (loadedActor.current === actor) return;
      loadedActor.current = actor;
      try {
        const raw = sessionStorage.getItem(publicationStorageKey);
        if (!raw) {
          storageReady.current = true;
          publish(empty());
          return;
        }
        const restored = parsePublicationEnvelope(raw);
        if (!restored || restored.actorId !== actor) {
          sessionStorage.removeItem(publicationStorageKey);
          storageReady.current = true;
          if (restored) publish(empty());
          if (!restored)
            publish({
              ...empty(),
              error: "本页提交记录无法读取，请重新检查后提交。",
            });
          return;
        }
        Object.freeze(restored.request);
        Object.freeze(restored);
        storageReady.current = true;
        publish({ ...empty(), envelope: restored });
      } catch {
        publish({
          ...empty(),
          error: "无法读取本页提交记录。请允许浏览器保存会话记录后重试。",
        });
      }
    };
    refreshStorage.current = () => {
      if (!current.current.envelope) {
        loadedActor.current = null;
        reconcileIdentity();
      }
    };
    const unsubscribe = lifecycle.subscribe(reconcileIdentity);
    reconcileIdentity();
    return () => {
      alive.current = false;
      epoch.current++;
      busy.current = false;
      unsubscribe();
    };
  }, [lifecycle]);
  const run = async (
    envelope: PublicationEnvelope,
    mode: "lookup" | "send",
  ) => {
    const owner = active();
    if (
      !alive.current ||
      !owner ||
      owner.session?.user.id !== envelope.actorId ||
      busy.current ||
      current.current.result
    )
      return;
    busy.current = true;
    const token = epoch.current;
    const stillOwner = () =>
      alive.current &&
      token === epoch.current &&
      active()?.accountEpoch === owner.accountEpoch &&
      active()?.session?.user.id === envelope.actorId &&
      current.current.envelope?.operationId === envelope.operationId;
    publish({ ...current.current, busy: true, error: null, absent: false });
    try {
      const value =
        mode === "lookup"
          ? await request<unknown>(
              `/server-deployments/${envelope.deploymentId}/publication-requests/${envelope.operationId}`,
            )
          : await post<unknown>(
              `/server-deployments/${envelope.deploymentId}/publish`,
              { operationId: envelope.operationId, ...envelope.request },
            );
      if (!stillOwner()) return;
      const result =
        mode === "lookup"
          ? validatePublicationLookup(value, envelope)
          : validatePublicationResult(value, envelope);
      if (!result)
        throw new Error("返回的提交记录无法核对，提交结果仍待确认。");
      // Adopt first. A rendered notice acknowledges display before storage cleanup.
      publish({
        ...current.current,
        result,
        busy: false,
        error: null,
        absent: false,
      });
    } catch (error) {
      if (!stillOwner()) return;
      const absent =
        mode === "lookup" && error instanceof APIError && error.status === 404;
      publish({
        ...current.current,
        busy: false,
        absent,
        error: absent
          ? "尚未查到该次提交记录，结果仍待确认。"
          : "提交结果尚未确认，请核对该次提交记录。",
      });
    } finally {
      if (alive.current && token === epoch.current) {
        busy.current = false;
        if (current.current.busy) publish({ ...current.current, busy: false });
      }
    }
  };
  const start = async (deploymentId: string, input: PublicationRequest) => {
    const owner = active();
    if (
      !alive.current ||
      !owner ||
      !storageReady.current ||
      busy.current ||
      current.current.result?.status === "definitively-rejected" ||
      (current.current.envelope && !current.current.cleared)
    )
      return;
    const envelope: PublicationEnvelope = {
      version: 1,
      actorId: owner.session!.user.id,
      deploymentId,
      operationId: newID("publication"),
      request: { ...input },
    };
    Object.freeze(envelope.request);
    Object.freeze(envelope);
    const raw = JSON.stringify(envelope);
    if (!parsePublicationEnvelope(raw)) {
      publish({ ...empty(), error: "提交信息无法核对，请重新检查转发路径。" });
      return;
    }
    // Persist before the first send. No silent in-memory-only fallback.
    try {
      sessionStorage.setItem(publicationStorageKey, raw);
    } catch {
      publish({
        ...empty(),
        error:
          "无法保存本页提交记录，尚未发送。请允许浏览器保存会话记录后重试。",
      });
      return;
    }
    publish({ ...empty(), envelope });
    await run(envelope, "send");
  };
  const reconcile = () => {
    const e = current.current.envelope;
    if (e) return run(e, "lookup");
  };
  const resend = () => {
    const e = current.current.envelope;
    if (e && current.current.absent) return run(e, "send");
  };
  const acknowledgeDisplayed = () => {
    const value = current.current;
    const actor = active()?.session?.user.id;
    if (
      document.visibilityState !== "visible" ||
      !value.result ||
      !value.envelope ||
      value.cleared ||
      !actor ||
      value.envelope.actorId !== actor
    )
      return;
    try {
      const raw = sessionStorage.getItem(publicationStorageKey);
      const old = raw ? parsePublicationEnvelope(raw) : null;
      if (
        old &&
        (old.actorId !== actor ||
          old.operationId !== value.envelope.operationId)
      )
        throw new Error("different owner");
      sessionStorage.removeItem(publicationStorageKey);
      publish({ ...value, cleared: true, cleanupError: false });
    } catch {
      if (!value.cleanupError) publish({ ...value, cleanupError: true });
    }
  };
  const finishRejectedReload = (deploymentId: string, operationId?: string) => {
    if (
      current.current.result?.status === "definitively-rejected" &&
      current.current.envelope?.deploymentId === deploymentId &&
      current.current.envelope?.operationId === operationId &&
      current.current.cleared &&
      active()
    )
      publish(empty());
  };
  const dismissRejected = () => {
    const value = current.current;
    if (value.result?.status !== "definitively-rejected" || !value.cleared ||
        value.cleanupError || !value.envelope ||
        active()?.session?.user.id !== value.envelope.actorId) return false;
    publish(empty());
    return true;
  };
  return {
    ...state,
    dismissRejected,
    pendingDeploymentId: snapshot.phase === "active" && snapshot.session?.user.role === "admin" && snapshot.session.user.id === state.envelope?.actorId && !state.cleared ? state.envelope.deploymentId : undefined,
    finishRejectedReload,
    available:
      snapshot.phase === "active" && snapshot.session?.user.role === "admin",
    storageReady: storageReady.current,
    retryStorage: () => refreshStorage.current(),
    blocked: !storageReady.current || (!!state.envelope && !state.cleared),
    start,
    reconcile,
    resend,
    acknowledgeDisplayed,
  };
}
