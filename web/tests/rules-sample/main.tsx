import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfileEditor } from "../../src/Profiles";
import { UIProviders } from "../../src/ui-patterns/providers";
import { emptyProfile } from "../../src/model";
import "../../src/shadcn.css";
const profile = emptyProfile();
profile.id = "rules-sample";
profile.name = "演示配置";
profile.ir.name = profile.name;
profile.ir.rules = [
  { id: "domain", match: { op: "domain-suffix", value: "example.com" }, action: { kind: "direct" } },
  { id: "network", match: { op: "ip-cidr", value: "10.0.0.0/8" }, action: { kind: "reject" } },
];
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <UIProviders><ProfileEditor initial={profile} isNew={false} onClose={() => {}} /></UIProviders>
  </QueryClientProvider>,
);
