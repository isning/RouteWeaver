/** Accepted navigation, unlike raw browser events, is safe for mounted editors to consume. */
export const WORKSPACE_NAVIGATION_EVENT = "routeweaver:navigation";
const STATE_KEY = "routeweaverEntry";
const LINEAGE_KEY = "routeweaverLineage";
const POSITION_KEY = "routeweaverPosition";
const opaque = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function readProof() {
  const state = history.state;
  if (
    !state ||
    !opaque(state[STATE_KEY]) ||
    !opaque(state[LINEAGE_KEY]) ||
    !Number.isSafeInteger(state[POSITION_KEY]) ||
    state[POSITION_KEY] < 0
  )
    return;
  return {
    proof: state[STATE_KEY] as string,
    lineage: state[LINEAGE_KEY] as string,
    position: state[POSITION_KEY] as number,
  };
}
/** Preserve only validated, nonprivate provenance when the authenticated workspace ends. */
export function currentWorkspaceHistoryState() {
  const proof = readProof();
  return proof
    ? {
        [STATE_KEY]: proof.proof,
        [LINEAGE_KEY]: proof.lineage,
        [POSITION_KEY]: proof.position,
      }
    : null;
}
export interface WorkspaceHistoryOptions {
  isDirty(): boolean;
  isActive?(): boolean;
  confirm(
    proceed: () => void,
    cancel: () => void,
    context?: { unowned: true },
  ): void | { destroy(): void };
  accept(hash: string, discarded: boolean): void;
}
export interface WorkspaceHistory {
  navigate(hash: string, options?: { replace?: boolean }): void;
  /** Authorize synchronous view completion; committed cache facts stay outside this lease. */
  bindView(
    expectedHash: string,
  ): (hash: string, complete?: () => void) => boolean;
  closeDetail(): void;
  resume(): void;
  suspend(): void;
  dispose(): void;
}
type Entry = { proof: string; hash: string; position: number };
export function createWorkspaceHistory(
  options: WorkspaceHistoryOptions,
): WorkspaceHistory {
  let alive = true;
  let viewGeneration = 0;
  const acceptedHashEvents = new WeakSet<Event>();
  const active = () => alive && (options.isActive?.() ?? true);
  const inherited = readProof();
  let lineage = inherited?.lineage ?? crypto.randomUUID();
  let position = inherited?.position ?? 0;
  const entry = (hash: string, index = position): Entry => ({
    proof: crypto.randomUUID(),
    hash,
    position: index,
  });
  const state = (item: Entry) => ({
    [STATE_KEY]: item.proof,
    [LINEAGE_KEY]: lineage,
    [POSITION_KEY]: item.position,
  });
  let accepted = entry(location.hash);
  const entries = new Map<number, Entry>([[position, accepted]]);
  history.replaceState(state(accepted), "", location.href);
  let transaction:
    | {
        target: Entry;
        stage: "restoring" | "confirming" | "replaying";
        prompt: boolean;
      }
    | undefined;
  let requested = false;
  let requestIntent: { hash: string; replace?: boolean } | undefined;
  let decisionGeneration = 0;
  let paused: { hash: string; target?: Entry; replace?: boolean } | undefined;
  let resumeRequested = false;
  let restoring = false;
  let unowned: { hash: string; prompting: boolean } | undefined;
  let confirmation: { destroy(): void } | undefined;
  const invalidateConfirmation = () => {
    decisionGeneration++;
    confirmation?.destroy();
    confirmation = undefined;
  };
  const publish = (item: Entry, discarded: boolean) => {
    const oldURL = new URL(
      accepted.hash || location.pathname + location.search,
      location.href,
    ).href;
    accepted = item;
    viewGeneration++;
    options.accept(item.hash, discarded);
    if (!alive) return;
    window.dispatchEvent(new Event(WORKSPACE_NAVIGATION_EVENT));
    if (!alive) return;
    const event = new HashChangeEvent("hashchange", {
      oldURL,
      newURL: location.href,
    });
    acceptedHashEvents.add(event);
    window.dispatchEvent(event);
  };
  const write = (hash: string, replace: boolean, discarded: boolean) => {
    if (!active()) return;
    const item = entry(hash, replace ? position : position + 1);
    if (replace) {
      history.replaceState(
        state(item),
        "",
        hash || location.pathname + location.search,
      );
      entries.set(position, item);
    } else {
      history.pushState(
        state(item),
        "",
        hash || location.pathname + location.search,
      );
      for (const index of entries.keys())
        if (index > position) entries.delete(index);
      position++;
      entries.set(position, item);
    }
    publish(item, discarded);
  };
  const ask = (
    proceed: () => void,
    cancel: () => void,
    context?: { unowned: true },
  ) => {
    let settled = false;
    const generation = decisionGeneration;
    const handle = options.confirm(
      () => {
        if (settled || !alive || generation !== decisionGeneration) return;
        settled = true;
        confirmation = undefined;
        if (active()) proceed();
        else cancel();
      },
      () => {
        if (settled || !alive || generation !== decisionGeneration) return;
        settled = true;
        confirmation = undefined;
        cancel();
      },
      context,
    );
    if (handle) {
      if (settled || generation !== decisionGeneration) handle.destroy();
      else confirmation = handle;
    }
  };
  const navigate = (hash: string, config?: { replace?: boolean }) => {
    if (!alive || transaction || requested || unowned) return;
    if (!active()) {
      paused = { hash, replace: config?.replace };
      return;
    }
    if (hash && !hash.startsWith("#"))
      throw new Error("Workspace navigation requires a hash");
    hash = new URL(hash || location.pathname + location.search, location.href)
      .hash;
    if (hash === accepted.hash) return;
    if (!options.isDirty()) return write(hash, !!config?.replace, false);
    requested = true;
    requestIntent = { hash, replace: config?.replace };
    ask(
      () => {
        requested = false;
        requestIntent = undefined;
        write(hash, !!config?.replace, true);
      },
      () => {
        requested = false;
        requestIntent = undefined;
      },
    );
  };
  const resume = () => {
    if (!active()) return;
    if (unowned) {
      resolveUnknown();
      return;
    }
    if (!paused) return;
    if (transaction) {
      resumeRequested = true;
      return;
    }
    const intent = paused;
    paused = undefined;
    resumeRequested = false;
    const targetIndex = intent.target?.position ?? -1;
    if (targetIndex >= 0 && targetIndex !== position)
      history.go(targetIndex - position);
    else navigate(intent.hash, { replace: intent.replace });
  };
  const restore = () => {
    const index = accepted.position;
    if (index !== position && !restoring) {
      restoring = true;
      history.go(index - position);
    }
  };
  const resetUnknown = (hash: string, push: boolean, discarded: boolean) => {
    if (!active()) return;
    lineage = crypto.randomUUID();
    const anchor = entry(hash, 0);
    if (push)
      history.pushState(
        state(anchor),
        "",
        hash || location.pathname + location.search,
      );
    else history.replaceState(state(anchor), "", location.href);
    entries.clear();
    entries.set(0, anchor);
    position = 0;
    unowned = undefined;
    if (push)
      accepted = anchor; // Keep the draft/view; only the disclosed return entry changes.
    else publish(anchor, discarded);
  };
  const resolveUnknown = () => {
    const pending = unowned;
    if (!active() || !pending || pending.prompting) return;
    if (!options.isDirty()) {
      resetUnknown(pending.hash, false, false);
      return;
    }
    pending.prompting = true;
    ask(
      () => {
        if (unowned === pending) resetUnknown(pending.hash, false, true);
      },
      () => {
        if (unowned === pending) {
          if (active()) resetUnknown(accepted.hash, true, false);
          else pending.prompting = false;
        }
      },
      { unowned: true },
    );
  };
  const onNative = (event: Event) => {
    if (!alive || acceptedHashEvents.has(event)) return;
    // Raw popstate/hashchange must never reach consumers before discard is resolved.
    event.stopImmediatePropagation();
    const proof = readProof();
    const existing = proof ? entries.get(proof.position) : undefined;
    const known =
      proof &&
      proof.lineage === lineage &&
      !(existing?.proof === proof.proof && existing.hash !== location.hash);
    if (!known) {
      // Only a foreign/missing lineage is unknown; normal reload/account entries retain position.
      // Never change an unknown target before the user sees the explicit Forward-loss warning.
      if (!unowned || unowned.hash !== location.hash) {
        invalidateConfirmation();
        unowned = { hash: location.hash, prompting: false };
        requested = false;
        requestIntent = undefined;
        transaction = undefined;
        restoring = false;
      }
      resolveUnknown();
      return;
    }
    if (unowned) {
      invalidateConfirmation();
      unowned = undefined;
    }
    position = proof.position;
    const current =
      existing?.proof === proof.proof
        ? existing
        : { proof: proof.proof, hash: location.hash, position };
    entries.set(position, current);
    if (current === accepted) restoring = false;
    if (transaction) {
      const pending = transaction;
      if (pending.stage === "replaying" && current === pending.target) {
        transaction = undefined;
        if (active()) publish(current, true);
        else {
          paused = { hash: current.hash, target: current };
          restore();
        }
      } else if (current !== accepted) {
        restore();
      } else if (pending.stage === "restoring") {
        if (!pending.prompt || !active()) {
          transaction = undefined;
          if (resumeRequested) resume();
          return;
        }
        pending.stage = "confirming";
        ask(
          () => {
            if (transaction !== pending) return;
            const targetIndex = pending.target.position;
            if (targetIndex < 0) {
              transaction = undefined;
              return;
            }
            pending.stage = "replaying";
            history.go(targetIndex - position);
          },
          () => {
            if (transaction === pending) transaction = undefined;
          },
        );
      }
      return;
    }
    if (current === accepted) return;
    if (!active() || options.isDirty() || requested) {
      if (!active()) paused = { hash: current.hash, target: current };
      transaction = {
        target: current,
        stage: "restoring",
        prompt: active() && !requested,
      };
      restore();
    } else publish(current, false);
  };
  window.addEventListener("popstate", onNative, true);
  window.addEventListener("hashchange", onNative, true);
  return {
    navigate,
    bindView(expectedHash) {
      const generation = viewGeneration;
      return (hash, complete) => {
        if (
          !active() ||
          generation !== viewGeneration ||
          transaction ||
          requested ||
          unowned ||
          accepted.hash !== expectedHash ||
          location.hash !== expectedHash
        )
          return false;
        // This is local view synchronization, not a new route or a second discard decision.
        if (
          !hash.startsWith("#") ||
          hash.split("?")[0] !== expectedHash.split("?")[0]
        )
          return false;
        hash = new URL(hash, location.href).hash;
        if (hash === accepted.hash) {
          if (complete) {
            viewGeneration++;
            complete();
          }
          return true;
        }
        const item = entry(hash);
        history.replaceState(state(item), "", hash);
        entries.set(position, item);
        accepted = item;
        viewGeneration++;
        complete?.();
        return true;
      };
    },
    resume,
    suspend() {
      if (!alive) return;
      viewGeneration++;
      invalidateConfirmation();
      if (unowned) unowned.prompting = false;
      if (requestIntent) paused = requestIntent;
      requestIntent = undefined;
      requested = false;
      if (transaction) {
        paused = { hash: transaction.target.hash, target: transaction.target };
        if (transaction.stage === "confirming") transaction = undefined;
        else transaction.prompt = false;
      }
    },
    closeDetail() {
      if (!active() || transaction || requested || unowned) return;
      const current = new URL(accepted.hash || "#", location.href);
      const query = new URLSearchParams(current.hash.split("?")[1]);
      if (!query.has("output") && !query.has("outputId")) return;
      query.delete("output");
      query.delete("outputId");
      const base = current.hash.split("?")[0];
      const listHash = base + (query.size ? `?${query}` : "");
      const previous = entries.get(position - 1);
      if (previous?.hash === listHash) history.back();
      else navigate(listHash, { replace: true });
    },
    dispose() {
      alive = false;
      invalidateConfirmation();
      unowned = undefined;
      requestIntent = undefined;
      transaction = undefined;
      paused = undefined;
      window.removeEventListener("popstate", onNative, true);
      window.removeEventListener("hashchange", onNative, true);
      entries.clear();
    },
  };
}
