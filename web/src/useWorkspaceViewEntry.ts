import { useContext, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { WORKSPACE_NAVIGATION_EVENT } from "./workspace-history";
import { WorkspaceHistoryContext } from "./SubscriptionContext";

/** Local view changes already handled by a page must not reopen editors via hashchange. */
export function useWorkspaceViewEntry(
  onAcceptedNavigation?: (hash: string) => void,
) {
  const workspace = useContext(WorkspaceHistoryContext);
  const [, renewEntry] = useReducer((entry: number) => entry + 1, 0);
  const mounted = useRef(false);
  const origin = location.hash;
  // Each render owns its lease: recovery renews current actions, never old async callbacks.
  const binding = { replace: workspace?.current?.bindView(origin) };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    // A parent's layout effect installs the controller after the child's first render.
    // Rebind on effect setup as well so StrictMode does not retain a disposed controller.
    binding.replace = workspace?.current?.bindView(origin);
  }, [binding, workspace, origin]);
  useEffect(() => {
    if (!workspace) return;
    const accepted = () => {
      // Same-page navigation can leave every parent state value unchanged.
      // Render a fresh lease for NEW actions; never rebind retained callbacks.
      renewEntry();
      onAcceptedNavigation?.(location.hash);
    };
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, accepted);
    return () =>
      window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, accepted);
  }, [workspace, onAcceptedNavigation]);
  return (destination: string, complete?: () => void): boolean => {
    if (!mounted.current) return false;
    if (workspace) {
      return binding.replace?.(destination, complete) ?? false;
    } else if (
      location.hash === origin &&
      destination.split("?")[0] === origin.split("?")[0]
    ) {
      // Standalone page embeds have no workspace controller or account history lifetime.
      history.replaceState(null, "", destination);
      complete?.();
      return true;
    }
    return false;
  };
}
