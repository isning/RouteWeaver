import { useEffect, useState, type ComponentProps } from "react";
import { loadPageModule } from "./PageBoundary";
import { PageSkeleton } from "./ui-patterns/loading-state";

type SubscriptionPage = (typeof import("./Subscriptions"))["SubscriptionsPage"];
type Props = ComponentProps<SubscriptionPage>;
type ModuleState =
  | { status: "pending" }
  | { status: "ready"; Page: SubscriptionPage }
  | { status: "failed"; error: unknown };

// Cache public module code only, matching lazyPage's per-document success/failure
// lifetime. Account data, query caches, props and drafts remain in the mounted page.
let moduleState: ModuleState = { status: "pending" };
let loading: Promise<void> | undefined;
function loadSubscriptions() {
  loading ??= loadPageModule(() => import("./Subscriptions")).then(
    ({ SubscriptionsPage }) => {
      moduleState = { status: "ready", Page: SubscriptionsPage };
    },
    (error: unknown) => {
      moduleState = { status: "failed", error };
    },
  );
  return loading;
}

/** This initial route owns its placeholder, without a Suspense retry commit. */
export function SubscriptionPageLoader(props: Props) {
  const [state, setState] = useState(() => moduleState);
  useEffect(() => {
    if (state.status !== "pending") return;
    let current = true;
    void loadSubscriptions().then(() => {
      if (current) setState(moduleState);
    });
    return () => {
      current = false;
    };
  }, [state.status]);
  if (state.status === "failed") throw state.error;
  if (state.status === "ready") {
    const Page = state.Page;
    return <Page {...props} />;
  }
  return (
    <PageSkeleton
      page={
        props.view === undefined || props.view === "overview"
          ? "subscriptions"
          : props.view
      }
    />
  );
}
