import type { PublishedRoute } from "./PublishedRoutes";
import { reviewedPublicRoute } from "./PublicRouteEditComparison";
type Hop = NonNullable<PublishedRoute["hops"]>[number];
export type ExitPathSummary = {
  hops: {
    kind?: "managed" | "connector";
    endpointId?: string;
    connectorId?: string;
    programEndpointId?: string;
    name?: string;
    metadataState: "snapshot" | "unavailable";
  }[];
};
/** UI shape eligibility only. The server separately proves actual forwarding. */
export function fixedMixedExitHops(route: PublishedRoute): Hop[] | undefined {
  const reviewed = reviewedPublicRoute(route, route.id);
  const hops = reviewed?.hops;
  if (
    !hops ||
    hops.length < 3 ||
    hops.length > 64 ||
    route.endpointIds.length !== 2 ||
    route.endpointIds[0] === route.endpointIds[1]
  )
    return;
  const first = hops[0],
    last = hops[hops.length - 1];
  if (
    first.kind !== "managed" ||
    last.kind !== "managed" ||
    first.endpointId !== route.endpointIds[0] ||
    last.endpointId !== route.endpointIds[1]
  )
    return;
  const ids = new Set<string>();
  for (const hop of hops.slice(1, -1)) {
    if (
      hop.kind !== "connector" ||
      !hop.connectorId ||
      ids.has(hop.connectorId)
    )
      return;
    ids.add(hop.connectorId);
  }
  return hops;
}
export function matchesExitPath(
  summary: ExitPathSummary | undefined,
  expected: Hop[],
): boolean {
  if (
    !summary ||
    !Array.isArray(summary.hops) ||
    summary.hops.length !== expected.length
  )
    return false;
  let owner = "";
  return summary.hops.every((hop, index) => {
    const target = expected[index];
    if (
      !hop ||
      hop.metadataState !== "snapshot" ||
      (hop.name !== undefined && typeof hop.name !== "string")
    )
      return false;
    if (target.kind === "managed") {
      owner = target.endpointId!;
      return (
        (!hop.kind || hop.kind === "managed") &&
        hop.endpointId === owner &&
        !hop.connectorId &&
        !hop.programEndpointId
      );
    }
    return (
      hop.kind === "connector" &&
      hop.connectorId === target.connectorId &&
      hop.programEndpointId === owner &&
      !hop.endpointId
    );
  });
}
