import type { WorkspaceHistory } from "./workspace-history";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

type ListContext = {
  search: string;
  page: number;
  linkPages: Record<string, number>;
  scrollY: number;
  focus?: { anchor: string; label: string; tag: string };
};
const empty = (): ListContext => ({
  search: "",
  page: 1,
  linkPages: {},
  scrollY: 0,
});
/** Account-owned, bounded working context. Never persisted or used as query keys. */
class SubscriptionContexts {
  private values = new Map<string, ListContext>();
  private listeners = new Set<() => void>();
  read = (scope: string): ListContext => {
    let value = this.values.get(scope);
    if (!value) {
      value = empty();
      this.values.set(scope, value);
      if (this.values.size > 8)
        this.values.delete(this.values.keys().next().value!);
    }
    return value;
  };
  update(
    scope: string,
    patch:
      Partial<ListContext> | ((current: ListContext) => Partial<ListContext>),
  ) {
    const current = this.read(scope);
    const change = typeof patch === "function" ? patch(current) : patch;
    if (
      Object.entries(change).every(
        ([key, value]) => current[key as keyof ListContext] === value,
      )
    )
      return;
    this.values.delete(scope);
    this.values.set(scope, { ...current, ...change });
    this.listeners.forEach((listener) => listener());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
const Context = createContext<SubscriptionContexts | null>(null);
export function SubscriptionContextProvider({
  children,
  accountKey,
}: {
  children: ReactNode;
  accountKey?: string;
}) {
  const store = useMemo(() => new SubscriptionContexts(), [accountKey]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useSubscriptionContext(profile?: string) {
  const shared = useContext(Context);
  const [local] = useState(() => new SubscriptionContexts());
  const store = shared || local;
  // Prefix avoids treating a real Profile ID as the all-profiles scope.
  const scope = profile === undefined ? "all" : `profile:${profile}`;
  const snapshot = useCallback(() => store.read(scope), [store, scope]);
  const value = useSyncExternalStore(store.subscribe, snapshot);
  const update = useCallback(
    (
      patch:
        Partial<ListContext> | ((current: ListContext) => Partial<ListContext>),
    ) => store.update(scope, patch),
    [store, scope],
  );
  return [value, update] as const;
}

export const WorkspaceHistoryContext =
  createContext<RefObject<WorkspaceHistory | null> | null>(null);
