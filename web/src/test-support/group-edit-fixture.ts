import type { PolicyPreview, UserGroup } from "../access-policy-model";

// An explicit coherent opening record for existing group-editor scenarios.
// Never derive the saved baseline from a later draft or decorate error responses.
export function groupEditFixture(saved: UserGroup, revision = "opened-group") {
  const opening = structuredClone(saved), precondition = { exists: true, revision };
  return {
    context: () => ({ target: { kind: "group" as const, id: opening.id }, record: { group: structuredClone(opening) }, precondition: { ...precondition } }),
    preview: (submitted: UserGroup, review: Pick<PolicyPreview, "revision" | "affected" | "blockers">) => {
      if (submitted.id !== opening.id || !review.revision || !Array.isArray(review.affected) || !Array.isArray(review.blockers)) throw new Error("Invalid guarded group-review fixture");
      return { ...review, guard: "opened-record" as const, resource: { target: { kind: "group" as const, id: opening.id }, before: { group: structuredClone(opening) },
        after: { group: { ...structuredClone(submitted), memberIds: [...new Set(submitted.memberIds ?? [])].sort() } } } };
    },
  };
}
