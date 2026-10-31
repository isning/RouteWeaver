import { useState, useSyncExternalStore } from "react";
import { SessionLifecycle } from "../src/SessionLifecycle";
import { usePublicationRequest } from "../src/usePublicationRequest";
import { ServerRoutesPage } from "../src/ServerRoutes";
/** Explicit synthetic verified authority for standalone task tests, not auth evidence. */
export function VerifiedPublicationRoutes() {
  const [lifecycle] = useState(() => {
    const value = new SessionLifecycle();
    value.accept({
      user: {
        id: "test-admin",
        name: "Synthetic administrator",
        role: "admin",
      },
      csrfToken: "synthetic-test-csrf",
    });
    value.commit(value.getSnapshot().generation);
    return value;
  });
  const snapshot = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.getSnapshot,
  );
  const owner = usePublicationRequest(lifecycle, snapshot);
  return <ServerRoutesPage publicationRequests={owner} />;
}
