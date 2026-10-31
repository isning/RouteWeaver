import type { PolicyPreview } from "../access-policy-model";
import type { Service } from "../types";

// Existing service-editor scenarios explicitly opt into a coherent server read.
// The saved record/token are captured once, never derived from a later draft.
// Error and malformed-response tests keep their raw responses: this is not a
// fetch interceptor and cannot add guards to an arbitrary successful response.
export function serviceEditFixture(saved: Service, revision = "opened-service") {
  const opening = structuredClone(saved);
  const precondition = { exists: true, revision };
  return {
    context: () => ({
      target: { kind: "service" as const, id: opening.id },
      record: { service: structuredClone(opening) },
      precondition: { ...precondition },
    }),
    preview: (
      submitted: Service,
      review: Pick<PolicyPreview, "revision" | "affected" | "blockers">,
    ) => {
      if (submitted.id !== opening.id || !review.revision ||
          !Array.isArray(review.affected) || !Array.isArray(review.blockers))
        throw new Error("Invalid guarded service-review fixture");
      return {
        ...review,
        guard: "opened-record" as const,
        resource: {
          target: { kind: "service" as const, id: opening.id },
          before: { service: structuredClone(opening) },
          after: { service: structuredClone(submitted) },
        },
      };
    },
  };
}
