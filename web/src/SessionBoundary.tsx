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
export function useSessionAccess() {
  const value = useContext(Context);
  if (!value) throw new Error("Session boundary required");
  return value;
}
type FocusPosition = {
  element: HTMLElement;
  selection:
    | [number | null, number | null, "forward" | "backward" | "none" | null]
    | null;
};
type DepartureOwner = {
  focus: FocusPosition;
  workspace: HTMLElement;
  accountEpoch: number;
  generation: number;
  tabIndex: number;
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
function eligibleDepartureOwner(element: HTMLElement) {
  if (
    !element.isConnected ||
    element.tabIndex < 0 ||
    element.matches(":disabled,[aria-disabled=true]") ||
    element.closest("[hidden],[inert],[aria-hidden=true]")
  )
    return false;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
function sameDepartureOwner(owner: DepartureOwner, snapshot: SessionSnapshot) {
  return (
    !snapshot.concealed &&
    owner.accountEpoch === snapshot.accountEpoch &&
    owner.generation === snapshot.generation &&
    owner.workspace.isConnected &&
    owner.focus.element.closest("[data-session-workspace]") ===
      owner.workspace &&
    owner.focus.element.tabIndex === owner.tabIndex &&
    eligibleDepartureOwner(owner.focus.element)
  );
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
  const previousFocus = useRef<
    | (FocusPosition & {
        departure?: DepartureOwner;
      })
    | null
  >(null);
  const tabDeparture = useRef<{
    owner: DepartureOwner;
    leftControl: boolean;
  } | null>(null);
  const departed = useRef<DepartureOwner | null>(null);
  const clearDeparture = () => {
    tabDeparture.current = null;
    departed.current = null;
    if (previousFocus.current?.departure) previousFocus.current = null;
  };
  const subscribe = useCallback(
    (listener: () => void) =>
      lifecycle.subscribe(() => {
        const next = lifecycle.getSnapshot();
        if (next.phase !== "active") {
          tabDeparture.current = null;
          departed.current = null;
          const saved = previousFocus.current?.departure;
          if (
            saved &&
            (next.concealed ||
              next.phase === "offline" ||
              next.phase === "recovery" ||
              saved.accountEpoch !== next.accountEpoch ||
              saved.generation !== next.generation)
          )
            previousFocus.current = null;
        }
        const element = document.activeElement;
        if (
          next.phase !== "active" &&
          element instanceof HTMLElement &&
          element.closest("[data-session-workspace]")
        ) {
          // Current user-owned focus takes priority over a departure fallback.
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
      /* Focus/reconnect validation remains available when unsupported. */
    }
    lifecycle.setNotifier(() => channel?.postMessage("session-changed"));
    // A single Tab departure owns this fallback, not a general last-focus
    // history. Routine revalidation still blocks writes and verifies identity.
    const keydown = (event: KeyboardEvent) => {
      const element = document.activeElement;
      // The returning Tab can arrive on BODY while verification is inert; it
      // is not a newer independently owned control or pointer intention.
      if (event.key === "Tab" && element === document.body) return;
      clearDeparture();
      const current = lifecycle.getSnapshot();
      const workspace =
        element instanceof HTMLElement
          ? element.closest<HTMLElement>("[data-session-workspace]")
          : null;
      if (
        event.key === "Tab" &&
        current.phase === "active" &&
        document.hasFocus() &&
        element instanceof HTMLElement &&
        workspace &&
        eligibleDepartureOwner(element)
      ) {
        tabDeparture.current = {
          leftControl: false,
          owner: {
            focus: focusPosition(element),
            workspace,
            accountEpoch: current.accountEpoch,
            generation: current.generation,
            tabIndex: element.tabIndex,
          },
        };
      }
    };
    const keyup = () => {
      tabDeparture.current = null;
    };
    const focusout = (event: FocusEvent) => {
      const gesture = tabDeparture.current;
      if (!gesture) return;
      if (
        event.target === gesture.owner.focus.element &&
        event.relatedTarget === null
      )
        gesture.leftControl = true;
      else tabDeparture.current = null;
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== document.body)
        clearDeparture();
    };
    const blur = () => {
      const gesture = tabDeparture.current;
      tabDeparture.current = null;
      const current = lifecycle.getSnapshot();
      departed.current =
        !document.hasFocus() &&
        current.phase === "active" &&
        gesture?.leftControl &&
        sameDepartureOwner(gesture.owner, current)
          ? gesture.owner
          : null;
    };
    const online = (event: Event) => {
      const owner = departed.current,
        current = lifecycle.getSnapshot();
      clearDeparture();
      if (
        event.type === "focus" &&
        event.target === event.currentTarget &&
        owner &&
        current.phase === "active" &&
        document.hasFocus() &&
        document.visibilityState === "visible" &&
        document.activeElement === document.body &&
        sameDepartureOwner(owner, current)
      )
        previousFocus.current = { ...owner.focus, departure: owner };
      void lifecycle.check();
    };
    const visible = () => {
      clearDeparture();
      if (document.visibilityState === "visible") void lifecycle.check();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("keyup", keyup, true);
    document.addEventListener("focusout", focusout, true);
    document.addEventListener("focusin", focusin, true);
    document.addEventListener("pointerdown", clearDeparture, true);
    window.addEventListener("blur", blur);
    window.addEventListener("online", online);
    window.addEventListener("offline", lifecycle.pause);
    window.addEventListener("focus", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      lifecycle.setNotifier(() => {});
      channel?.close();
      uninstall();
      lifecycle.dispose();
      clearDeparture();
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("keyup", keyup, true);
      document.removeEventListener("focusout", focusout, true);
      document.removeEventListener("focusin", focusin, true);
      document.removeEventListener("pointerdown", clearDeparture, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", lifecycle.pause);
      window.removeEventListener("focus", online);
      document.removeEventListener("visibilitychange", visible);
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
      saved.departure &&
      (!sameDepartureOwner(saved.departure, snapshot) ||
        !document.hasFocus() ||
        document.visibilityState !== "visible" ||
        document.activeElement !== document.body)
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
          className="mx-auto w-full max-w-lg space-y-4 p-6"
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
            {snapshot.session && (
              <Notice tone="warning" title="请重新登录">
                {
                  "\u5F53\u524D\u8F93\u5165\u4EC5\u4FDD\u7559\u5728\u6B64\u9875\u9762\u3002\u540C\u4E00\u8D26\u53F7\u767B\u5F55\u540E\u53EF\u4EE5\u7EE7\u7EED\uFF1B\u5207\u6362\u8D26\u53F7\u4F1A\u6E05\u9664\u8FD9\u4E9B\u8F93\u5165\u3002"
                }
              </Notice>
            )}
            {login({ onSuccess: lifecycle.signedIn, initialError: null })}
          </div>
        </div>
      )}
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
