import { expect, it } from "vitest";
import { reviewedPublicRoute } from "./PublicRouteEditComparison";
const route = { id: "line", name: "Line", revisionToken: "revision-one", deploymentId: "path", endpointIds: ["entry"], publicHost: "127.0.0.1", publicPort: 23457 };
it.each([undefined, null, []])("accepts a managed-only API response with absent hops: %j", hops => {
  expect(reviewedPublicRoute({ ...route, hops }, route.id)).toEqual(route);
});
it.each([false, {}, [{ kind: "managed", endpointId: "wrong" }], [{ kind: "connector", connectorId: "relay", unknown: true }]])("rejects malformed explicit hops: %j", hops => {
  expect(reviewedPublicRoute({ ...route, hops }, route.id)).toBeUndefined();
});
