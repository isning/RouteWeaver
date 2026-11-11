import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "../../src/ui-patterns/providers";
import { ServerRouteEditor } from "../../src/ServerRoutes";
import { compileOrderedServerPath } from "../../src/server-path-model";
import type { Infrastructure, ServerDeployment } from "../../src/types";
import "../../src/shadcn.css";
const ids = ["hkg", "nrt", "lax"];
const names = ["香港", "东京", "洛杉矶"];
const inventory: Infrastructure = {
  hosts: ids.map((id, i) => ({
    id,
    name: `${names[i]}服务器`,
    address: "127.0.0.1",
  })),
  instances: ids.map((id) => ({
    id: `${id}-core`,
    hostId: id,
    adapterId: "routeweaver/xray",
    version: "26.10.31",
  })),
  endpoints: ids.map((id, i) => ({
    id,
    instanceId: `${id}-core`,
    name: `${names[i]}监听`,
    connection: { protocol: "socks", host: "127.0.0.1", port: 1080 + i },
  })),
  deployments: [],
  links: [],
};
const source: ServerDeployment = {
  id: "sample",
  name: "香港 → 东京 → 洛杉矶",
  status: "draft",
  diagnostics: [],
  ir: {
    id: "sample",
    schemaVersion: "1.0",
    topologyRevision: "one",
    programs: [
      {
        instance: inventory.instances[0],
        listener: inventory.endpoints[0],
        egress: [],
        rules: [],
        resources: [],
        defaultAction: { kind: "direct" },
        connectors: [],
      },
    ],
  },
};
const initial = compileOrderedServerPath(
  source,
  ids.map((endpointId) => ({ kind: "managed", endpointId })),
  inventory,
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <UIProviders>
    <QueryClientProvider client={new QueryClient()}>
      <main className="p-8">
        <h1 className="text-xl font-semibold">转发路径</h1>
      </main>
      <ServerRouteEditor
        initial={initial}
        inventory={inventory}
        isNew={false}
        onClose={() => {}}
        onSaved={() => true}
      />
    </QueryClientProvider>
  </UIProviders>,
);
