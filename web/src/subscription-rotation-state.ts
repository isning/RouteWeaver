import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";

type RotationState = "pending" | "unknown";
function createRotationState() {
  let snapshot: ReadonlyMap<string, RotationState> = new Map();
  const listeners = new Set<() => void>();
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(id: string, state?: RotationState) {
      const next = new Map(snapshot);
      if (state) next.set(id, state);
      else next.delete(id);
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}
// SessionBoundary creates a separate QueryClient for each account epoch.
// Only output IDs and uncertainty are retained, never response bodies or secrets.
// This survives page remounts within that epoch, NOT reloads or a new session.
const scopes = new WeakMap<QueryClient, ReturnType<typeof createRotationState>>();
export function useSubscriptionRotationState(client: QueryClient) {
  let scope = scopes.get(client);
  if (!scope) {
    scope = createRotationState();
    scopes.set(client, scope);
  }
  const states = useSyncExternalStore(scope.subscribe, scope.snapshot);
  return { states, scope };
}
