import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OverviewActions } from "../../src/OverviewActions";
import "../../src/shadcn.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <main className="p-6">
      <OverviewActions
        go={(hash) => {
          location.hash = hash.slice(1);
        }}
      />
    </main>
  </QueryClientProvider>,
);
