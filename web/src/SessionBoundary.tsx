import { SecurityRecoveryProvider } from "./SecurityRecovery";
import { UIProviders } from "./ui-patterns/providers";
import { LoadingState } from "./ui-patterns/loading-state";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import type { Session } from "./types";
import { installSessionTransport } from "./api";
import { SessionLifecycle, type SessionSnapshot } from "./SessionLifecycle";
const Context = createContext<{
  lifecycle: SessionLifecycle;
  snapshot: SessionSnapshot;
} | null>(null);
export function useOptionalSessionAccess() {
  return useContext(Context);
}
export function useSessionAccess() {
  const value = useOptionalSessionAccess();
  if (!value) throw new Error("Session boundary required");
  return value;
}
type FocusPosition = {
  element: HTMLElement;
  selection:
    | [number | null, number | null, "forward" | "backward" | "none" | null]
    | null;
};
function focusPosition(element: HTMLElement): FocusPosition {
  const text =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement;
  return {
    element,
    selection: text
      ? [
          element.selectionStart,
          element.selectionEnd,
          element.selectionDirection,
        ]
      : null,
  };
}
export function SessionBoundary({
  children,
  login,
}: {
  children: ReactNode;
  login: (props: {
    onSuccess: (s: Session) => void;
    initialError: Error | null;
  }) => ReactNode;
}) {
  const [lifecycle] = useState(() => new SessionLifecycle());
  const previousFocus = useRef<FocusPosition | null>(null);
  const subscribe = useCallback(
    (listener: () => void) =>
      lifecycle.subscribe(() => {
        const next = lifecycle.getSnapshot();
        const element = document.activeElement;
        if (
          next.phase !== "active" &&
          element instanceof HTMLElement &&
          element.closest("[data-session-workspace]")
        ) {
          previousFocus.current = focusPosition(element);
        }
        listener();
      }),
    [lifecycle],
  );
  const snapshot = useSyncExternalStore(subscribe, lifecycle.getSnapshot);
  useLayoutEffect(() => {
    const uninstall = installSessionTransport(lifecycle);
    lifecycle.start();
    let channel: BroadcastChannel | undefined;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel("routeweaver-session");
        channel.addEventListener("message", (event) => {
          if (event.data === "session-changed") void lifecycle.check("changed");
        });
      }
    } catch {
      /* Request and reconnect validation remain available when unsupported. */
    }
    lifecycle.setNotifier(() => channel?.postMessage("session-changed"));
    const online = () => void lifecycle.check();
    window.addEventListener("online", online);
    window.addEventListener("offline", lifecycle.pause);
    return () => {
      lifecycle.setNotifier(() => {});
      channel?.close();
      uninstall();
      lifecycle.dispose();
      window.removeEventListener("online", online);
      window.removeEventListener("offline", lifecycle.pause);
    };
  }, [lifecycle]);
  useLayoutEffect(() => {
    lifecycle.commit(snapshot.generation);
  }, [lifecycle, snapshot]);
  const active = snapshot.phase === "active";
  useLayoutEffect(() => {
    if (!active) return;
    const saved = previousFocus.current;
    previousFocus.current = null;
    if (
      !saved ||
      !saved.element.isConnected ||
      saved.element.closest("[hidden],[inert]")
    )
      return;
    if (
      document.activeElement !== document.body &&
      document.activeElement !== saved.element
    )
      return;
    saved.element.focus({ preventScroll: true });
    if (saved.selection?.[0] != null && saved.selection[1] != null) {
      (
        saved.element as HTMLInputElement | HTMLTextAreaElement
      ).setSelectionRange(
        saved.selection[0],
        saved.selection[1],
        saved.selection[2] ?? undefined,
      );
    }
  }, [active, snapshot.accountEpoch]);
  return (
    <Context.Provider value={{ lifecycle, snapshot }}>
      <SecurityRecoveryProvider authorize={(actor) => {
        if (lifecycle.getSnapshot().session?.user.id !== actor) throw new Error("账号已变化，本次安全操作尚未提交。");
        const guard = lifecycle.beforeRequest();
        guard.beforeSend();
        return guard.beforeSend;
      }} reconcile={async (actor, action, receipt) => {
        if (action === "revoke-session") {
          if (receipt && typeof receipt === "object" && "current" in receipt && receipt.current === true &&
              lifecycle.getSnapshot().session?.user.id === actor) {
            lifecycle.forget();
            return true;
          }
          return;
        }
        if (action !== "password" && action !== "mfa-enable") return;
        lifecycle.changed();
        await lifecycle.check();
        // A successful read publishes accepting; wait for the matching React
        // commit before releasing the shared write owner. Disposal also wakes it.
        if (lifecycle.getSnapshot().phase === "accepting") {
          await new Promise<void>((resolve) => {
            const unsubscribe = lifecycle.subscribe(() => { unsubscribe(); resolve(); });
          });
        }
        const current = lifecycle.getSnapshot();
        if (current.session?.user.id !== actor || current.phase !== "active" ||
            action === "mfa-enable" && current.session.user.mfaEnabled !== true)
          throw new Error("安全操作结果尚未确认。");
      }}>
      {snapshot.session && (
        <PrivateWorkspace
          key={snapshot.accountEpoch}
          active={active}
          concealed={snapshot.concealed}
          refreshQueries={snapshot.refreshQueries}
        >
          {children}
        </PrivateWorkspace>
      )}
      {!active && !snapshot.concealed && (
        <RoutineCheckStatus retry={() => void lifecycle.check()} />
      )}
      {!active && snapshot.concealed && (
        <div
          className={snapshot.phase === "recovery" ? "w-full min-w-0" : "mx-auto w-full min-w-0 max-w-lg space-y-4 p-4 sm:p-6"}
          role="region"
          aria-label="恢复登录"
        >
          {(snapshot.phase === "checking" ||
            snapshot.phase === "accepting") && (
            <LoadingState layout="form" label="正在确认登录状态" />
          )}
          {snapshot.phase === "offline" && (
            <div className="space-y-4 rounded-xl border bg-card p-6 text-card-foreground">
              <Notice tone="error" title="暂时无法确认登录状态">
                {snapshot.error?.message}
              </Notice>
              <ActionButton
                onClick={() => void lifecycle.check()}
                variant="outline"
              >
                重新连接
              </ActionButton>
            </div>
          )}
          <div
            hidden={snapshot.phase !== "recovery"}
            inert={snapshot.phase !== "recovery"}
          >
            {login({ onSuccess: lifecycle.signedIn, initialError: null })}
          </div>
        </div>
      )}
      </SecurityRecoveryProvider>
    </Context.Provider>
  );
}
function PrivateWorkspace({
  active,
  concealed,
  refreshQueries,
  children,
}: {
  active: boolean;
  concealed: boolean;
  refreshQueries: boolean;
  children: ReactNode;
}) {
  const parent = useQueryClient();
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          ...parent.getDefaultOptions(),
          queries: {
            ...parent.getDefaultOptions().queries,
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
          },
          mutations: {
            ...parent.getDefaultOptions().mutations,
            retry: false,
            networkMode: "always",
          },
        },
      }),
  );
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (active && refreshQueries) void client.invalidateQueries();
  }, [active, client, refreshQueries]);
  useLayoutEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  return (
    <div
      data-session-workspace
      aria-busy={!active}
      hidden={concealed}
      inert={!active}
      ref={setPortal}
    >
      {portal && (
        <QueryClientProvider client={client}>
          <UIProviders portal={portal}>{children}</UIProviders>
        </QueryClientProvider>
      )}
    </div>
  );
}
function RoutineCheckStatus({ retry }: { retry: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 800);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      className={
        visible
          ? "fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b bg-background p-3 text-sm"
          : "sr-only"
      }
      role="status"
    >
      <span>正在确认登录状态</span>
      {visible && (
        <ActionButton onClick={retry} variant="outline" size="sm">
          重新确认
        </ActionButton>
      )}
    </div>
  );
}
