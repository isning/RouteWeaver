import { expect, it } from "vitest";
import { fixedMixedExitHops } from "./route-exit-path";
import type { PublishedRoute } from "./PublishedRoutes";
const route: PublishedRoute = {
  id: "line",
  name: "Line",
  revisionToken: "r1",
  deploymentId: "path",
  endpointIds: ["entry", "exit"],
  hops: [
    { kind: "managed", endpointId: "entry" },
    { kind: "connector", connectorId: "a" },
    { kind: "connector", connectorId: "b" },
    { kind: "managed", endpointId: "exit" },
  ],
  publicHost: "127.0.0.1",
  publicPort: 443,
  status: "draft",
  diagnostics: [],
};
it("allows only a fixed entry-owned external prefix ending at the second managed endpoint", () => {
  expect(fixedMixedExitHops(route)).toEqual(route.hops);
});
it.each([
  "tail",
  "extra-managed",
  "duplicate-connector",
  "wrong-projection",
  "missing-revision",
  "unknown-hop",
])("rejects %s", (kind) => {
  const r = structuredClone(route);
  if (kind === "tail") r.hops!.push({ kind: "connector", connectorId: "tail" });
  if (kind === "extra-managed") {
    r.hops!.splice(2, 0, { kind: "managed", endpointId: "middle" });
    r.endpointIds.splice(1, 0, "middle");
  }
  if (kind === "duplicate-connector") r.hops![2] = { ...r.hops![1] };
  if (kind === "wrong-projection") r.endpointIds.reverse();
  if (kind === "missing-revision") delete r.revisionToken;
  if (kind === "unknown-hop") Object.assign(r.hops![1], { hidden: true });
  expect(fixedMixedExitHops(r)).toBeUndefined();
});
