import { createContext, useContext, type ReactNode } from "react";
const PortalHostContext = createContext<HTMLElement | null>(null);
export function PortalHostProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PortalHostContext.Provider value={container}>
      {children}
    </PortalHostContext.Provider>
  );
}
export function usePortalHost() {
  return useContext(PortalHostContext);
}
