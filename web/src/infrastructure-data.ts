import { list } from "./api";
import { normalizeDeployment } from "./infrastructure-model";
import type {
  Infrastructure,
  HostRecord,
  CoreInstance,
  ManagedEndpoint,
  ManagedLink,
  ServerDeployment,
} from "./types";
export const loadInfrastructure = async (): Promise<Infrastructure> => {
  const [hosts, instances, endpoints, links, deployments] = await Promise.all([
    list<HostRecord>("/hosts"),
    list<CoreInstance>("/core-instances"),
    list<ManagedEndpoint>("/managed-endpoints"),
    list<ManagedLink>("/links"),
    list<ServerDeployment>("/server-deployments"),
  ]);
  return {
    hosts,
    instances,
    endpoints,
    links,
    deployments: deployments.map(normalizeDeployment),
  };
};
export const coreName = (instance?: CoreInstance) =>
  instance?.name ||
  instance?.adapterId.replace("routeweaver/", "") ||
  "核心实例";
