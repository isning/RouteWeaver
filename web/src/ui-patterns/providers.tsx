import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmationProvider } from "./confirmations";
import { PortalHostProvider } from "./portal-host";
const NestedHostContext = createContext<((mounted: boolean) => void) | null>(
  null,
);
/** Only the innermost workspace owns live notifications, avoiding duplicate or leaked toasts. */
export function UIProviders({
  children,
  portal = null,
}: {
  children: ReactNode;
  portal?: HTMLElement | null;
}) {
  const parent = useContext(NestedHostContext);
  const [nested, setNested] = useState(0);
  const register = useCallback(
    (mounted: boolean) => setNested((count) => count + (mounted ? 1 : -1)),
    [],
  );
  useLayoutEffect(() => {
    parent?.(true);
    return () => {
      // Notifications belong to the departing account, never the next host.
      if (portal) toast.dismiss();
      parent?.(false);
    };
  }, [parent, portal]);
  return (
    <NestedHostContext.Provider value={register}>
      <PortalHostProvider container={portal}>
        <TooltipProvider>
          <ConfirmationProvider>
            {children}
            {nested === 0 && <Toaster position="bottom-right" />}
          </ConfirmationProvider>
        </TooltipProvider>
      </PortalHostProvider>
    </NestedHostContext.Provider>
  );
}
